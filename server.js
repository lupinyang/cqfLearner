const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(ROOT, "public");
const STUDY_PLAN_PATH = path.join(PUBLIC_DIR, "study-plan.json");
const MODULES_PATH = path.join(PUBLIC_DIR, "modules.json");

loadEnv();

const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8787",
  trustProxy: String(process.env.TRUST_PROXY || "true").toLowerCase() === "true",
  allowedHosts: normalizeList(process.env.ALLOWED_HOSTS || ""),
  zhipuApiKey: process.env.ZHIPU_API_KEY || "",
  zhipuModel: process.env.ZHIPU_MODEL || "glm-4.7-flash",
  zhipuApiUrl:
    process.env.ZHIPU_API_URL ||
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuReceiveId: process.env.FEISHU_RECEIVE_ID || "",
  feishuReceiveIdType: process.env.FEISHU_RECEIVE_ID_TYPE || "open_id",
  reminderHour: Number(process.env.REMINDER_HOUR || 22),
  reminderMinute: Number(process.env.REMINDER_MINUTE || 0),
};

const modules = require(MODULES_PATH);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let reminderSentKey = "";

async function main() {
  await ensureStore();
  const server = http.createServer(handleRequest);
  server.listen(config.port, config.host, () => {
    console.log(`CQF Lexicon running at http://${config.host}:${config.port}`);
  });
  setInterval(runReminderCheck, 60 * 1000);
}

