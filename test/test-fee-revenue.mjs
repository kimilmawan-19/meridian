// Verifies the fee-revenue patch:
// [1] isInEntryAccumulation (real import) — the shared depth-aware grace helper.
// [2] updatePnlAndCheckExits LOW_YIELD (real round-trip) — no longer fires while a position
//     is still in its SOL-rich entry zone (it used to pre-empt Rule 5's grace entirely).
// [3] scoreCandidate formula mirror (private in tools/screening.js) — fee yield dominates
//     the ranking instead of organic score.
// Backs up + restores state.json.
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
  const { isInEntryAccumulation, trackPosition, updatePnlAndCheckExits } = await import("../state.js");
  const { config } = await import("../config.js");
  const mgmt = config.management;

  console.log("\n[1] isInEntryAccumulation (real import)");
  // Range: upper 100, lower 0 → depth% = 100 - active_bin
  const bins = (active) => ({ active_bin: active, upper_bin: 100, lower_bin: 0, in_range: true });
  const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

  check("curve, depth 20% → grace active",
    isInEntryAccumulation({ strategy: "curve" }, bins(80), mgmt).active === true);
  check("curve, depth 60% but breach never recorded → grace active",
    isInEntryAccumulation({ strategy: "curve", r9_grace_exited_at: null }, bins(40), mgmt).active === true);
  check("curve, depth 60%, breach 5m ago (< 15m confirm) → grace active",
    isInEntryAccumulation({ strategy: "curve", r9_grace_exited_at: minsAgo(5) }, bins(40), mgmt).active === true);
  check("curve, depth 60%, breach 20m ago → grace over",
    isInEntryAccumulation({ strategy: "curve", r9_grace_exited_at: minsAgo(20) }, bins(40), mgmt).active === false);
  check("bid_ask, depth 60% (< 80% bid_ask grace), breach 20m ago → grace active",
    isInEntryAccumulation({ strategy: "bid_ask", r9_grace_exited_at: minsAgo(20) }, bins(40), mgmt).active === true);
  check("bin data unavailable → fail-safe grace active",
    isInEntryAccumulation({ strategy: "curve" }, { in_range: true }, mgmt).active === true);
  check("out of range → no grace",
    isInEntryAccumulation({ strategy: "curve" }, { ...bins(40), in_range: false }, mgmt).active === false);
  check("missing tracked.strategy falls back to given default (bid_ask)",
    isInEntryAccumulation({}, bins(40), mgmt, "bid_ask").strategy === "bid_ask");

  console.log("\n[2] LOW_YIELD respects entry grace (real updatePnlAndCheckExits round-trip)");
  const addr = `test-feerev-${Date.now()}`;
  trackPosition({ position: addr, pool: "test-pool", pool_name: "TEST-SOL", strategy: "curve", volatility: 1.5 });
  const lowYieldData = (extra) => ({
    pnl_pct: 0.5,           // positive → avoids break-even / SL paths
    in_range: true,
    age_minutes: 90,        // past minAgeBeforeYieldCheck (60)
    total_value_usd: 100,
    collected_fees_usd: 0,
    unclaimed_fees_usd: 0.01, // ~0.16%/24h, far below minFeePerTvl24h 7%
    fee_per_tvl_24h: 1,
    ...extra,
  });

  const r1 = updatePnlAndCheckExits(addr, lowYieldData(bins(80)), mgmt);
  check("low fees but still in entry zone (depth 20%) → no LOW_YIELD", r1?.action !== "LOW_YIELD", `(got ${JSON.stringify(r1)})`);

  const r2 = updatePnlAndCheckExits(addr, lowYieldData({ in_range: true }), mgmt);
  check("low fees, bin data missing → no LOW_YIELD (fail-safe)", r2?.action !== "LOW_YIELD", `(got ${JSON.stringify(r2)})`);

  const r3 = updatePnlAndCheckExits(addr, lowYieldData({ ...bins(40), in_range: false }), mgmt);
  check("low fees and out of range → LOW_YIELD still fires", r3?.action === "LOW_YIELD", `(got ${JSON.stringify(r3)})`);

  const r4 = updatePnlAndCheckExits(addr, lowYieldData({ ...bins(80), unclaimed_fees_usd: 1 }), mgmt);
  check("healthy fees (~16%/24h) → no LOW_YIELD", r4?.action !== "LOW_YIELD", `(got ${JSON.stringify(r4)})`);

  console.log("\n[3] scoreCandidate ranking (mirrors tools/screening.js)");
  const newScore = (p) => p.fee_active_tvl_ratio * (p.organic_score / 100);
  const oldScore = (p) => p.fee_active_tvl_ratio * 1000 + p.organic_score * 10 + p.volume_window / 100 + p.holders / 100;
  const highFee = { fee_active_tvl_ratio: 0.30, organic_score: 65, volume_window: 2000, holders: 800 };
  const highOrganic = { fee_active_tvl_ratio: 0.10, organic_score: 88, volume_window: 2000, holders: 800 };
  check("old formula ranked the 3x-lower-fee pool first (the bug)", oldScore(highOrganic) > oldScore(highFee));
  check("new formula ranks the 3x-higher-fee pool first", newScore(highFee) > newScore(highOrganic));
  const sameFeeA = { fee_active_tvl_ratio: 0.2, organic_score: 90 };
  const sameFeeB = { fee_active_tvl_ratio: 0.2, organic_score: 60 };
  check("equal fee yield → higher organic still wins the tie", newScore(sameFeeA) > newScore(sameFeeB));
  const at5m = { fee_active_tvl_ratio: 0.2, organic_score: 70 };
  const at1h = { fee_active_tvl_ratio: 2.4, organic_score: 70 };
  const other5m = { fee_active_tvl_ratio: 0.1, organic_score: 90 };
  const other1h = { fee_active_tvl_ratio: 1.2, organic_score: 90 };
  check("ranking is timeframe-invariant (same order at 5m and 1h magnitudes)",
    (newScore(at5m) > newScore(other5m)) === (newScore(at1h) > newScore(other1h)));

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else { try { fs.unlinkSync(STATE_FILE); } catch (_) { /* ignore */ } }
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
