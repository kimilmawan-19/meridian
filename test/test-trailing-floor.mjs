// Verifies the trailing-TP in-range give-back floor (state.js updatePnlAndCheckExits).
// Live data: break-even closes averaged peak +7.33% → −0.96% because the in-range trailing
// deferral had no floor. Now deferral stops once give-back >= peak / tpVetoFloorDivisor (2).
// Also: the stop-loss reason prints a rounded threshold (regime scaling produced -8.399999999999999%).
// Real module round-trip; backs up + restores state.json.
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

try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions: {}, recentEvents: [] }, null, 2));
  const state = await import("../state.js");
  const { config } = await import("../config.js");
  const mgmt = config.management;

  const open = (addr) => {
    state.trackPosition({
      position: addr, pool: `Pool-${addr}`, pool_name: "FLOOR-SOL", strategy: "curve",
      bin_range: { min: 100, max: 200 }, amount_sol: 1, active_bin: 150,
      bin_step: 100, volatility: 2, fee_tvl_ratio: 2, organic_score: 80, initial_value_usd: 100,
    });
    state.queuePeakConfirmation(addr, 8, { immediate: true }); // peak +8%
  };
  const data = (pnl, inRange) => ({
    pnl_pct: pnl,
    in_range: inRange,
    age_minutes: 120,
    total_value_usd: 100,
    collected_fees_usd: 0,
    unclaimed_fees_usd: 1, // ~12%/24h → keeps LOW_YIELD out of the way
    fee_per_tvl_24h: 20,
  });

  console.log("\n[1] in-range, peak 8% (effectiveDrop = max(1.5, 8/3) = 2.67, floor = 8/2 = 4)");
  const A = "FloorPosA1111111111111111111111111111111111";
  open(A);
  const r1 = state.updatePnlAndCheckExits(A, data(5, true), mgmt);
  check("PnL 5% (drop 3, below floor 4) → still deferred", r1 == null, `(got ${JSON.stringify(r1)})`);
  check("deferral timer started", state.getTrackedPosition(A)?.trailing_in_range_since != null);

  const r2 = state.updatePnlAndCheckExits(A, data(3.5, true), mgmt);
  check("PnL 3.5% (drop 4.5 >= floor 4) → TRAILING_TP immediately", r2?.action === "TRAILING_TP", `(got ${JSON.stringify(r2)})`);
  check("reason tags the give-back floor", /give-back floor/.test(r2?.reason ?? ""), `(got ${r2?.reason})`);
  check("deferral timer cleared on floor exit", state.getTrackedPosition(A)?.trailing_in_range_since == null);
  check("drop passed to veto layer is >= peak/2 (→ forced close, no LLM hold)",
    (r2?.drop_from_peak_pct ?? 0) >= (r2?.peak_pnl_pct ?? 0) / (mgmt.tpVetoFloorDivisor ?? 2));

  console.log("\n[2] out of range — unchanged behavior");
  const B = "FloorPosB1111111111111111111111111111111111";
  open(B);
  const r3 = state.updatePnlAndCheckExits(B, data(5, false), mgmt);
  check("OOR, PnL 5% (drop 3 >= 2.67) → TRAILING_TP", r3?.action === "TRAILING_TP", `(got ${JSON.stringify(r3)})`);
  check("OOR reason has no floor tag", !/give-back floor/.test(r3?.reason ?? ""));

  console.log("\n[3] small in-range dip — unchanged behavior");
  const C = "FloorPosC1111111111111111111111111111111111";
  open(C);
  const r4 = state.updatePnlAndCheckExits(C, data(6.5, true), mgmt);
  check("PnL 6.5% (drop 1.5 < effectiveDrop) → no exit", r4 == null, `(got ${JSON.stringify(r4)})`);

  console.log("\n[4] stop-loss reason label is rounded (was \"<= -8.399999999999999%\")");
  const D = "FloorPosD1111111111111111111111111111111111";
  state.trackPosition({
    position: D, pool: `Pool-${D}`, pool_name: "SL-SOL", strategy: "curve",
    bin_range: { min: 100, max: 200 }, amount_sol: 1, active_bin: 150, sl_pct_override: -12,
    bin_step: 100, volatility: 2, fee_tvl_ratio: 2, organic_score: 80, initial_value_usd: 100,
  });
  const slMgmt = { ...mgmt, allowLlmRiskParams: true, minAgeBeforeStopLoss: 0 };
  const r5 = state.updatePnlAndCheckExits(D, data(-9, true), slMgmt, "bearish"); // -12 × 0.7 = -8.399999999999999
  check("bearish SL fires with a rounded threshold", r5?.action === "STOP_LOSS" && /<= -8\.4%/.test(r5?.reason ?? ""), `(got ${r5?.reason})`);
  check("no long float in reason", !/\d\.\d{5,}/.test(r5?.reason ?? ""));

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else { try { fs.unlinkSync(STATE_FILE); } catch (_) { /* ignore */ } }
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
