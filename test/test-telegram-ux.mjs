// Verifies the Telegram UX fixes (index.js telegramHandler / management + screening reporting).
// [1] /close path: real executeTool("close_position") round-trip in DRY_RUN with a manual reason.
// [2] command routing mirrors: /check aliases, /closeall confirm, unknown-slash guard.
// [3] cycle-report gating mirrors (management + screening).
// [4] OOR once-per-episode (mirror of index.js collectOorAlerts — index.js is not importable).
// [5] notifyAutoSwapFailed exported, no-op without a bot token.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";
delete process.env.TELEGRAM_BOT_TOKEN;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// Mirrors of index.js
const manualCloseFailed = (res) => !res || !!res.error || !!res.blocked || res.success === false;
const CHECK_RE = /^\/(?:check|test-pnl-poll|test-emergency-exit)\s+(\d+)$/i;
const CLOSEALL_RE = /^\/closeall(\s+confirm)?$/i;
const isUnknownSlash = (text) => text.startsWith("/"); // reached only after every handler missed
const mgmtShouldReport = ({ mgmtReport, liveMessage, mgmtFailed }) => !!(mgmtReport && (liveMessage || mgmtFailed));
const screenShouldReport = ({ screenReport, deployAttempted, screenFailed }) => !!(screenReport && (deployAttempted || screenFailed));
function collectOorAlerts(positions, openSet, waitMin, notified) {
  const alerts = [];
  const seen = new Set();
  for (const p of positions) {
    seen.add(p.position);
    const open = !openSet || openSet.has(p.position);
    if (!open || p.in_range) { notified.delete(p.position); continue; }
    if (p.minutes_out_of_range >= waitMin && !notified.has(p.position)) {
      notified.add(p.position);
      alerts.push(p);
    }
  }
  for (const addr of notified) if (!seen.has(addr)) notified.delete(addr);
  return alerts;
}

