// Runtime verification for the morning-briefing bug fixes:
//   #1 runBriefing only stamps the date when the send actually succeeds (retry-safe)
//   #2 briefing escapes dynamic HTML so token symbols with &/</> can't break parse_mode=HTML
//   #3 sendHTML splits >4096 messages on newline boundaries instead of truncating mid-tag
//
// No network: TELEGRAM_BOT_TOKEN is set (telegramEnabled()=true) but TELEGRAM_CHAT_ID is unset
// (sendHTML()→null), which exercises the send-failure branch without hitting the Telegram API.
// Backs up state.json + lessons.json and restores them afterwards.

// MUST run before importing telegram.js / index.js — TOKEN/chatId are read from env at import.
process.env.DRY_RUN = "true";
process.env.TELEGRAM_BOT_TOKEN = "test-token-123";
delete process.env.TELEGRAM_CHAT_ID;
// index.js → agent.js instantiates an OpenAI client at import time (no API call). Provide a
// dummy key so the import succeeds in a bare test environment.
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// ── Backup ──
const stateBackup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null;
const lessonsBackup = fs.existsSync(LESSONS_FILE) ? fs.readFileSync(LESSONS_FILE) : null;

const yesterdayUtc = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const todayUtc = new Date().toISOString().slice(0, 10);

try {
  // ─────────────────────────────────────────────────────────────
  console.log("\n[1] briefing escapes dynamic HTML (Bug #2)");
  // Seed a lesson created within the last 24h whose rule contains HTML-unsafe chars.
  const nowIso = new Date().toISOString();
  fs.writeFileSync(LESSONS_FILE, JSON.stringify({
    lessons: [{ rule: "Tok<e>n & raisins <b>boom</b>", created_at: nowIso }],
    performance: [],
  }, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions: {}, recentEvents: [] }, null, 2));

  const { generateBriefing } = await import("../briefing.js");
  const out = await generateBriefing();
  check("dynamic '<e>' escaped → &lt;e&gt;", out.includes("&lt;e&gt;"), out.slice(0, 0));
  check("dynamic '&' escaped → &amp;", out.includes("& raisins".replace("&", "&amp;")));
  check("injected <b>boom</b> escaped", out.includes("&lt;b&gt;boom&lt;/b&gt;"));
  check("template tag <b>Morning Briefing</b> intact", out.includes("<b>Morning Briefing</b>"));
  check("no raw injected '<e>' remains", !out.includes("Tok<e>n"));

  // ─────────────────────────────────────────────────────────────
  console.log("\n[2] splitForTelegram (Bug #2 / long messages)");
  const { splitForTelegram } = await import("../telegram.js");
  const short = "hello\nworld";
  const sChunks = splitForTelegram(short, 4096);
  check("short string → 1 chunk equal to input", sChunks.length === 1 && sChunks[0] === short);

  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(`• <b>AGGREGATE</b> line ${i} ${"x".repeat(120)}`);
  const longMsg = lines.join("\n");
  const chunks = splitForTelegram(longMsg, 4096);
  check("long multiline → multiple chunks", chunks.length > 1, `got ${chunks.length}`);
  check("every chunk ≤ 4096", chunks.every(c => c.length <= 4096));
  check("no chunk ends mid-tag", chunks.every(c => !/<b?$|<$/.test(c)));
  check("rejoined chunks === original", chunks.join("\n") === longMsg);

  const oneBigLine = "y".repeat(9000);
  const bigChunks = splitForTelegram(oneBigLine, 4096);
  check("single >4096 line hard-sliced ≤4096", bigChunks.every(c => c.length <= 4096) && bigChunks.length === 3);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[3] sendHTML failure semantics (precondition for Bug #1)");
  const { isEnabled, sendHTML } = await import("../telegram.js");
  check("telegramEnabled() true (TOKEN set)", isEnabled() === true);
  const sendResult = await sendHTML("hi");
  check("sendHTML returns null when chatId missing", sendResult === null, `got ${JSON.stringify(sendResult)}`);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[4] runBriefing does NOT stamp date when send fails (Bug #1)");
  // Seed _lastBriefingDate = yesterday so we can detect an erroneous stamp to today.
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    positions: {}, recentEvents: [], _lastBriefingDate: yesterdayUtc,
  }, null, 2));

  const { runBriefing } = await import("../index.js");
  const { getLastBriefingDate } = await import("../state.js");
  check("precondition: lastBriefingDate = yesterday", getLastBriefingDate() === yesterdayUtc);

  await runBriefing(); // telegramEnabled() true, sendHTML→null → must NOT stamp
  const afterDate = getLastBriefingDate();
  check("date NOT stamped to today after failed send", afterDate === yesterdayUtc,
    `got ${afterDate} (expected ${yesterdayUtc}, bug would set ${todayUtc})`);

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  // ── Restore ──
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (lessonsBackup) fs.writeFileSync(LESSONS_FILE, lessonsBackup);
  else if (fs.existsSync(LESSONS_FILE)) fs.unlinkSync(LESSONS_FILE);
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
