// Verifies non-SOL-quote (e.g. SOL-USDC) records are excluded from learning:
//   - generateAggregateLessons buckets exclude USDC-quoted records
//   - evolveThresholds ignores USDC-quoted losers/winners
// lessons.js does not export the internals, so we exercise them through the public API
// (recordPerformance writes to lessons.json; getPerformanceSummary / aggregate run on read).
// Backs up + restores lessons.json and pool-memory.json.
process.env.DRY_RUN = "true";

import fs from "fs";

const LESSONS_FILE = "./lessons.json";
const POOLMEM_FILE = "./pool-memory.json";
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const backups = {};
for (const f of [LESSONS_FILE, POOLMEM_FILE]) backups[f] = fs.existsSync(f) ? fs.readFileSync(f) : null;

// Build a performance history: SOL-quoted curve winners at bin_step 90, plus deep SOL-USDC losses
// at tiny bin_step (would land in the "80-100" bucket and drag avg PnL negative if not filtered).
function perfRecord({ name, pnl_pct, bin_step, fee, quote_symbol }) {
  const initial = 100;
  const final = initial * (1 + pnl_pct / 100);
  return {
    pool: name, pool_name: name, base_mint: name + "Mint", quote_symbol,
    strategy: "curve", bin_step, volatility: 2, fee_tvl_ratio: fee, organic_score: 80,
    amount_sol: 1, fees_earned_usd: pnl_pct > 0 ? 4 : 0.2,
    final_value_usd: final, initial_value_usd: initial,
    minutes_in_range: 90, minutes_held: 100, close_reason: pnl_pct < -5 ? "stop loss" : "trailing TP",
    recorded_at: new Date().toISOString(), pnl_pct, pnl_usd: final + (pnl_pct > 0 ? 4 : 0.2) - initial,
  };
}

try {
  // Seed lessons.json directly with a mixed performance history.
  const perf = [
    perfRecord({ name: "WIF-SOL",   pnl_pct: +6, bin_step: 90, fee: 3.0, quote_symbol: "SOL" }),
    perfRecord({ name: "BONK-SOL",  pnl_pct: +4, bin_step: 95, fee: 2.8, quote_symbol: "SOL" }),
    perfRecord({ name: "POPCAT-SOL",pnl_pct: +5, bin_step: 88, fee: 3.2, quote_symbol: "SOL" }),
    perfRecord({ name: "MEW-SOL",   pnl_pct: +3, bin_step: 92, fee: 2.5, quote_symbol: "SOL" }),
    perfRecord({ name: "GIGA-SOL",  pnl_pct: +7, bin_step: 100, fee: 3.5, quote_symbol: "SOL" }),
    // Contaminating SOL-USDC deep losses, tiny bin_step → would fall into "80-100" bucket
    perfRecord({ name: "AAA-USDC",  pnl_pct: -18, bin_step: 5, fee: 0.6, quote_symbol: "USDC" }),
    perfRecord({ name: "BBB-USDC",  pnl_pct: -22, bin_step: 8, fee: 0.5, quote_symbol: "USDC" }),
    perfRecord({ name: "CCC-USDC",  pnl_pct: -15, bin_step: 10, fee: 0.7, quote_symbol: "USDC" }),
  ];
  fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: perf }, null, 2));
  fs.writeFileSync(POOLMEM_FILE, JSON.stringify({}, null, 2));

  const { config } = await import("../config.js");
  // Force a wide window so all seeded records are in-scope.
  config.screening.evolveWindowDays = 365;

  const lessons = await import("../lessons.js");

  // ── [1] evolveThresholds must ignore USDC losers ────────────────
  console.log("\n[1] evolveThresholds excludes non-SOL records");
  const before = { fee: config.screening.minFeeActiveTvlRatio, organic: config.screening.minOrganic };
  const result = lessons.evolveThresholds(perf, config);
  // With only SOL winners (no SOL losers < -5%), there is no quality-loser evidence → no RAISE.
  // If USDC losses leaked in, raiseAllowed could fire and bump minFeeActiveTvlRatio upward.
  const feeAfter = result?.changes?.minFeeActiveTvlRatio ?? before.fee;
  check("minFeeActiveTvlRatio NOT raised by USDC losers", feeAfter <= before.fee,
    `before=${before.fee} after=${feeAfter} changes=${JSON.stringify(result?.changes ?? {})}`);

  // ── [2] AGGREGATE bucket reflects only SOL records ──────────────
  console.log("\n[2] aggregate buckets exclude non-SOL records");
  // Trigger aggregate refresh by recording one more SOL close (crosses an internal cadence or we
  // call the summary path). We re-read after forcing a refresh via recordPerformance.
  // Simplest: recordPerformance enough SOL closes to hit the %20 refresh, then inspect lessons.json.
  // Seed count is 8; push SOL closes up to a multiple of 20 boundary is heavy — instead assert via
  // the public getDetailedPerformanceAnalysis bin_step bucket which counts raw (unfiltered) — so
  // we validate the FILTER through a direct effect: aggregate lesson generation.
  // Record 12 more SOL winners to reach 20 total → triggers refreshAggregateLessons.
  for (let i = 0; i < 12; i++) {
    await lessons.recordPerformance(perfRecord({ name: `EXTRA${i}-SOL`, pnl_pct: +5, bin_step: 90, fee: 3.0, quote_symbol: "SOL" }));
  }
  const after = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  const aggLessons = after.lessons.filter((l) => l.tags?.includes("aggregate"));
  check("aggregate lessons were generated", aggLessons.length > 0, `got ${aggLessons.length}`);
  const curve80 = aggLessons.find((l) => /curve \+ bin_step 80-100/.test(l.rule));
  check("curve+80-100 aggregate exists", !!curve80, curve80?.rule ?? "(none)");
  if (curve80) {
    // Extract avg PnL from the rule string. With USDC losses excluded it must be POSITIVE.
    const m = curve80.rule.match(/([+-][\d.]+)% avg PnL/);
    const avgPnl = m ? parseFloat(m[1]) : null;
    check("curve+80-100 avg PnL positive (USDC losses excluded)", avgPnl != null && avgPnl > 0,
      `rule="${curve80.rule}"`);
  }

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
