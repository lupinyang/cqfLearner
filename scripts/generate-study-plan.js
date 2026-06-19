const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const sourcePath = path.join(root, "..", "..", "CQF_Daily_Study_Plan.md");
const outputPath = path.join(root, "public", "study-plan.json");

const source = fs.readFileSync(sourcePath, "utf8");
const lines = source.split(/\r?\n/);

const plan = {
  title: "CQF Daily Study Plan",
  intro: [],
  weeks: [],
  days: [],
};

let currentWeek = null;
let currentDay = null;
let section = "intro";

function finishDay() {
  if (!currentDay) return;
  currentDay.files = currentDay.files.filter(Boolean);
  currentDay.knowledge = currentDay.knowledge.filter(Boolean);
  currentDay.checklist = currentDay.checklist.filter(Boolean);
  currentDay.masteryQuestions = currentDay.masteryQuestions.filter(Boolean);
  plan.days.push(currentDay);
  if (currentWeek) currentWeek.days.push(currentDay.id);
  currentDay = null;
}

for (const rawLine of lines) {
  const line = rawLine.trimEnd();
  const weekMatch = line.match(/^# Week (\d+):\s*(.+)$/);
  if (weekMatch) {
    finishDay();
    currentWeek = {
      id: `week-${weekMatch[1]}`,
      number: Number(weekMatch[1]),
      title: weekMatch[2].trim(),
      goal: "",
      days: [],
    };
    plan.weeks.push(currentWeek);
    section = "week";
    continue;
  }

  const dayMatch = line.match(/^## Day (\d+) - (\d{4}-\d{2}-\d{2})$/);
  if (dayMatch) {
    finishDay();
    currentDay = {
      id: `day-${dayMatch[1]}`,
      number: Number(dayMatch[1]),
      date: dayMatch[2],
      weekId: currentWeek ? currentWeek.id : "",
      files: [],
      knowledge: [],
      checklist: [],
      masteryQuestions: [],
    };
    section = "";
    continue;
  }

  if (!currentDay && currentWeek && line.startsWith("Goal:")) {
    currentWeek.goal = line.replace(/^Goal:\s*/, "").trim();
    continue;
  }

  if (!currentDay) {
    if (line && !line.startsWith("#")) plan.intro.push(line);
    continue;
  }

  if (line === "- Files:") {
    section = "files";
    continue;
  }
  if (line === "- Knowledge:") {
    section = "knowledge";
    continue;
  }
  if (line === "- Checklist:") {
    section = "checklist";
    continue;
  }
  if (line === "- Mastery questions:") {
    section = "masteryQuestions";
    continue;
  }

  const bullet = line.match(/^\s*-\s+(.*)$/);
  if (bullet && section && currentDay[section]) {
    currentDay[section].push(cleanMarkdown(bullet[1]));
    continue;
  }

  const checkbox = line.match(/^\s*-\s+\[[ x]\]\s+(.*)$/i);
  if (checkbox && section === "checklist") {
    currentDay.checklist.push(cleanMarkdown(checkbox[1]));
    continue;
  }

  const question = line.match(/^\s*\d+\.\s+(.*)$/);
  if (question && section === "masteryQuestions") {
    currentDay.masteryQuestions.push(cleanMarkdown(question[1]));
  }
}

finishDay();

fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
console.log(`Generated ${plan.days.length} study-plan days at ${outputPath}`);

function cleanMarkdown(value) {
  return value.replace(/^- \[[ x]\]\s+/i, "").trim();
}
