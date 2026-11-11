// Verifies how the HTML report is sent (telegram.js sendDocument, index.js sendReportFile /
// handleReportCommand / runBriefing). No network: globalThis.fetch is replaced by a recorder.
//   [1] sendDocument: multipart body, caption, retries (network drop, 400 caption, 5xx)
//   [2] sendReportFile: briefing / viz, live positions missing, upload failure and error reply
//   [3] /viz and /briefing: file only vs text + file, shared 30s cooldown
//   [4] morning briefing: the text decides "sent today"; a failed file never unsets it
// Backs up + restores state.json, lessons.json and decision-log.json.
process.env.DRY_RUN = "true";
process.env.TELEGRAM_BOT_TOKEN = "test-token-123";
process.env.TELEGRAM_CHAT_ID = "424242";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

const FILES = ["./state.json", "./lessons.json", "./decision-log.json"];
const backups = FILES.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// ── fetch recorder ──
let calls = [];
let script = () => ({ status: 200, json: { ok: true, result: { message_id: 1 } } }); // (method, callIndex) → response or throw
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
globalThis.fetch = async (url, init = {}) => {
  const method = String(url).split("/").pop();
  const rec = { method, url: String(url), init, index: calls.filter((c) => c.method === method).length };
  if (init.body instanceof FormData) {
    rec.form = init.body;
    const doc = init.body.get("document");
    if (doc && typeof doc === "object") { rec.docName = doc.name; rec.docType = doc.type; rec.docText = await doc.text(); }
  } else if (typeof init.body === "string") {
    try { rec.json = JSON.parse(init.body); } catch { /* not json */ }
  }
  calls.push(rec);
  const r = script(method, rec.index);
  if (r instanceof Error) throw r;
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.json ?? {}), json: async () => r.json ?? {} };
};
const docs = () => calls.filter((c) => c.method === "sendDocument");
const msgs = () => calls.filter((c) => c.method === "sendMessage");
const reset = (fn) => { calls = []; script = fn || (() => ({ status: 200, json: { ok: true, result: { message_id: 1 } } })); };