try {
  const { executeTool } = await import("../tools/executor.js");

  console.log("\n[1] /close goes through executeTool");
  const res = await executeTool("close_position", {
    position_address: "TgClose11111111111111111111111111111111111",
    reason: "manual close (Telegram /close)",
  });
  check("DRY_RUN close returns a dry_run result", res?.dry_run === true, `(got ${JSON.stringify(res)})`);
  check("treated as success", manualCloseFailed(res) === false);
  check("{success:false} treated as failure", manualCloseFailed({ success: false, error: "x" }) === true);

  console.log("\n[2] command routing");
  check("/check 2 matches", CHECK_RE.exec("/check 2")?.[1] === "2");
  check("/test-pnl-poll 1 still matches (alias)", CHECK_RE.test("/test-pnl-poll 1"));
  check("/test-emergency-exit 3 still matches (alias)", CHECK_RE.test("/test-emergency-exit 3"));
  check("/check without index does not match", !CHECK_RE.test("/check"));
  check("/closeall asks for confirmation", CLOSEALL_RE.exec("/closeall")?.[1] == null);
  check("/closeall confirm executes", !!CLOSEALL_RE.exec("/closeall confirm")?.[1]);
  check("/closeall now does not match", !CLOSEALL_RE.test("/closeall now"));
  check("/stop is caught as unknown (no LLM loop)", isUnknownSlash("/stop"));
  check("free text still goes to the LLM", !isUnknownSlash("how are my positions?"));

  console.log("\n[3] cycle report gating");
  check("mgmt idle cycle (no live message) is silent", !mgmtShouldReport({ mgmtReport: "all STAY", liveMessage: null, mgmtFailed: false }));
  check("mgmt cycle with actions reports", mgmtShouldReport({ mgmtReport: "closed X", liveMessage: {}, mgmtFailed: false }));
  check("mgmt failure reports", mgmtShouldReport({ mgmtReport: "failed", liveMessage: null, mgmtFailed: true }));
  check("screening NO DEPLOY is silent", !screenShouldReport({ screenReport: "⛔ NO DEPLOY", deployAttempted: false, screenFailed: false }));
  check("screening with deploy attempt reports", screenShouldReport({ screenReport: "deployed", deployAttempted: true, screenFailed: false }));
  check("screening failure reports", screenShouldReport({ screenReport: "failed", deployAttempted: false, screenFailed: true }));

  console.log("\n[4] OOR once per episode");
  const notified = new Set();
  const oor = (pos, mins) => ({ position: pos, pair: pos, in_range: false, minutes_out_of_range: mins });
  const inR = (pos) => ({ position: pos, pair: pos, in_range: true, minutes_out_of_range: 0 });
  const open = (...a) => new Set(a);
  check("below wait → no alert", collectOorAlerts([oor("A", 10)], open("A"), 30, notified).length === 0);
  check("past wait → alert once", collectOorAlerts([oor("A", 35)], open("A"), 30, notified).length === 1);
  check("next cycle still OOR → no repeat", collectOorAlerts([oor("A", 45)], open("A"), 30, notified).length === 0);
  collectOorAlerts([inR("A")], open("A"), 30, notified);
  check("back in range → re-armed", !notified.has("A"));
  check("new OOR episode → alerts again", collectOorAlerts([oor("A", 31)], open("A"), 30, notified).length === 1);
  check("closed this cycle → no alert", collectOorAlerts([oor("B", 60)], open(), 30, notified).length === 0);
  check("closed position pruned", !notified.has("B"));
  collectOorAlerts([], open(), 30, notified);
  check("positions gone → set pruned", notified.size === 0);
  check("openSet unknown (fetch failed) → assume open", collectOorAlerts([oor("C", 40)], null, 30, notified).length === 1);

  console.log("\n[5] auto-swap failure alert");
  const tg = await import("../telegram.js");
  check("notifyAutoSwapFailed exported", typeof tg.notifyAutoSwapFailed === "function");
  let threw = false;
  try { await tg.notifyAutoSwapFailed({ pair: "X-SOL", mint: "Mint1111", error: "slippage <exceeded>" }); } catch { threw = true; }
  check("no-op without bot token (does not throw)", !threw);

  console.log("\n[5b] no duplicate Deployed message during screening");
  // Separate process: telegram.js reads the bot token at import time, and this process already
  // imported it without one. fetch is stubbed, so nothing leaves the machine.
  const { execFileSync } = await import("child_process");
  const probe = `
    let sends = 0;
    globalThis.fetch = async () => { sends++; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }), text: async () => "" }; };
    const tg = await import(${JSON.stringify(new URL("../telegram.js", import.meta.url).href)});
    const d = { pair: "X-SOL", amountSol: 1, position: "Pos1111", tx: "Tx1111" };
    tg.setDeployNotifyMuted(true);  await tg.notifyDeploy(d); const muted = sends;
    tg.setDeployNotifyMuted(false); await tg.notifyDeploy(d); const unmuted = sends - muted;
    console.log(JSON.stringify({ muted, unmuted }));`;
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_CHAT_ID: "1", DRY_RUN: "true" },
    encoding: "utf8",
  }).trim().split("\n").pop());
  check("muted notifyDeploy sends nothing", out.muted === 0, `(got ${out.muted})`);
  check("unmuted notifyDeploy sends once", out.unmuted === 1, `(got ${out.unmuted})`);

  console.log("\n[5c] close notifications survive raw rule reasons, 400s and network drops");
  // Stubbed fetch replays a script of responses: "ok" | "400" | "throw". Records every body sent.
  const runProbe = (script, body) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const plan = ${JSON.stringify(script)}; const sent = [];
    globalThis.fetch = async (url, opts) => {
      const step = plan.shift() ?? "ok";
      sent.push(JSON.parse(opts.body));
      if (step === "throw") throw new Error("fetch failed");
      if (step === "400") return { ok: false, status: 400, text: async () => "can't parse entities", json: async () => ({}) };
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }), text: async () => "" };
    };
    const tg = await import(${JSON.stringify(new URL("../telegram.js", import.meta.url).href)});
    ${body}
    console.log(JSON.stringify(sent.filter((b) => b.text !== undefined)));
    process.exit(0); // a live message typing timer would keep the process alive`], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_CHAT_ID: "1", DRY_RUN: "true" },
    encoding: "utf8",
    timeout: 30_000,
  }).trim().split("\n").pop());
  const closeCall = `await tg.notifyClose({ pair: "EL63-SOL", pnlUsd: -1, pnlPct: -9.98, reason: "Stop loss: PnL -11.21% <= -10.2% [per-position]" });`;

  const esc = runProbe(["ok"], closeCall);
  check("raw '<=' reason is escaped in the HTML body", esc.length === 1 && esc[0].parse_mode === "HTML" && esc[0].text.includes("&lt;= -10.2%") && !esc[0].text.includes("<= -10.2%"), `(got ${JSON.stringify(esc)})`);

  const fb = runProbe(["400", "ok"], closeCall);
  check("HTML 400 → one plain-text resend", fb.length === 2 && fb[1].parse_mode === undefined && fb[1].text.includes("<= -10.2%") && !fb[1].text.includes("<b>"), `(got ${JSON.stringify(fb)})`);

  const net = runProbe(["throw", "ok"], closeCall);
  check("network drop → retried and delivered", net.length === 2 && net[1].parse_mode === "HTML", `(got ${net.length} sends)`);

  const muted = runProbe([], `tg.setCloseNotifyMuted(true); ${closeCall} tg.setCloseNotifyMuted(false);`);
  check("close muted during management report → no send", muted.length === 0);

  const chat = runProbe([], `await tg.createLiveMessage("🤖 Live Update", "chat"); ${closeCall}`);
  check("chat live message open → close still notified", chat.some((b) => String(b.text).includes("Closed")), `(got ${JSON.stringify(chat.map((b) => b.text))})`);

  console.log("\n[6] mirrors match index.js source");
  const fs = await import("fs");
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("/check regex identical", src.includes(CHECK_RE.source.replace(/\//g, "\\/")) || src.includes("/^\\/(?:check|test-pnl-poll|test-emergency-exit)\\s+(\\d+)$/i"));
  check("/closeall regex identical", src.includes("/^\\/closeall(\\s+confirm)?$/i"));
  check("collectOorAlerts body identical", src.includes(collectOorAlerts.toString()));
  check("management gating identical", src.includes("if (mgmtReport && (liveMessage || mgmtFailed))"));
  check("screening gating identical", src.includes("if (screenReport && (deployAttempted || screenFailed))"));
  check("unknown-slash guard present", src.includes('if (text.startsWith("/")) {'));
  check("/close no longer calls closePosition() directly", !/await closePosition\(/.test(src));
  const muteAt = src.indexOf("setDeployNotifyMuted(true)");
  const screenerLoopAt = src.indexOf("SCREENING CYCLE", muteAt);
  check("deploy notify muted right before the screener agentLoop", muteAt > 0 && screenerLoopAt > muteAt && screenerLoopAt - muteAt < 300);
  check("deploy notify unmuted in screening finally", /\} finally \{\n\s+setDeployNotifyMuted\(false\);/.test(src));
  check("close notify muted only with the management live message", src.includes("if (liveMessage) setCloseNotifyMuted(true);"));
  check("close notify unmuted in management finally", /_managementBusy = false;\n\s+if \(liveMessage\) setCloseNotifyMuted\(false\);/.test(src));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
