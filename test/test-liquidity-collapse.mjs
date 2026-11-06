// Verifies Rule 11 (liquidity collapse) — a new emergency exit targeting the rug-signature
// failure mode that price-based rules (auto-SL, Rule 9) react to too late: liquidity pulled
// directly from the pool, sometimes with near-zero swap activity (e/acc-SOL -26.95%, ~19pt
// overshoot past its auto-SL tier, was the trigger case for this rule).
//
// [1] real state.js round-trip: trackPosition -> batchUpdateMarketData -> getTrackedPosition,
//     verifying peak_liquidity_usd/liquidity_history track the same way volume already does.
// [2] mirrors the Rule 11 decision formula from index.js getDeterministicCloseRule (private,
//     not exported) — same pattern as test-regime-risk.mjs for rules that live inline in a
//     large private function not worth extracting just for testability.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  const { trackPosition, batchUpdateMarketData, getTrackedPosition } = await import("../state.js");
  const { config } = await import("../config.js");

  console.log("\n[1] state.js liquidity tracking (real trackPosition/batchUpdateMarketData round-trip)");
  const testAddr = `test-rule11-${Date.now()}`;
  trackPosition({
    position: testAddr,
    pool: "test-pool",
    pool_name: "TEST-SOL",
    strategy: "curve",
    volatility: 1.5,
  });

  check("new position starts with peak_liquidity_usd null", getTrackedPosition(testAddr)?.peak_liquidity_usd === null);
  check("new position starts with empty liquidity_history", Array.isArray(getTrackedPosition(testAddr)?.liquidity_history) && getTrackedPosition(testAddr).liquidity_history.length === 0);

  // Simulate 3 cycles of healthy liquidity, then a collapse
  batchUpdateMarketData(new Map([[testAddr, { liquidity_usd: 5000, volume_5m: 100, fetched_at: new Date().toISOString() }]]));
  check("peak tracks first sample (5000)", getTrackedPosition(testAddr)?.peak_liquidity_usd === 5000);

  batchUpdateMarketData(new Map([[testAddr, { liquidity_usd: 6000, volume_5m: 100, fetched_at: new Date().toISOString() }]]));
  check("peak updates to new high (6000)", getTrackedPosition(testAddr)?.peak_liquidity_usd === 6000);

  batchUpdateMarketData(new Map([[testAddr, { liquidity_usd: 5500, volume_5m: 100, fetched_at: new Date().toISOString() }]]));
  check("peak does NOT decay on a dip (stays 6000)", getTrackedPosition(testAddr)?.peak_liquidity_usd === 6000);
  check("liquidity_history has 3 entries", getTrackedPosition(testAddr)?.liquidity_history.length === 3);

  // Simulate the rug: liquidity collapses to 15% of peak
  batchUpdateMarketData(new Map([[testAddr, { liquidity_usd: 900, volume_5m: 5, fetched_at: new Date().toISOString() }]]));
  const afterCollapse = getTrackedPosition(testAddr);
  check("peak still remembers pre-rug high (6000)", afterCollapse?.peak_liquidity_usd === 6000);
  check("history capped at 5 entries (rolling window)", afterCollapse?.liquidity_history.length === 4); // only 4 pushed so far

  // Push more to verify the 5-entry cap
  for (let i = 0; i < 4; i++) {
    batchUpdateMarketData(new Map([[testAddr, { liquidity_usd: 900 + i, volume_5m: 5, fetched_at: new Date().toISOString() }]]));
  }
  check("history capped at 5 entries after 8 total updates", getTrackedPosition(testAddr).liquidity_history.length === 5);

  console.log("\n[2] Config defaults");
  check("liquidityCollapse.enabled default true", config.emergencyExits.liquidityCollapse.enabled === true);
  check("dropThresholdPct default 40", config.emergencyExits.liquidityCollapse.dropThresholdPct === 40);
  check("minPositionAgeMin default 5 (shorter than volumeCollapse's 10 — LP pulls are fast)", config.emergencyExits.liquidityCollapse.minPositionAgeMin === 5);
  check("minPeakLiquidityUsd default 1000", config.emergencyExits.liquidityCollapse.minPeakLiquidityUsd === 1000);

  console.log("\n[3] Rule 11 decision formula (mirrors index.js getDeterministicCloseRule)");
  // Mirrors the exact condition from index.js — no sell-pressure requirement, unlike Rule 7.
  function rule11Fires({ ageMin, peakLiq, curLiq, oorDir, inRange, pnlPct, inEntryAccumulation, cfg }) {
    const inRangeAndGreen = inRange !== false && (pnlPct ?? 0) >= 0;
    return (
      oorDir !== "ABOVE" &&
      !inRangeAndGreen &&
      !inEntryAccumulation &&
      ageMin >= (cfg.minPositionAgeMin ?? 5) &&
      peakLiq >= (cfg.minPeakLiquidityUsd ?? 1000) &&
      curLiq != null && curLiq < peakLiq * (cfg.dropThresholdPct / 100)
    );
  }
  const cfg = config.emergencyExits.liquidityCollapse;

  check("fires on a clean rug (peak 6000 -> 900, 15% of peak, aged, red, out of accumulation)",
    rule11Fires({ ageMin: 30, peakLiq: 6000, curLiq: 900, oorDir: null, inRange: true, pnlPct: -30, inEntryAccumulation: false, cfg }) === true);

  check("does NOT fire above dropThresholdPct (6000 -> 3000 = 50%, above 40% floor)",
    rule11Fires({ ageMin: 30, peakLiq: 6000, curLiq: 3000, oorDir: null, inRange: true, pnlPct: -10, inEntryAccumulation: false, cfg }) === false);

  check("does NOT fire when OOR ABOVE (idle SOL, no capital at risk)",
    rule11Fires({ ageMin: 30, peakLiq: 6000, curLiq: 900, oorDir: "ABOVE", inRange: false, pnlPct: 0, inEntryAccumulation: false, cfg }) === false);

  check("does NOT fire when in-range and still green (temporary dip, not a loss event)",
    rule11Fires({ ageMin: 30, peakLiq: 6000, curLiq: 900, oorDir: null, inRange: true, pnlPct: 2, inEntryAccumulation: false, cfg }) === false);

  check("does NOT fire during entry-accumulation grace (SOL-rich position absorbing early moves)",
    rule11Fires({ ageMin: 30, peakLiq: 6000, curLiq: 900, oorDir: null, inRange: true, pnlPct: -30, inEntryAccumulation: true, cfg }) === false);

  check("does NOT fire below minPositionAgeMin (too young to judge)",
    rule11Fires({ ageMin: 2, peakLiq: 6000, curLiq: 900, oorDir: null, inRange: true, pnlPct: -30, inEntryAccumulation: false, cfg }) === false);

  check("does NOT fire below minPeakLiquidityUsd (dust pool, noisy liquidity)",
    rule11Fires({ ageMin: 30, peakLiq: 500, curLiq: 50, oorDir: null, inRange: true, pnlPct: -30, inEntryAccumulation: false, cfg }) === false);

  check("fires with near-zero swap activity — no buys/sells needed unlike Rule 7 (the whole point)",
    rule11Fires({ ageMin: 30, peakLiq: 6000, curLiq: 100, oorDir: null, inRange: true, pnlPct: -80, inEntryAccumulation: false, cfg }) === true);

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
