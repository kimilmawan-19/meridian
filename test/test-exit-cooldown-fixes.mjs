// Runtime verification for two bug fixes:
//   Bug A — pool-memory cooldowns never shorten (setBaseMintCooldown / setPoolCooldown keep max)
//   Bug B — trailing-TP 15s recheck reuses the trigger's effective drop (not a divergent recompute)
//
// Loads the REAL modules and exercises the code paths. Backs up + restores state.json,
// lessons.json, and pool-memory.json.
process.env.DRY_RUN = "true";

import fs from "fs";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
const POOLMEM_FILE = "./pool-memory.json";
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const backups = {};
for (const f of [STATE_FILE, LESSONS_FILE, POOLMEM_FILE]) {
  backups[f] = fs.existsSync(f) ? fs.readFileSync(f) : null;
}

try {
  const state = await import("../state.js");
  const poolMem = await import("../pool-memory.js");
  const { config } = await import("../config.js");

  // ─────────────────────────────────────────────────────────────
  console.log("\n[A] base-mint cooldown never shortens (Bug A)");
  // Fresh pool-memory.
  fs.writeFileSync(POOLMEM_FILE, JSON.stringify({}, null, 2));
  const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  // First close: a severe in-range dump on a bid_ask position → long cooldown (severity≥20 ×
  // bidAskMult, capped 72h). Conditions: range_eff > inRangeDumpCooldownRangeEff, pnl ≤ lossPct,
  // close_reason matches /stop.?loss/.
  poolMem.recordPoolDeploy("PoolAAA111", {
    pool_name: "DUMP-SOL", base_mint: MINT, deployed_at: new Date(Date.now() - 3600_000).toISOString(),
    closed_at: new Date().toISOString(), pnl_pct: -22.9, pnl_usd: -45, range_efficiency: 99,
    minutes_held: 60, close_reason: "stop loss", strategy: "bid_ask", volatility: 5,
  });
  check("severe dump put mint on cooldown", poolMem.isBaseMintOnCooldown(MINT) === true);

  // Capture the long expiry from pool-memory.json.
  const dbAfterSevere = JSON.parse(fs.readFileSync(POOLMEM_FILE, "utf8"));
  const severeUntil = Object.values(dbAfterSevere).find(e => e.base_mint === MINT)?.base_mint_cooldown_until;
  check("severe cooldown expiry recorded", !!severeUntil, severeUntil || "(none)");
  const severeMs = new Date(severeUntil).getTime();
  const severeHours = (severeMs - Date.now()) / 3600_000;
  check("severe cooldown is long (≥ 40h)", severeHours >= 40, `got ~${severeHours.toFixed(1)}h`);

  // Second close on the SAME mint (different pool) with only a minor cooldown trigger:
  // a low-yield close cools the pool 4h, but emergency/repeat paths could set the mint short.
  // Force a short mint cooldown via a repeated-OOR-style close set: emulate emergency exit (4h).
  poolMem.recordPoolDeploy("PoolBBB222", {
    pool_name: "DUMP-SOL", base_mint: MINT, deployed_at: new Date(Date.now() - 1800_000).toISOString(),
    closed_at: new Date().toISOString(), pnl_pct: -3, pnl_usd: -5, range_efficiency: 20,
    minutes_held: 30, close_reason: "rapid dump", strategy: "curve", volatility: 2,
  });
  const dbAfterMinor = JSON.parse(fs.readFileSync(POOLMEM_FILE, "utf8"));
  const afterMinorUntil = Object.values(dbAfterMinor).find(e => e.base_mint === MINT && e.base_mint_cooldown_until)?.base_mint_cooldown_until;
  const afterMinorMs = new Date(afterMinorUntil).getTime();
  check("mint cooldown NOT shortened by later minor close", afterMinorMs >= severeMs,
    `severe=${new Date(severeMs).toISOString()} after=${afterMinorUntil}`);

  // setPoolCooldown never-shorten: directly exercise via two low-yield closes on one pool.
  // (low yield = 4h pool cooldown; a longer existing one must win.)
  // Simulate by writing a far-future pool cooldown then a short trigger.
  const dbManual = JSON.parse(fs.readFileSync(POOLMEM_FILE, "utf8"));
  const longPoolUntil = new Date(Date.now() + 50 * 3600_000).toISOString();
  dbManual["PoolAAA111"].cooldown_until = longPoolUntil;
  fs.writeFileSync(POOLMEM_FILE, JSON.stringify(dbManual, null, 2));
  poolMem.recordPoolDeploy("PoolAAA111", {
    pool_name: "DUMP-SOL", base_mint: MINT, deployed_at: new Date(Date.now() - 600_000).toISOString(),
    closed_at: new Date().toISOString(), pnl_pct: 0.5, pnl_usd: 0.5, range_efficiency: 50,
    minutes_held: 10, close_reason: "low yield", strategy: "curve", volatility: 2,
  });
  const dbAfterPool = JSON.parse(fs.readFileSync(POOLMEM_FILE, "utf8"));
  const poolUntilAfter = new Date(dbAfterPool["PoolAAA111"].cooldown_until).getTime();
  check("pool cooldown NOT shortened by later low-yield (4h)", poolUntilAfter >= new Date(longPoolUntil).getTime(),
    `before=${longPoolUntil} after=${dbAfterPool["PoolAAA111"].cooldown_until}`);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[B] trailing recheck reuses trigger effective drop (Bug B)");
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions: {}, recentEvents: [] }, null, 2));
  const POS = "TrailPos1111111111111111111111111111111111111";
  state.trackPosition({
    position: POS, pool: "PoolT1", pool_name: "TRAIL-SOL", strategy: "curve",
    bin_range: { min: 100, max: 200 }, amount_sol: 1, active_bin: 150,
    bin_step: 100, volatility: 2, fee_tvl_ratio: 2, organic_score: 80, initial_value_usd: 200,
  });

  // Queue with an explicit effective drop of 3.0 (e.g. stale-peak widened), distinct from base
  // trailingDropPct (default 1.5). Peak 10 → current 6.8 → dropFromPeak 3.2 ≥ 3.0 → queued.
  const queued = state.queueTrailingDropConfirmation(POS, 10, 6.8, 3.0);
  check("queue accepts when drop ≥ effective", queued === true);
  const qpos = state.getTrackedPosition(POS);
  check("stored effective drop = 3.0", qpos.pending_trailing_effective_drop_pct === 3.0,
    `got ${qpos.pending_trailing_effective_drop_pct}`);

  // Resolve with current=7.4 → drop from peak = 2.6. Base trailingDropPct (1.5) would CONFIRM,
  // but the trigger's effective drop (3.0) must REJECT (2.6 < 3.0). Pass base 1.5 as the
  // fallback arg to prove the stored effective value wins.
  const resolved = state.resolvePendingTrailingDrop(POS, 7.4, 1.5);
  check("recheck REJECTS using trigger effective drop (not loose base)", resolved.confirmed === false,
    JSON.stringify(resolved));
  const rpos = state.getTrackedPosition(POS);
  check("pending effective-drop field cleared after resolve", rpos.pending_trailing_effective_drop_pct == null);

  // Positive case: same effective drop, current=6.5 → drop 3.5 ≥ 3.0 AND still near crash → CONFIRM.
  state.queueTrailingDropConfirmation(POS, 10, 6.6, 3.0);
  const resolved2 = state.resolvePendingTrailingDrop(POS, 6.5, 1.5);
  check("recheck CONFIRMS when drop ≥ effective and still crashed", resolved2.confirmed === true,
    JSON.stringify(resolved2));

  // Fallback: a position queued before the patch (no pending_trailing_effective_drop_pct) uses
  // the old max(trailingDropPct, peak/3) formula.
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  st.positions[POS].pending_trailing_peak_pnl_pct = 9;
  st.positions[POS].pending_trailing_current_pnl_pct = 5.5;
  st.positions[POS].pending_trailing_drop_pct = 3.5;
  delete st.positions[POS].pending_trailing_effective_drop_pct; // simulate legacy
  st.positions[POS].confirmed_trailing_exit_reason = null;
  st.positions[POS].confirmed_trailing_exit_until = null;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  // peak/3 = 3.0; current=5.5 → drop 3.5 ≥ 3.0 → confirm via fallback.
  const resolved3 = state.resolvePendingTrailingDrop(POS, 5.5, 1.5);
  check("legacy fallback still works (no stored effective)", resolved3.confirmed === true,
    JSON.stringify(resolved3));

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  for (const [f, buf] of Object.entries(backups)) {
    if (buf) fs.writeFileSync(f, buf);
    else if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