async function handleRequest(req, res) {
  try {
    if (!isAllowedHost(req)) {
      return sendJson(res, { error: "Host is not allowed." }, 403);
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if ((url.pathname === "/healthz" || url.pathname === "/api/health") && req.method === "GET") {
      return sendJson(res, {
        ok: true,
        app: "cqf-lexicon",
        publicBaseUrl: config.publicBaseUrl,
        receivedHost: getForwardedHost(req),
        protocol: getForwardedProto(req),
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/modules" && req.method === "GET") {
      return sendJson(res, { modules });
    }

    if (url.pathname === "/api/study-plan" && req.method === "GET") {
      const store = await readStore();
      const plan = JSON.parse(await fs.readFile(STUDY_PLAN_PATH, "utf8"));
      return sendJson(res, {
        ...plan,
        completedDays: store.studyPlan.completedDays,
      });
    }

    if (url.pathname.match(/^\/api\/study-plan\/\d{4}-\d{2}-\d{2}$/) && req.method === "POST") {
      const date = decodeURIComponent(url.pathname.split("/")[3]);
      const body = await readJsonBody(req);
      const completed = Boolean(body.completed);
      const store = await readStore();
      store.studyPlan.completedDays[date] = completed;
      await writeStore(store);
      return sendJson(res, { date, completed });
    }

    if (url.pathname === "/api/vocab" && req.method === "GET") {
      const store = await readStore();
      const todayOnly = url.searchParams.get("due") === "today";
      const query = (url.searchParams.get("q") || "").toLowerCase();
      const moduleId = url.searchParams.get("module") || "";
      let items = store.vocabulary;
      if (todayOnly) items = items.filter((item) => isDue(item.nextReviewAt));
      if (query) {
        items = items.filter(
          (item) =>
            item.word.toLowerCase().includes(query) ||
            item.tags.join(" ").toLowerCase().includes(query)
        );
      }
      if (moduleId) items = items.filter((item) => item.moduleId === moduleId);
      items.sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt));
      return sendJson(res, { items, stats: buildStats(store) });
    }

    if (url.pathname === "/api/vocab" && req.method === "POST") {
      const body = await readJsonBody(req);
      const word = normalizeWord(body.word);
      const moduleId = String(body.moduleId || "");
      const tags = normalizeTags(body.tags || "");
      const module = modules.find((item) => item.id === moduleId);
      if (!word || !module) {
        return sendJson(res, { error: "Word and valid module are required." }, 400);
      }

      const store = await readStore();
      const existing = store.vocabulary.find(
        (item) => item.word.toLowerCase() === word.toLowerCase()
      );
      if (existing) {
        return sendJson(res, { error: "This word already exists.", item: existing }, 409);
      }

      let ai;
      try {
        ai = await generateExplanation(word, module, tags);
      } catch (error) {
        return sendJson(res, { error: explainGenerationError(error) }, 502);
      }
      const now = new Date().toISOString();
      const item = {
        id: crypto.randomUUID(),
        word,
        moduleId,
        tags,
        ai,
        familiarity: 0,
        reviewCount: 0,
        mistakeCount: 0,
        streakKnown: 0,
        nextReviewAt: dateOnly(now),
        createdAt: now,
        updatedAt: now,
      };
      store.vocabulary.push(item);
      await writeStore(store);
      return sendJson(res, { item });
    }

    if (url.pathname.match(/^\/api\/vocab\/[^/]+\/review$/) && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      const body = await readJsonBody(req);
      const result = String(body.result || "");
      if (!["known", "vague", "unknown"].includes(result)) {
        return sendJson(res, { error: "Invalid review result." }, 400);
      }

      const store = await readStore();
      const item = store.vocabulary.find((entry) => entry.id === id);
      if (!item) return sendJson(res, { error: "Word not found." }, 404);

      applyReview(item, result);
      store.reviewLog.push({
        id: crypto.randomUUID(),
        vocabularyId: item.id,
        result,
        reviewedAt: new Date().toISOString(),
      });
      await writeStore(store);
      return sendJson(res, { item, stats: buildStats(store) });
    }

    if (url.pathname.match(/^\/api\/vocab\/[^/]+\/regenerate$/) && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      const store = await readStore();
      const item = store.vocabulary.find((entry) => entry.id === id);
      if (!item) return sendJson(res, { error: "Word not found." }, 404);
      const module = modules.find((entry) => entry.id === item.moduleId);
      if (!module) return sendJson(res, { error: "Module not found." }, 400);

      try {
        item.ai = await generateExplanation(item.word, module, item.tags);
      } catch (error) {
        return sendJson(res, { error: explainGenerationError(error) }, 502);
      }
      item.updatedAt = new Date().toISOString();
      await writeStore(store);
      return sendJson(res, { item, stats: buildStats(store) });
    }

    if (url.pathname === "/api/vocab/regenerate-placeholders" && req.method === "POST") {
      const store = await readStore();
      const targets = store.vocabulary.filter((item) => isPlaceholderExplanation(item));
      for (const item of targets) {
        const module = modules.find((entry) => entry.id === item.moduleId);
        if (!module) continue;
        try {
          item.ai = await generateExplanation(item.word, module, item.tags);
        } catch (error) {
          return sendJson(res, { error: explainGenerationError(error) }, 502);
        }
        item.updatedAt = new Date().toISOString();
      }
      await writeStore(store);
      return sendJson(res, {
        updated: targets.length,
        items: store.vocabulary,
        stats: buildStats(store),
      });
    }

    if (url.pathname === "/api/reminder/test" && req.method === "POST") {
      const result = await sendDueReminder(true);
      return sendJson(res, result);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, { error: "Internal server error." }, 500);
  }
}

async function serveStatic(urlPath, res) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, "Forbidden", 403);
  }
  try {
    const data = await fs.readFile(filePath);
    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    sendText(res, "Not found", 404);
  }
}

