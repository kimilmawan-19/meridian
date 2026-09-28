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
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