try {
  const now = Date.now();
  fs.writeFileSync("./state.json", JSON.stringify({ positions: {
    P9: { position: "P9", pool_name: "NINE-SOL", strategy: "curve", deployed_at: new Date(now - 3600e3).toISOString(), closed: false, peak_pnl_pct: 1.2, sl_pct_override: -12 },
  } }));
  fs.writeFileSync("./lessons.json", JSON.stringify({
    lessons: [{ rule: "WARN: NINE-SOL dumped IN-RANGE → PnL -9%", outcome: "bad", pnl_pct: -9, created_at: new Date(now - 3600e3).toISOString() }],
    performance: [{ pool_name: "NINE-SOL", recorded_at: new Date(now - 1800e3).toISOString(), pnl_usd: 3, pnl_pct: 2, close_reason: "Rule 5: low yield", fees_earned_usd: 1 }],
  }));
  fs.writeFileSync("./decision-log.json", JSON.stringify({ decisions: [] }));

  const T = await import("../telegram.js");
  const I = await import("../index.js");
  const { getLastBriefingDate } = await import("../state.js");

  // ─────────────────────────────────────────────────────────────
  console.log("\n[1] sendDocument");
  reset();
  const ok = await T.sendDocument("<html>hi</html>", "r.html", "📊 <b>Meridian</b>");
  check("returns Telegram's JSON", ok?.ok === true);
  check("posts to sendDocument once", calls.length === 1 && calls[0].url.endsWith("/sendDocument") && calls[0].init.method === "POST");
  check("multipart FormData with chat_id from config", calls[0].form instanceof FormData && calls[0].form.get("chat_id") === "424242");
  check("file part: name, html content type, exact content", calls[0].docName === "r.html" && /^text\/html/.test(calls[0].docType) && calls[0].docText === "<html>hi</html>");
  check("caption sent with parse_mode HTML", calls[0].form.get("caption") === "📊 <b>Meridian</b>" && calls[0].form.get("parse_mode") === "HTML");
  reset();
  await T.sendDocument("x", "r.html");
  check("no caption → no caption / parse_mode fields", calls[0].form.get("caption") === null && calls[0].form.get("parse_mode") === null);
  reset();
  await T.sendDocument("x", "r.html", "y".repeat(2000));
  check("caption capped at Telegram's 1024 chars", calls[0].form.get("caption").length === 1024);

  // network drops are retried (delays collapsed to 0 so the test is fast)
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  reset((m, i) => (i < 2 ? new Error("fetch failed") : { status: 200, json: { ok: true } }));
  const retried = await T.sendDocument("x", "r.html", "c");
  check("2 network drops then success → delivered on the 3rd try, with a fresh body each time", retried?.ok === true && docs().length === 3 && docs().every((c) => c.docText === "x" && c.form.get("chat_id") === "424242"));
  reset(() => new Error("fetch failed"));
  const gaveUp = await T.sendDocument("x", "r.html");
  check("persistent network failure → null after 3 attempts (1 + 2 retries)", gaveUp === null && docs().length === 3, `${docs().length}`);
  reset(() => ({ status: 500, json: { ok: false } }));
  const five = await T.sendDocument("x", "r.html", "c");
  check("HTTP 500 → null, not retried", five === null && docs().length === 1);
  reset((m, i) => (i === 0 ? { status: 400, json: { ok: false, description: "can't parse entities" } } : { status: 200, json: { ok: true } }));
  const plain = await T.sendDocument("x", "r.html", "📊 <b>Meridian</b> · 13 Okt");
  check("400 on the caption → resent once as plain text without parse_mode", plain?.ok === true && docs().length === 2 && docs()[1].form.get("parse_mode") === null && docs()[1].form.get("caption") === "📊 Meridian · 13 Okt", docs()[1]?.form.get("caption"));
  reset(() => ({ status: 400, json: { ok: false } }));
  check("400 again → null (no loop)", (await T.sendDocument("x", "r.html", "c")) === null && docs().length === 2);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[2] sendReportFile");
  reset();
  const good = await I.sendReportFile("briefing", { getPositions: async () => ({ positions: [], total_positions: 0 }) });
  check("briefing: one document named meridian-briefing-<date>.html", good === true && docs().length === 1 && /^meridian-briefing-\d{4}-\d\d-\d\d\.html$/.test(docs()[0].docName), docs()[0]?.docName);
  check("briefing: fixed short caption, no message sent", docs()[0].form.get("caption").startsWith("Laporan lengkap") && msgs().length === 0);
  check("report content comes from the data files", docs()[0].docText.includes("NINE-SOL") && docs()[0].docText.includes("Meridian · briefing pagi"));
  check("empty live list (no error) → 'Tidak ada posisi terbuka'-style cards, no 'live unavailable' notice", !docs()[0].docText.includes("Data posisi live tidak tersedia"));
  reset();
  await I.sendReportFile("viz", { getPositions: async () => { throw new Error("rpc down"); } });
  check("viz: positions call throws → still sent, with the 'live unavailable' notice", docs().length === 1 && docs()[0].docText.includes("Data posisi live tidak tersedia") && /^meridian-viz-/.test(docs()[0].docName));
  check("viz: caption has the 24h numbers", /24 jam: \+\$3\.00 · 1 close · win 100%/.test(docs()[0].form.get("caption")), docs()[0].form.get("caption"));
  reset();
  await I.sendReportFile("viz", { getPositions: async () => ({ positions: [], error: "timeout" }) });
  check("positions result with .error → treated as unavailable", docs()[0].docText.includes("Data posisi live tidak tersedia"));
  reset((m) => (m === "sendDocument" ? { status: 500, json: { ok: false } } : { status: 200, json: { ok: true } }));
  const failQuiet = await I.sendReportFile("briefing", { getPositions: async () => ({ positions: [] }) });
  check("upload failure → false, no chat message when replyOnError is off", failQuiet === false && msgs().length === 0);
  reset((m) => (m === "sendDocument" ? { status: 500, json: { ok: false } } : { status: 200, json: { ok: true } }));
  const failLoud = await I.sendReportFile("viz", { replyOnError: true, getPositions: async () => ({ positions: [] }) });
  check("upload failure + replyOnError → one message with the reason", failLoud === false && msgs().length === 1 && /Gagal mengirim file laporan/.test(msgs()[0].json.text), msgs()[0]?.json?.text);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[3] /viz and /briefing");
  check("cooldown is 0 before any command", I.reportCooldownLeftMs() === 0);
  reset();
  await I.handleReportCommand("viz", { getPositions: async () => ({ positions: [] }) });
  check("/viz: exactly one document and no text message", docs().length === 1 && msgs().length === 0 && /^meridian-viz-/.test(docs()[0].docName));
  check("/viz: caption present, parse_mode HTML", docs()[0].form.get("caption")?.includes("<b>Meridian</b>") && docs()[0].form.get("parse_mode") === "HTML");
  const left = I.reportCooldownLeftMs();
  check("cooldown started (about 30s)", left > 25_000 && left <= 30_000, String(left));
  reset();
  const throttled = await I.handleReportCommand("briefing", { getPositions: async () => ({ positions: [] }) });
  check("/briefing right after /viz is throttled (shared cooldown): a 'Tunggu N detik' message, no file", throttled === false && docs().length === 0 && msgs().length === 1 && /Tunggu \d+ detik/.test(msgs()[0].json.text), msgs()[0]?.json?.text);
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000; // 31 seconds later
  check("cooldown over after 31s", I.reportCooldownLeftMs() === 0);
  reset();
  // _reportLastAt is real time, so with the shifted clock the command is allowed again
  await I.handleReportCommand("briefing", { getPositions: async () => ({ positions: [] }) });
  Date.now = realNow;
  check("/briefing: text message first (the shortened briefing), then the file", msgs().length === 1 && docs().length === 1 && /Morning Briefing/.test(msgs()[0].json.text) && calls.indexOf(msgs()[0]) < calls.indexOf(docs()[0]));
  check("/briefing text carries the condensed Lessons block", /<b>Lessons:<\/b> 1 new \(1 WARN\)/.test(msgs()[0].json.text), msgs()[0].json.text);
  check("/briefing: file uses the briefing mode", docs()[0].docText.includes("Meridian · briefing pagi") && /^meridian-briefing-/.test(docs()[0].docName));

  // ─────────────────────────────────────────────────────────────
  console.log("\n[4] morning briefing (runBriefing)");
  const stateWithDate = (d) => { const s = JSON.parse(fs.readFileSync("./state.json", "utf8")); if (d === null) delete s._lastBriefingDate; else s._lastBriefingDate = d; fs.writeFileSync("./state.json", JSON.stringify(s)); };
  stateWithDate(null);
  reset();
  await I.runBriefing();
  check("text, then file", msgs().length === 1 && docs().length === 1 && calls.indexOf(msgs()[0]) < calls.indexOf(docs()[0]));
  check("date stamped after the text", getLastBriefingDate() === new Date().toISOString().slice(0, 10), String(getLastBriefingDate()));

  stateWithDate(null);
  reset((m) => (m === "sendDocument" ? { status: 500, json: { ok: false } } : { status: 200, json: { ok: true } }));
  await I.runBriefing();
  check("file upload fails → date is still stamped (the watchdog must not resend the text)", getLastBriefingDate() === new Date().toISOString().slice(0, 10) && msgs().length === 1);
  check("file upload fails → nothing is sent to the chat about it (log only)", msgs().every((c) => !/Gagal/.test(c.json?.text ?? "")));

  stateWithDate(null);
  reset((m) => (m === "sendMessage" ? { status: 500, json: { ok: false } } : { status: 200, json: { ok: true } }));
  await I.runBriefing();
  check("text fails → date NOT stamped (watchdog retries) and no file is sent", getLastBriefingDate() == null && docs().length === 0, String(getLastBriefingDate()));
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  FILES.forEach((f, i) => { if (backups[i]) fs.writeFileSync(f, backups[i]); else fs.rmSync(f, { force: true }); });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
