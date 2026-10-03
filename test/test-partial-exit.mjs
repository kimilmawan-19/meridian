// Runtime verification for partial exit feature.
// Loads the REAL modules (state, config, dlmm, lessons) and exercises the
// new code paths. Backs up lessons.json and cleans up state.json afterwards.
import fs from "fs";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// ── Backup ──
const lessonsBackup = fs.existsSync(LESSONS_FILE) ? fs.readFileSync(LESSONS_FILE) : null;
const stateExisted = fs.existsSync(STATE_FILE);

process.env.DRY_RUN = "true";

try {
  const state = await import("../state.js");
  const { config } = await import("../config.js");
  const dlmm = await import("../tools/dlmm.js");
  const lessons = await import("../lessons.js");

  // ─────────────────────────────────────────────────────────────
  console.log("\n[1] config.partialExit defaults");
  const pe = config.management.partialExit;
  check("partialExit block exists", !!pe);
  check("enabled default false", pe.enabled === false);
  check("defaultPct=50", pe.defaultPct === 50);
  check("minPct=25 / maxPct=75", pe.minPct === 25 && pe.maxPct === 75);
  check("stage2TrailingDropPct=0.8", pe.stage2TrailingDropPct === 0.8);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[2] markPartialExit state mutation");
  const POS = "TestPos1111111111111111111111111111111111111";
  state.trackPosition({
    position: POS, pool: "Pool111", pool_name: "TEST-SOL", strategy: "bid_ask",
    bin_range: { min: 100, max: 200 }, amount_sol: 1, active_bin: 150,
    bin_step: 100, volatility: 5, fee_tvl_ratio: 2, organic_score: 80,
    initial_value_usd: 200, trailing_drop_override: 1.5,
  });
  // simulate a peak having been reached
  const before = state.getTrackedPosition(POS);
  check("position tracked", !!before);
  check("partial_taken_count starts 0", before.partial_taken_count === 0);

  const ok = state.markPartialExit(POS, { pct: 50, usd: 100, peak_pnl_pct: 8.2, tightenDropPct: 0.8 });
  check("markPartialExit returns true", ok === true);
  const after = state.getTrackedPosition(POS);
  check("partial_taken_count incremented", after.partial_taken_count === 1, `got ${after.partial_taken_count}`);
  check("partial_taken_pct accumulated", after.partial_taken_pct === 50, `got ${after.partial_taken_pct}`);
  check("partial_taken_usd accumulated", after.partial_taken_usd === 100, `got ${after.partial_taken_usd}`);
  check("partial_peak_at_exit stamped", after.partial_peak_at_exit === 8.2);
  check("partial_taken_at timestamp set", !!after.partial_taken_at);
  check("trailing tightened to min(1.5,0.8)=0.8", after.trailing_drop_override === 0.8, `got ${after.trailing_drop_override}`);
  check("veto budget reset", after.tp_veto_count === 0 && after.tp_veto_peak === null);

  // second partial accumulates
  state.markPartialExit(POS, { pct: 30, usd: 40, peak_pnl_pct: 6, tightenDropPct: 1.0 });
  const after2 = state.getTrackedPosition(POS);
  check("2nd partial: count=2", after2.partial_taken_count === 2);
  check("2nd partial: pct=80 cumulative", after2.partial_taken_pct === 80, `got ${after2.partial_taken_pct}`);
  check("2nd partial: keeps tighter 0.8 (not loosened to 1.0)", after2.trailing_drop_override === 0.8, `got ${after2.trailing_drop_override}`);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[3] partialClosePosition DRY_RUN + clamp");
  const r1 = await dlmm.partialClosePosition({ position_address: POS, pct: 50, reason: "test" });
  check("DRY_RUN returns dry_run flag", r1.dry_run === true, JSON.stringify(r1));
  const r2 = await dlmm.partialClosePosition({ position_address: POS, pct: 0 });
  check("pct=0 rejected", r2.success === false);
  const r3 = await dlmm.partialClosePosition({ position_address: POS, pct: "abc" });
  check("non-numeric pct rejected", r3.success === false);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[4] lessons derivLesson partial pattern");
  // good outcome with partial → should produce a partial_exit/worked lesson
  await lessons.recordPerformance({
    position: "L1", pool: "PoolL1", pool_name: "WINP-SOL", strategy: "bid_ask",
    bin_range: 100, bin_step: 100, volatility: 5, fee_tvl_ratio: 2, organic_score: 80,
    amount_sol: 1, fees_earned_usd: 5, final_value_usd: 210, initial_value_usd: 200,
    minutes_in_range: 100, minutes_held: 120, close_reason: "trailing TP",
    peak_pnl_pct: 12, partial_taken_count: 1, partial_taken_pct: 50,
  });
  const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  const last = data.performance[data.performance.length - 1];
  check("performance recorded with partial_taken_count", last.partial_taken_count === 1);
  check("blended pnl positive (210+5-200=+7.5%)", Math.abs(last.pnl_pct - 7.5) < 0.01, `got ${last.pnl_pct}`);
  const partialLesson = data.lessons.find(l => l.tags?.includes("partial_exit"));
  check("partial_exit lesson derived", !!partialLesson, partialLesson ? `: "${partialLesson.rule.slice(0,60)}..."` : "(none)");

  // ─────────────────────────────────────────────────────────────
  console.log("\n[5] PnL no double-count guard (metadata only)");
  // partial_taken_usd is NOT a recordPerformance input field — confirm pnl uses only
  // final_value + fees - initial (since API already blends via allTimeWithdrawals)
  check("pnl formula ignores partial_taken_usd", Math.abs(last.pnl_pct - 7.5) < 0.01);

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  // ── Cleanup ──
  if (lessonsBackup) fs.writeFileSync(LESSONS_FILE, lessonsBackup);
  else if (fs.existsSync(LESSONS_FILE)) fs.unlinkSync(LESSONS_FILE);
  if (!stateExisted && fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
