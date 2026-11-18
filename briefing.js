import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
const DAY_MS = 24 * 60 * 60 * 1000;

// The Lessons block used to print every lesson of the last 24h in full (110–240 chars each, no cap).
// Per-close lessons are written for closes with PnL >= +5% or < -5%, and AGGREGATE lessons (strategy ×
// bin_step statistics) are recomputed every 20 closes with a fresh created_at, so they showed up as
// "new" almost every day. The text now carries a count and a few examples; the full list is in the
// HTML report (report-html.js).
const LESSON_EXAMPLE_COUNT = 2;
const LESSON_EXAMPLE_MAX_CHARS = 90;

export function isAggregateLesson(lesson) {
  return Array.isArray(lesson?.tags) && lesson.tags.includes("aggregate");
}

/** Short label for a lesson: the rule's own prefix (WARN, AVOID, WORKED, ...) or its source. */
export function lessonType(lesson) {
  if (isAggregateLesson(lesson)) return "AGGREGATE";
  if (Array.isArray(lesson?.tags) && lesson.tags.includes("evolution")) return "EVOLVED";
  if (lesson?.sourceType === "manual") return "MANUAL";
  const m = /^([A-Z]{3,10}):/.exec(String(lesson?.rule ?? ""));
  return m ? m[1] : "NOTE";
}

/** Cut at a word boundary so a number or token is never split in half. */
export function truncateText(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Operator-written and auto-evolved lessons are rare and always shown first; the rest are ranked by
// the size of the PnL that produced them.
function lessonWeight(lesson) {
  const type = lessonType(lesson);
  if (type === "MANUAL" || type === "EVOLVED") return Infinity;
  const pct = Number(lesson?.pnl_pct);
  return Number.isFinite(pct) ? Math.abs(pct) : 0;
}

/**
 * Everything the morning briefing (text) and the HTML report need for the last 24h, computed once
 * so both always show the same numbers.
 */
export function collectBriefingStats(now = Date.now(), data = null) {
  // `data` lets the HTML report pass the files it already read, so they are parsed once per report.
  const state = data?.state ?? loadJson(STATE_FILE) ?? { positions: {}, recentEvents: [] };
  const lessonsData = data?.lessonsData ?? loadJson(LESSONS_FILE) ?? { lessons: [], performance: [] };
  const since = now - DAY_MS;

  const allPositions = Object.values(state.positions || {});
  const opened = allPositions.filter((p) => Date.parse(p.deployed_at) > since).length;
  const closed = allPositions.filter((p) => p.closed && Date.parse(p.closed_at) > since).length;
  const openCount = allPositions.filter((p) => !p.closed).length;

  const perf = (lessonsData.performance || []).filter((p) => Date.parse(p.recorded_at) > since);
  const net = perf.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const fees = perf.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);
  const wins = perf.filter((p) => p.pnl_usd > 0).length;

  const fresh = (lessonsData.lessons || []).filter((l) => Date.parse(l.created_at) > since);
  return {
    now,
    opened,
    closed,
    openCount,
    perfCount: perf.length,
    net,
    fees,
    wins,
    winRatePct: perf.length > 0 ? Math.round((wins / perf.length) * 100) : null,
    learned: fresh.filter((l) => !isAggregateLesson(l)),
    aggregateRefreshed: fresh.filter(isAggregateLesson).length,
  };
}

function lessonLines(learned) {
  if (!learned.length) return ["<b>Lessons:</b> none new overnight."];
  const counts = new Map();
  for (const l of learned) counts.set(lessonType(l), (counts.get(lessonType(l)) || 0) + 1);
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([type, n]) => `${n} ${type}`).join(", ");
  const examples = [...learned]
    .sort((a, b) => lessonWeight(b) - lessonWeight(a))
    .slice(0, LESSON_EXAMPLE_COUNT)
    .map((l) => `• ${escapeHtml(truncateText(l.rule, LESSON_EXAMPLE_MAX_CHARS))}`);
  return [`<b>Lessons:</b> ${learned.length} new (${escapeHtml(parts)})`, ...examples, "Full list: HTML report (/viz)"];
}

export async function generateBriefing(now = Date.now(), data = null) {
  const s = collectBriefingStats(now, data);
  const perfSummary = getPerformanceSummary();

  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${s.opened}`,
    `📤 Positions Closed: ${s.closed}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${s.net >= 0 ? "+" : ""}$${s.net.toFixed(2)}`,
    `💎 Fees Earned: $${s.fees.toFixed(2)}`,
    s.winRatePct != null ? `📈 Win Rate (24h): ${s.winRatePct}%` : "📈 Win Rate (24h): N/A",
    "",
    ...lessonLines(s.learned),
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${s.openCount}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}

// Escape dynamic content (token symbols / narratives) before inserting into an HTML message.
// Telegram parse_mode=HTML rejects the WHOLE message (HTTP 400) on a stray &, <, or >.
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
