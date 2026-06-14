const state = {
  modules: [],
  items: [],
  dueItems: [],
  stats: { total: 0, due: 0, mastered: 0, difficult: 0, reviewed: 0 },
  studyPlan: null,
  view: "review",
};

const titles = {
  review: "今日复习",
  plan: "CQF学习计划",
  add: "添加词汇",
  library: "词汇库",
  stats: "统计",
};

const moduleTitle = (id) => {
  const module = state.modules.find((item) => item.id === id);
  return module ? `${module.name}: ${module.title}` : id;
};

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await loadModules();
  await refreshAll();
});

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.getElementById("refresh-button").addEventListener("click", refreshAll);
  document.getElementById("search-input").addEventListener("input", loadLibrary);
  document.getElementById("filter-module").addEventListener("change", loadLibrary);
  document.getElementById("add-form").addEventListener("submit", addWord);
  document.getElementById("test-reminder-button").addEventListener("click", testReminder);
  document.getElementById("today-plan-button").addEventListener("click", scrollToTodayPlan);
  document.getElementById("refresh-ai-button").addEventListener("click", regeneratePlaceholders);
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${view}-view`);
  });
  document.getElementById("view-title").textContent = titles[view];
  if (view === "library") loadLibrary();
  if (view === "plan") loadStudyPlan();
}

async function loadModules() {
  const data = await api("/api/modules");
  state.modules = data.modules;
  const moduleSelect = document.getElementById("module-select");
  const filterModule = document.getElementById("filter-module");

  moduleSelect.innerHTML = state.modules
    .map((module) => `<option value="${module.id}">${module.name}: ${module.title}</option>`)
    .join("");

  filterModule.innerHTML =
    `<option value="">全部模块</option>` +
    state.modules
      .map((module) => `<option value="${module.id}">${module.name}: ${module.title}</option>`)
      .join("");
}

async function refreshAll() {
  await Promise.all([loadDue(), loadLibrary()]);
  if (state.view === "plan") await loadStudyPlan();
  renderStats();
}

async function loadStudyPlan() {
  try {
    const data = await api("/api/study-plan");
    data.storageMode = "server";
    state.studyPlan = data;
  } catch {
    const response = await fetch("/study-plan.json");
    const data = await response.json();
    data.completedDays = loadLocalPlanCompletion();
    data.storageMode = "local";
    state.studyPlan = data;
  }
  renderStudyPlan();
}

async function loadDue() {
  const data = await api("/api/vocab?due=today");
  state.dueItems = data.items;
  state.stats = data.stats;
  renderReviewList();
}

async function loadLibrary() {
  const q = encodeURIComponent(document.getElementById("search-input").value.trim());
  const module = encodeURIComponent(document.getElementById("filter-module").value);
  const data = await api(`/api/vocab?q=${q}&module=${module}`);
  state.items = data.items;
  state.stats = data.stats;
  renderLibraryList();
  renderStats();
}

async function addWord(event) {
  event.preventDefault();
  const status = document.getElementById("add-status");
  const button = document.getElementById("add-button");
  const form = event.currentTarget;
  const payload = {
    word: form.word.value,
    moduleId: form.moduleId.value,
    tags: form.tags.value,
  };

  status.textContent = "正在生成 CQF 语境解释...";
  button.disabled = true;

  try {
    await api("/api/vocab", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    form.reset();
    status.textContent = "已保存。这个词会出现在今日复习里。";
    await refreshAll();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function reviewWord(id, result) {
  await api(`/api/vocab/${encodeURIComponent(id)}/review`, {
    method: "POST",
    body: JSON.stringify({ result }),
  });
  await refreshAll();
}

async function regenerateWord(id) {
  const button = document.querySelector(`[data-regenerate="${id}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "生成中...";
  }
  try {
    await api(`/api/vocab/${encodeURIComponent(id)}/regenerate`, {
      method: "POST",
    });
    await refreshAll();
  } catch (error) {
    const status = document.getElementById("library-status");
    if (status) status.textContent = error.message;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "重新生成解释";
    }
  }
}