async function generateExplanation(word, module, tags) {
  if (!config.zhipuApiKey) return fallbackExplanation(word, module, tags);

  const prompt = [
    "你是一个 CQF 金融工程学习助手。",
    "用户会输入一个英文金融工程或数量金融词汇，以及它所属的 CQF 官方模块。",
    "请结合 CQF 学习语境，生成适合复习的详细解释。",
    "必须输出严格 JSON，不要 Markdown，不要额外文本。",
    "JSON 字段必须为：chineseExplanation, englishExplanation, cqfContext, englishExample, exampleTranslation, relatedConcepts, confusingTerms, memoryHint。",
    "relatedConcepts 和 confusingTerms 必须是字符串数组。",
    "中文解释要详细但不要冗长，贴近 quantitative finance、衍生品、风险、固定收益或机器学习语境。",
    "数学符号尽量使用 Unicode 或简洁表达；如必须写公式，可使用 $...$ 包裹简单行内公式，不要输出 Markdown 公式块。",
  ].join("\n");

  const response = await fetch(config.zhipuApiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.zhipuApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.zhipuModel,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({
            word,
            module: `${module.name}: ${module.title}`,
            moduleTopics: module.topics,
            userTags: tags,
          }),
        },
      ],
    }),
  });

  const responseText = await response.text();
  const data = parseJsonResponse(responseText, "Zhipu API");
  if (!response.ok) {
    throw new Error(`Zhipu request failed: ${response.status} ${extractApiError(data)}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Zhipu response did not include content.");
  return sanitizeAiJson(parseModelJson(content));
}

function fallbackExplanation(word, module, tags) {
  return {
    chineseExplanation: `${word} 是一个需要放在 ${module.title} 语境中理解的 CQF 术语。第一版本地模式会先保存词条；配置智谱 API Key 后，系统会自动生成更精确的中文解释。`,
    englishExplanation: `${word} is a CQF vocabulary item connected to ${module.title}.`,
    cqfContext: `在 ${module.name} 中，这个词应结合 ${module.topics} 来复习。你可以先用标签 ${tags.join(", ") || "none"} 标注个人理解难点。`,
    englishExample: `In ${module.title}, ${word} appears in quantitative finance discussions and model interpretation.`,
    exampleTranslation: `在 ${module.title} 中，${word} 会出现在数量金融讨论和模型解释里。`,
    relatedConcepts: module.topics.split(", ").slice(0, 5),
    confusingTerms: [],
    memoryHint: "配置智谱 API Key 后，这里会变成针对该词的记忆提示。",
  };
}

function isPlaceholderExplanation(item) {
  const text = [
    item.ai?.chineseExplanation,
    item.ai?.memoryHint,
    item.ai?.cqfContext,
  ].join(" ");
  return (
    text.includes("配置智谱 API Key") ||
    text.includes("第一版本地模式") ||
    text.includes("Zhipu API Key")
  );
}

function explainGenerationError(error) {
  const message = String(error?.message || error);
  if (message.includes("EACCES") || message.includes("fetch failed")) {
    return "无法连接智谱 API。请确认当前运行环境可以访问外网 HTTPS，并且 ZHIPU_API_KEY 已配置。";
  }
  if (message.includes("Model JSON parse failed")) {
    return "智谱返回的内容不是有效 JSON。请重新点击生成；如果持续出现，请降低模型温度或检查模型名称。";
  }
  if (message.includes("Zhipu API returned non-JSON")) {
    return "智谱 API 返回了非 JSON 响应。请检查智谱服务状态、API Key 和模型名称。";
  }
  return message;
}

function parseJsonResponse(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    const preview = String(text || "").slice(0, 180);
    throw new Error(`${source} returned non-JSON response: ${preview}`);
  }
}

function parseModelJson(content) {
  if (typeof content === "object" && content !== null) return content;
  const raw = String(content || "").trim();
  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? withoutFence.slice(start, end + 1) : withoutFence;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Model JSON parse failed: ${String(error?.message || error)}; content=${candidate.slice(0, 180)}`);
  }
}

function extractApiError(data) {
  return (
    data?.error?.message ||
    data?.msg ||
    data?.message ||
    JSON.stringify(data).slice(0, 240)
  );
}

function sanitizeAiJson(value) {
  return {
    chineseExplanation: String(value.chineseExplanation || ""),
    englishExplanation: String(value.englishExplanation || ""),
    cqfContext: String(value.cqfContext || ""),
    englishExample: String(value.englishExample || ""),
    exampleTranslation: String(value.exampleTranslation || ""),
    relatedConcepts: Array.isArray(value.relatedConcepts) ? value.relatedConcepts.map(String) : [],
    confusingTerms: Array.isArray(value.confusingTerms) ? value.confusingTerms.map(String) : [],
    memoryHint: String(value.memoryHint || ""),
  };
}

