// Verifies the 4 regime-aware risk levers added to close the "regime only protects new
// deploys, not existing positions" gap:
//   1. SL tightening      — state.js effectiveStopLossPct(tracked, mgmtConfig, regime)
//   2. SOL momentum signal — market-regime.js assessMarketRegime Signal 4 scoring formula
//   3. Faster profit-taking — state.js updatePnlAndCheckExits trailing effectiveDrop scaling
//   4. Trim-to-cap         — index.js runManagementCycle Rule 10 decision logic
//
// (1) is tested via a real import (pure function, no state.json I/O). (2)-(4) mirror the
// exact formula/decision logic from their source files — assessMarketRegime itself needs
// network (fetchTrendingBreadth/DexScreener) so isn't callable end-to-end in a fast unit
// test, and updatePnlAndCheckExits/Rule 10 need a seeded state.json/positionData array that
// isn't worth the setup cost here — same pattern as test-entry-flow-filter.mjs's
// "mirrors index.js callback" approach.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
function approx(a, b, eps = 0.001) { return Math.abs(a - b) < eps; }

try {
  const { effectiveStopLossPct } = await import("../state.js");
  const { config } = await import("../config.js");

  console.log("\n[1] effectiveStopLossPct — regime-aware SL tightening (real import)");
  const mgmt = {
    stopLossFloorPct: -50,
    stopLossTightestPct: -8,
    allowLlmRiskParams: true,
    stopLossPct: -50,
    marketRegimeCautionSlMult: 0.85,
    marketRegimeBearishSlMult: 0.7,
  };

  // mid-vol-tier position, sl_pct_override = -12 (auto-SL mid tier)
  const midVolPos = { sl_pct_override: -12 };
  check("healthy: unchanged (-12%)", effectiveStopLossPct(midVolPos, mgmt, "healthy") === -12);
  check("caution: -12 * 0.85 = -10.2%", approx(effectiveStopLossPct(midVolPos, mgmt, "caution"), -10.2));
  check("bearish: -12 * 0.7 = -8.4%", approx(effectiveStopLossPct(midVolPos, mgmt, "bearish"), -8.4));
  check("default regime param = healthy (backward compatible)", effectiveStopLossPct(midVolPos, mgmt) === -12);

  // low-vol-tier position, sl_pct_override = -8 (auto-SL low tier, == stopLossTightestPct).
  // effectiveStopLossPct scales BOTH raw and the tightest clamp by the same multiplier, so
  // positions already at the tightest bound still get tightened during bad regime (this was
  // the most common overshoot tier in observed data — CATWIF, reptilecoin, febu all -8%).
  const lowVolPos = { sl_pct_override: -8 };
  check("low-vol bearish: -8 * 0.7 = -5.6% (tightest clamp scales too)", approx(effectiveStopLossPct(lowVolPos, mgmt, "bearish"), -5.6));
  check("low-vol caution: -8 * 0.85 = -6.8%", approx(effectiveStopLossPct(lowVolPos, mgmt, "caution"), -6.8));

  // high-vol-tier position, sl_pct_override = -15 — bearish tightening must not violate the
  // tightest clamp (-8) in the wrong direction (tightening only pulls it closer to 0, never
  // past the tightest bound since Math.min(tightest, ...) still applies after scaling)
  const highVolPos = { sl_pct_override: -15 };
  const highVolBearish = effectiveStopLossPct(highVolPos, mgmt, "bearish"); // -15*0.7=-10.5, still < -8
  check("high-vol bearish: -15 * 0.7 = -10.5% (still looser than tightest, clamp not hit)", approx(highVolBearish, -10.5));

  // floor clamp still enforced after scaling (scaling never pushes past floor since it only
  // shrinks magnitude toward zero)
  const looseOverride = { sl_pct_override: -48 };
  const flooredHealthy = effectiveStopLossPct(looseOverride, mgmt, "healthy");
  check("floor clamp intact at healthy (-48 unclamped, within floor -50)", flooredHealthy === -48);

  console.log("\n[2] Config defaults");
  check("marketRegime.enabled defaults true (CLAUDE.md previously said false — fixed)", config.marketRegime.enabled === true);
  check("marketRegimeCautionSlMult default 0.85", config.management.marketRegimeCautionSlMult === 0.85);
  check("marketRegimeBearishSlMult default 0.7", config.management.marketRegimeBearishSlMult === 0.7);
  check("marketRegimeCautionTrailMult default 0.8", config.management.marketRegimeCautionTrailMult === 0.8);
  check("marketRegimeBearishTrailMult default 0.6", config.management.marketRegimeBearishTrailMult === 0.6);
  check("bearishScoreThreshold default 3.7", config.marketRegime.bearishScoreThreshold === 3.7);
  check("cautionScoreThreshold default 1.8", config.marketRegime.cautionScoreThreshold === 1.8);

  console.log("\n[3] Trailing give-back regime scaling (mirrors state.js updatePnlAndCheckExits)");
  function trailingEffectiveDrop(peakPnlPct, dropFloor, givebackDivisor, regime, mgmtConfig) {
    let effectiveDrop = Math.max(dropFloor, peakPnlPct / givebackDivisor);
    if (regime === "bearish") effectiveDrop *= mgmtConfig.marketRegimeBearishTrailMult ?? 0.6;
    else if (regime === "caution") effectiveDrop *= mgmtConfig.marketRegimeCautionTrailMult ?? 0.8;
    return effectiveDrop;
  }
  const trailMgmt = { marketRegimeCautionTrailMult: 0.8, marketRegimeBearishTrailMult: 0.6 };
  // peak=15%, floor=1%, divisor=3 → base effectiveDrop = max(1, 5) = 5
  check("healthy: effectiveDrop = 5%", trailingEffectiveDrop(15, 1, 3, "healthy", trailMgmt) === 5);
  check("caution: effectiveDrop = 5 * 0.8 = 4%", approx(trailingEffectiveDrop(15, 1, 3, "caution", trailMgmt), 4));
  check("bearish: effectiveDrop = 5 * 0.6 = 3%", approx(trailingEffectiveDrop(15, 1, 3, "bearish", trailMgmt), 3));
  check("tighter give-back closes sooner (bearish < caution < healthy)",
    trailingEffectiveDrop(15, 1, 3, "bearish", trailMgmt) < trailingEffectiveDrop(15, 1, 3, "caution", trailMgmt) &&
    trailingEffectiveDrop(15, 1, 3, "caution", trailMgmt) < trailingEffectiveDrop(15, 1, 3, "healthy", trailMgmt));

  console.log("\n[4] SOL momentum scoring (mirrors market-regime.js Signal 4)");
  function solMomentumScore(chg30m, chg60m) {
    if (chg30m == null) return 0;
    if (chg30m <= -3 && (chg60m == null || chg60m <= -4)) return 1.0;
    if (chg30m <= -3 || (chg60m != null && chg60m <= -4)) return 0.5;
    if (chg30m <= -1.5) return 0.25;
    return 0;
  }
  check("SOL dumping both windows → 1.0", solMomentumScore(-4, -5) === 1.0);
  check("SOL dumping 30m only → 0.5", solMomentumScore(-4, -1) === 0.5);
  check("SOL dumping 60m only (30m mild) → 0.5", solMomentumScore(-2, -5) === 0.5);
  check("SOL mild dip → 0.25", solMomentumScore(-2, -1) === 0.25);
  check("SOL flat/up → 0", solMomentumScore(0.5, 1) === 0);
  check("no samples yet → 0 (fail-safe)", solMomentumScore(null, null) === 0);

  console.log("\n[5] Rule 10 trim-to-cap decision (mirrors index.js runManagementCycle)");
  function computeTrimDecision(positions, actionMap, regimeEnabled, activeRegime, cap) {
    if (!regimeEnabled || activeRegime === "healthy") return null;
    const stillOpen = positions.filter((p) => actionMap.get(p.position)?.action === "STAY");
    const closingCount = positions.length - stillOpen.length;
    const projectedOpenCount = positions.length - closingCount;
    if (projectedOpenCount > cap && stillOpen.length > 0) {
      return stillOpen.reduce((min, p) => (p.pnl_pct ?? 0) < (min.pnl_pct ?? 0) ? p : min);
    }
    return null;
  }
  const positions4 = [
    { position: "A", pnl_pct: 5 },
    { position: "B", pnl_pct: -8 },
    { position: "C", pnl_pct: 2 },
    { position: "D", pnl_pct: -3 },
  ];
  const allStay = new Map(positions4.map(p => [p.position, { action: "STAY" }]));
  const trimBearish = computeTrimDecision(positions4, allStay, true, "bearish", 3);
  check("4 STAY positions, cap=3, bearish → trims weakest (B, -8%)", trimBearish?.position === "B");
  check("healthy regime → no trim even over cap", computeTrimDecision(positions4, allStay, true, "healthy", 3) === null);
  check("regime disabled → no trim", computeTrimDecision(positions4, allStay, false, "bearish", 3) === null);
  const within3 = positions4.slice(0, 3);
  const within3Stay = new Map(within3.map(p => [p.position, { action: "STAY" }]));
  check("3 positions, cap=3 → no trim needed", computeTrimDecision(within3, within3Stay, true, "caution", 3) === null);
  // If another rule already closes one this cycle, projected count drops below cap — no double-trim
  const oneAlreadyClosing = new Map([
    ["A", { action: "STAY" }],
    ["B", { action: "CLOSE", rule: 1 }], // Rule 1 already closing B this cycle
    ["C", { action: "STAY" }],
    ["D", { action: "STAY" }],
  ]);
  check("1 already CLOSE-flagged by another rule → projected count 3, no extra trim",
    computeTrimDecision(positions4, oneAlreadyClosing, true, "bearish", 3) === null);

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
