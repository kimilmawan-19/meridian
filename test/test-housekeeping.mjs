// Verifies the dead-weight cleanup:
//   - state.json drops closed positions older than 7 days on save (was 8.7 MB, re-read many
//     times per 30s poll); open and recently closed positions are kept (briefing reads last 24h).
//   - daily log files older than LOG_RETENTION_DAYS (90) are deleted; logs/ had reached 463 MB.
//   - the hourly LLM health check (never ran: management always held _managementBusy at :00) is gone.
// Real module imports; backs up + restores state.json.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

const STATE_FILE = "./state.json";
const stateBackup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

try {
  console.log("\n[1] state.json prunes old closed positions on save");
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    positions: {
      OldClosed: { position: "OldClosed", closed: true, closed_at: daysAgo(10) },
      RecentClosed: { position: "RecentClosed", closed: true, closed_at: daysAgo(1) },
      OldOpen: { position: "OldOpen", closed: false, deployed_at: daysAgo(30) },
      ClosedNoDate: { position: "ClosedNoDate", closed: true, closed_at: null },
    },
    recentEvents: [],
  }));
  const state = await import("../state.js");
  state.trackPosition({
    position: "NewPos", pool: "Pool-New", pool_name: "NEW-SOL", strategy: "curve",
    bin_range: { min: 1, max: 2 }, amount_sol: 1, active_bin: 1, bin_step: 100,
    volatility: 2, fee_tvl_ratio: 1, organic_score: 70, initial_value_usd: 100,
  });
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).positions;
  check("closed > 7 days ago is removed", !("OldClosed" in saved));
  check("closed 1 day ago is kept (briefing)", "RecentClosed" in saved);
  check("open position is kept regardless of age", "OldOpen" in saved);
  check("closed without closed_at is kept", "ClosedNoDate" in saved);
  check("new position saved", "NewPos" in saved);

  console.log("\n[2] old daily log files are deleted");
  const { pruneOldLogs } = await import("../logger.js");
  const oldA = "logs/agent-2000-01-01.log", oldB = "logs/actions-2000-01-01.jsonl";
  const today = new Date().toISOString().slice(0, 10);
  const keep = `logs/agent-${today}.log`, other = "logs/notes-2000-01-01.txt";
  for (const f of [oldA, oldB, other]) fs.writeFileSync(f, "x\n");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
  pruneOldLogs();
  check("agent-/actions- files older than retention are removed", !fs.existsSync(oldA) && !fs.existsSync(oldB));
  check("today's log is kept", fs.existsSync(keep));
  check("unrelated files are untouched", fs.existsSync(other));
  fs.unlinkSync(other);

  console.log("\n[3] dead code removed (drift)");
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("no hourly LLM health check cron", !index.includes("healthTask") && !index.includes("HEALTH CHECK"));
  check("backups/ directory removed", !fs.existsSync(new URL("../backups", import.meta.url)));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else { try { fs.unlinkSync(STATE_FILE); } catch (_) { /* ignore */ } }
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