async function regeneratePlaceholders() {
  const status = document.getElementById("library-status");
  const button = document.getElementById("refresh-ai-button");
  status.textContent = "正在用智谱刷新占位解释...";
  button.disabled = true;
  try {
    const result = await api("/api/vocab/regenerate-placeholders", {
      method: "POST",
    });
    status.textContent = result.updated
      ? `已刷新 ${result.updated} 个词条。`
      : "没有发现需要刷新的占位解释。";
    await refreshAll();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function testReminder() {
  const status = document.getElementById("reminder-status");
  status.textContent = "正在发送测试提醒...";
  try {
    const result = await api("/api/reminder/test", { method: "POST" });
    status.textContent = result.dryRun
      ? `未配置飞书密钥，已完成本地演练：${result.text}`
      : "测试提醒已发送。";
  } catch (error) {
    status.textContent = error.message;
  }
}

async function toggleStudyDay(date, completed) {
  if (state.studyPlan.storageMode === "server") {
    await api(`/api/study-plan/${date}`, {
      method: "POST",
      body: JSON.stringify({ completed }),
    });
  }
  state.studyPlan.completedDays[date] = completed;
  if (state.studyPlan.storageMode === "local") {
    saveLocalPlanCompletion(state.studyPlan.completedDays);
  }
  renderStudyPlanDates();
  document.querySelectorAll(`[data-plan-date="${date}"]`).forEach((input) => {
    input.checked = completed;
  });
  const day = document.getElementById(`plan-${date}`);
  if (day) day.classList.toggle("completed", completed);
}

function renderReviewList() {
  const list = document.getElementById("review-list");
  if (!state.dueItems.length) {
    list.innerHTML = `<div class="empty">今天没有待复习词汇。添加一个新词后，它会立刻出现在这里。</div>`;
    return;
  }
  list.innerHTML = state.dueItems.map((item) => wordCard(item, true)).join("");
  bindReviewButtons(list);
}

function renderLibraryList() {
  const list = document.getElementById("library-list");
  if (!state.items.length) {
    list.innerHTML = `<div class="empty">词汇库暂时为空。</div>`;
    return;
  }
  list.innerHTML = state.items.map((item) => wordCard(item, false)).join("");
  bindReviewButtons(list);
}

function renderStats() {
  document.getElementById("due-count").textContent = state.stats.due;
  document.getElementById("total-count").textContent = state.stats.total;
  document.getElementById("mastered-count").textContent = state.stats.mastered;
  document.getElementById("reviewed-count").textContent = state.stats.reviewed;
  document.getElementById("difficult-count").textContent = state.stats.difficult;
  const rate = state.stats.total
    ? Math.round((state.stats.mastered / state.stats.total) * 100)
    : 0;
  document.getElementById("mastery-rate").textContent = `${rate}%`;
}

function renderStudyPlan() {
  renderStudyPlanDates();
  const list = document.getElementById("study-plan-list");
  const weeks = state.studyPlan.weeks
    .map((week) => {
      const days = state.studyPlan.days.filter((day) => day.weekId === week.id);
      return `
        <section class="study-week">
          <header class="week-header">
            <h3>Week ${week.number}: ${escapeHtml(week.title)}</h3>
            <p>${escapeHtml(week.goal)}</p>
          </header>
          ${days.map(studyDayCard).join("")}
        </section>
      `;
    })
    .join("");
  list.innerHTML = weeks;
  bindStudyPlanInputs(list);
}

function renderStudyPlanDates() {
  const strip = document.getElementById("plan-date-strip");
  if (!state.studyPlan) return;
  strip.innerHTML = state.studyPlan.days
    .map((day) => {
      const completed = Boolean(state.studyPlan.completedDays[day.date]);
      return `
        <label class="date-check ${completed ? "done" : ""}" title="Day ${day.number}">
          <input type="checkbox" data-plan-date="${day.date}" ${completed ? "checked" : ""} />
          <button type="button" data-scroll-date="${day.date}">
            <span>Day ${day.number}</span>
            <strong>${day.date}</strong>
          </button>
        </label>
      `;
    })
    .join("");
  bindStudyPlanInputs(strip);
}

function studyDayCard(day) {
  const completed = Boolean(state.studyPlan.completedDays[day.date]);
  return `
    <article id="plan-${day.date}" class="study-day ${completed ? "completed" : ""}">
      <header class="study-day-header">
        <div>
          <p>Day ${day.number}</p>
          <h4>${escapeHtml(day.date)}</h4>
        </div>
        <label class="complete-toggle">
          <input type="checkbox" data-plan-date="${day.date}" ${completed ? "checked" : ""} />
          <span>已完成</span>
        </label>
      </header>
      ${studyList("Files", day.files)}
      ${studyList("Knowledge", day.knowledge)}
      ${studyList("Checklist", day.checklist)}
      ${studyList("Mastery questions", day.masteryQuestions)}
    </article>
  `;
}

function studyList(title, items) {
  if (!items.length) return "";
  return `
    <div class="study-section">
      <h5>${escapeHtml(title)}</h5>
      <ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>
    </div>
  `;
}

function bindStudyPlanInputs(root) {
  root.querySelectorAll("[data-plan-date]").forEach((input) => {
    input.addEventListener("change", () => toggleStudyDay(input.dataset.planDate, input.checked));
  });
  root.querySelectorAll("[data-scroll-date]").forEach((button) => {
    button.addEventListener("click", () => scrollToStudyDay(button.dataset.scrollDate));
  });
}

function scrollToTodayPlan() {
  const today = new Date().toISOString().slice(0, 10);
  const hasToday = state.studyPlan?.days.some((day) => day.date === today);
  if (hasToday) {
    scrollToStudyDay(today);
    return;
  }
  const firstOpen = state.studyPlan?.days.find((day) => !state.studyPlan.completedDays[day.date]);
  if (firstOpen) scrollToStudyDay(firstOpen.date);
}

function scrollToStudyDay(date) {
  const target = document.getElementById(`plan-${date}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add("focus-pulse");
  window.setTimeout(() => target.classList.remove("focus-pulse"), 1200);
}

function bindReviewButtons(root) {
  root.querySelectorAll("[data-review]").forEach((button) => {
    button.addEventListener("click", () => reviewWord(button.dataset.id, button.dataset.review));
  });
  root.querySelectorAll("[data-regenerate]").forEach((button) => {
    button.addEventListener("click", () => regenerateWord(button.dataset.regenerate));
  });
}

function wordCard(item, withActions) {
  const ai = item.ai;
  const tags = item.tags.length
    ? item.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")
    : `<span class="tag">未打标签</span>`;
  const related = ai.relatedConcepts.length ? ai.relatedConcepts.join(", ") : "暂无";
  const confusing = ai.confusingTerms.length ? ai.confusingTerms.join(", ") : "暂无";

  return `
    <article class="word-card">
      <header class="word-header">
        <div>
          <h3 class="word-title">${escapeHtml(item.word)}</h3>
          <div class="module-label">${escapeHtml(moduleTitle(item.moduleId))}</div>
        </div>
        <div class="tags">${tags}</div>
      </header>
      <div class="word-body">
        <p><strong>中文解释：</strong>${formatRichText(ai.chineseExplanation)}</p>
        <p><strong>CQF 语境：</strong>${formatRichText(ai.cqfContext)}</p>
        <p><strong>英文解释：</strong>${formatRichText(ai.englishExplanation)}</p>
        <p><strong>例句：</strong>${formatRichText(ai.englishExample)}</p>
        <p><strong>翻译：</strong>${formatRichText(ai.exampleTranslation)}</p>
        <p><strong>相关概念：</strong>${formatRichText(related)}</p>
        <p><strong>易混淆：</strong>${formatRichText(confusing)}</p>
        <p><strong>记忆提示：</strong>${formatRichText(ai.memoryHint)}</p>
        <p><strong>下次复习：</strong>${escapeHtml(item.nextReviewAt)}</p>
      </div>
      ${
        withActions
          ? ""
          : ""
      }
      <div class="review-actions">
        ${
          withActions
            ? `<button class="review-button known" data-id="${item.id}" data-review="known">认识</button>
              <button class="review-button vague" data-id="${item.id}" data-review="vague">模糊</button>
              <button class="review-button unknown" data-id="${item.id}" data-review="unknown">不认识</button>`
            : ""
        }
        <button class="secondary-button compact" data-regenerate="${item.id}" type="button">重新生成解释</button>
      </div>
    </article>
  `;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inlineMarkdown(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function formatRichText(value) {
  const escaped = escapeHtml(value);
  return escaped.replace(/\$([^$]+)\$/g, (_, expression) => {
    return `<span class="math-inline">${formatMathExpression(expression)}</span>`;
  });
}

function formatMathExpression(expression) {
  return expression
    .replace(/\\sigma/g, "σ")
    .replace(/\\mu/g, "μ")
    .replace(/\\Delta/g, "Δ")
    .replace(/\\sqrt/g, "√")
    .replace(/\\cdot/g, "·")
    .replace(/\\times/g, "×")
    .replace(/\\leq/g, "≤")
    .replace(/\\geq/g, "≥")
    .replace(/\\neq/g, "≠")
    .replace(/\\infty/g, "∞")
    .replace(/\\mathbb\{R\}/g, "ℝ")
    .replace(/\^\{([^}]+)\}/g, (_, text) => toSuperscript(text))
    .replace(/\^([A-Za-z0-9+\-]+)/g, (_, text) => toSuperscript(text))
    .replace(/_\{([^}]+)\}/g, (_, text) => toSubscript(text))
    .replace(/_([A-Za-z0-9+\-]+)/g, (_, text) => toSubscript(text))
    .replace(/\\/g, "");
}

function toSuperscript(value) {
  const map = {
    0: "⁰",
    1: "¹",
    2: "²",
    3: "³",
    4: "⁴",
    5: "⁵",
    6: "⁶",
    7: "⁷",
    8: "⁸",
    9: "⁹",
    "+": "⁺",
    "-": "⁻",
    n: "ⁿ",
    t: "ᵗ",
  };
  return String(value)
    .split("")
    .map((char) => map[char] || char)
    .join("");
}

function toSubscript(value) {
  const map = {
    0: "₀",
    1: "₁",
    2: "₂",
    3: "₃",
    4: "₄",
    5: "₅",
    6: "₆",
    7: "₇",
    8: "₈",
    9: "₉",
    "+": "₊",
    "-": "₋",
    a: "ₐ",
    e: "ₑ",
    h: "ₕ",
    i: "ᵢ",
    j: "ⱼ",
    k: "ₖ",
    m: "ₘ",
    n: "ₙ",
    o: "ₒ",
    p: "ₚ",
    r: "ᵣ",
    s: "ₛ",
    t: "ₜ",
    u: "ᵤ",
    v: "ᵥ",
    x: "ₓ",
  };
  return String(value)
    .split("")
    .map((char) => map[char] || char)
    .join("");
}

function loadLocalPlanCompletion() {
  try {
    return JSON.parse(localStorage.getItem("cqf-study-plan-completed") || "{}");
  } catch {
    return {};
  }
}

function saveLocalPlanCompletion(completedDays) {
  localStorage.setItem("cqf-study-plan-completed", JSON.stringify(completedDays));
}