function applyReview(item, result) {
  const now = new Date();
  item.reviewCount += 1;
  item.updatedAt = now.toISOString();

  if (result === "known") {
    item.streakKnown += 1;
    item.familiarity = Math.min(5, item.familiarity + 1);
    const days = item.streakKnown >= 5 ? 30 : item.streakKnown >= 3 ? 7 : 3;
    item.nextReviewAt = addDays(now, days);
  }

  if (result === "vague") {
    item.streakKnown = 0;
    item.familiarity = Math.max(1, item.familiarity);
    item.nextReviewAt = addDays(now, 1);
  }

  if (result === "unknown") {
    item.streakKnown = 0;
    item.mistakeCount += 1;
    item.familiarity = Math.max(0, item.familiarity - 1);
    item.nextReviewAt = addDays(now, 1);
  }
}

function buildStats(store) {
  const due = store.vocabulary.filter((item) => isDue(item.nextReviewAt)).length;
  const mastered = store.vocabulary.filter((item) => item.familiarity >= 4).length;
  const difficult = store.vocabulary.filter((item) => item.mistakeCount >= 2).length;
  return {
    total: store.vocabulary.length,
    due,
    mastered,
    difficult,
    reviewed: store.reviewLog.length,
  };
}

async function runReminderCheck() {
  const now = new Date();
  if (now.getHours() !== config.reminderHour || now.getMinutes() !== config.reminderMinute) {
    return;
  }
  const key = dateOnly(now.toISOString());
  if (reminderSentKey === key) return;
  reminderSentKey = key;
  await sendDueReminder(false);
}

async function sendDueReminder(force) {
  const store = await readStore();
  const due = store.vocabulary.filter((item) => isDue(item.nextReviewAt));
  if (!force && due.length === 0) {
    return { sent: false, reason: "No due words." };
  }

  const text = due.length
    ? `今晚有 ${due.length} 个 CQF 词汇待复习。打开 ${config.publicBaseUrl} 开始今日复习。`
    : `CQF Lexicon 测试提醒：当前没有待复习词汇。`;

  if (!config.feishuAppId || !config.feishuAppSecret || !config.feishuReceiveId) {
    console.log(`[Reminder dry-run] ${text}`);
    return { sent: false, dryRun: true, text };
  }

  const token = await getTenantAccessToken();
  const messageResponse = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(
      config.feishuReceiveIdType
    )}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: config.feishuReceiveId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    }
  );

  const body = await messageResponse.json();
  if (!messageResponse.ok || body.code !== 0) {
    throw new Error(`Feishu message failed: ${JSON.stringify(body)}`);
  }

  return { sent: true, text, response: body };
}

async function getTenantAccessToken() {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config.feishuAppId,
        app_secret: config.feishuAppSecret,
      }),
    }
  );
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`Feishu token failed: ${JSON.stringify(data)}`);
  }
  return data.tenant_access_token;
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    await writeStore(defaultStore());
  }
}

async function readStore() {
  const raw = await fs.readFile(STORE_PATH, "utf8");
  const store = JSON.parse(raw);
  if (!store.vocabulary) store.vocabulary = [];
  if (!store.reviewLog) store.reviewLog = [];
  if (!store.studyPlan) store.studyPlan = { completedDays: {} };
  if (!store.studyPlan.completedDays) store.studyPlan.completedDays = {};
  return store;
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function loadEnv() {
  try {
    const raw = require("node:fs").readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // Local development can run without a .env file.
  }
}

function normalizeWord(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedHost(req) {
  if (!config.allowedHosts.length) return true;
  const host = getForwardedHost(req).toLowerCase();
  return config.allowedHosts.includes(host);
}

function getForwardedHost(req) {
  if (config.trustProxy && req.headers["x-forwarded-host"]) {
    return String(req.headers["x-forwarded-host"]).split(",")[0].trim();
  }
  return String(req.headers.host || "");
}

function getForwardedProto(req) {
  if (config.trustProxy && req.headers["x-forwarded-proto"]) {
    return String(req.headers["x-forwarded-proto"]).split(",")[0].trim();
  }
  return "http";
}

function isDue(value) {
  return value <= dateOnly(new Date().toISOString());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return dateOnly(next.toISOString());
}

function dateOnly(value) {
  return value.slice(0, 10);
}

function defaultStore() {
  return {
    vocabulary: [],
    reviewLog: [],
    studyPlan: {
      completedDays: {},
    },
  };
}

main();
