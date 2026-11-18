// Verifies the "Price recovering" cancel of a queued trailing exit (index.js scheduleTrailingDropConfirmation).
// Live 2026-10-20 (COMPUTE-SOL, peak 3.82%): the exit was decided at +0.01% but the close transaction expired; the retries
// at -0.39%, -4.43% and -6.48% were each cancelled by "Price recovering (1.58%)" (DexScreener 5m change, while the position's
// own PnL made three new lows), the cancel left the pending state set, and the next queue came 9 minutes later at -8.52%
// (closed at -10.14%). Now the cancel applies only while the queued PnL is still >= 0; below 0 the PnL recheck decides alone.
// Real state.js round-trip; backs up + restores state.json. index.js is not importable for the timer, so a source check guards it.
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
  const verdict = state.trailingRecheckPriceVerdict;

  console.log("\n[1] the verdict");
  check("no 5m change (null / undefined) → none, whatever the PnL", verdict(null, 2) === "none" && verdict(undefined, -3) === "none" && verdict(undefined, undefined) === "none");
  check("5m change 0 or negative → none (the PnL recheck decides)", verdict(0, 1) === "none" && verdict(-0.01, 1) === "none" && verdict(-9.66, -6) === "none");
  check("positive 5m change, queued PnL above 0 → cancel (profit zone, unchanged)", verdict(1.58, 0.75) === "cancel" && verdict(0.01, 3.2) === "cancel");
  check("queued PnL exactly 0 → cancel (the boundary stays on the old behaviour)", verdict(1.58, 0) === "cancel");
  check("positive 5m change, queued PnL below 0 → ignored", verdict(1.58, -0.39) === "ignored" && verdict(1.58, -4.43) === "ignored" && verdict(1.58, -6.48) === "ignored");
  check("just below 0 → ignored", verdict(0.01, -0.0001) === "ignored");
  check("no queued PnL known → cancel (fail-safe: the old behaviour)", verdict(1.58, null) === "cancel" && verdict(1.58, undefined) === "cancel");

  console.log("\n[2] COMPUTE-SOL replay with the real state module");
  // Live values (user-config.json): breakEvenTriggerPct 5, trailingTriggerPct 3, trailingDropPct 3.
  const mgmt = { ...config.management, trailingTakeProfit: true, breakEvenTriggerPct: 5, trailingTriggerPct: 3, trailingDropPct: 3 };
  const POS = "ComputePos11111111111111111111111111111111111";
  state.trackPosition({
    position: POS, pool: "Pool-compute", pool_name: "COMPUTE-SOL", strategy: "bid_ask",
    bin_range: { min: 100, max: 200 }, amount_sol: 1, active_bin: 150,
    bin_step: 100, volatility: 4.66, fee_tvl_ratio: 1.6, organic_score: 80, initial_value_usd: 209.46,
  });
  state.queuePeakConfirmation(POS, 3.82, { immediate: true });
  const data = (pnl, inRange = true) => ({ pnl_pct: pnl, in_range: inRange, age_minutes: 45, total_value_usd: 190, collected_fees_usd: 2, unclaimed_fees_usd: 1, fee_per_tvl_24h: 20 });

  const e1 = state.updatePnlAndCheckExits(POS, data(-0.39), mgmt);
  check("PnL −0.39% after a 3.82% peak → first-pass TRAILING_TP (drop 4.21 ≥ 3.00)", e1?.action === "TRAILING_TP" && e1.needs_confirmation === true && Math.abs(e1.effective_drop_pct - 3) < 1e-9, JSON.stringify(e1));
  check("it is queued (new low)", state.queueTrailingDropConfirmation(POS, e1.peak_pnl_pct, e1.current_pnl_pct, e1.effective_drop_pct, e1.in_range_exit) === true);
  const pend1 = state.getTrackedPosition(POS).pending_trailing_current_pnl_pct;
  check("queued PnL −0.39 is what index.js reads back", Math.abs(pend1 + 0.39) < 1e-9, String(pend1));
  check("DexScreener +1.58% at that moment → ignored, not cancel (the bug: it cancelled)", verdict(1.58, pend1) === "ignored");
  const rc = state.resolvePendingTrailingDrop(POS, -2.5, 3, 0.5);
  check("so the PnL recheck runs: reading −2.5% (still near the crash, drop 6.32 ≥ 3.00) → confirmed", rc.confirmed === true && /Trailing TP: peak 3\.82%/.test(rc.reason ?? ""), JSON.stringify(rc));
  check("confirmation leaves no pending state behind", state.getTrackedPosition(POS).pending_trailing_current_pnl_pct == null);
  state.updatePnlAndCheckExits(POS, data(-2.5), mgmt); // consume the confirmed exit
  check("the wick filter still works below 0: a bounce of more than 0.5 above the queued reading is rejected", (() => {
    state.queueTrailingDropConfirmation(POS, 3.82, -4.43, 3, true);
    const r = state.resolvePendingTrailingDrop(POS, -2.0, 3, 0.5);
    return r.rejected === true && r.confirmed === false;
  })());

  console.log("\n[3] profit zone unchanged");
  const P2 = "ComputePos22222222222222222222222222222222222";
  state.trackPosition({
    position: P2, pool: "Pool-profit", pool_name: "PROFIT-SOL", strategy: "bid_ask",
    bin_range: { min: 100, max: 200 }, amount_sol: 1, active_bin: 150,
    bin_step: 100, volatility: 4, fee_tvl_ratio: 1, organic_score: 80, initial_value_usd: 100,
  });
  state.queuePeakConfirmation(P2, 6, { immediate: true });
  const e2 = state.updatePnlAndCheckExits(P2, data(0.5, false), mgmt);
  check("peak 6%, PnL +0.5% (out of range) → TRAILING_TP, queued", e2?.action === "TRAILING_TP" && state.queueTrailingDropConfirmation(P2, e2.peak_pnl_pct, e2.current_pnl_pct, e2.effective_drop_pct, e2.in_range_exit) === true, JSON.stringify(e2));
  check("DexScreener +1.58% with queued PnL +0.5% → cancel, as before", verdict(1.58, state.getTrackedPosition(P2).pending_trailing_current_pnl_pct) === "cancel");
  check("the pending state stays set after a cancel (known quirk in the profit zone, not changed here): the same PnL is not queued again", state.queueTrailingDropConfirmation(P2, e2.peak_pnl_pct, e2.current_pnl_pct, e2.effective_drop_pct, e2.in_range_exit) === false);

  console.log("\n[4] index.js uses the verdict");
  const src = fs.readFileSync("./index.js", "utf8");
  const fnStart = src.indexOf("function scheduleTrailingDropConfirmation");
  const fnEnd = src.indexOf("export async function runBriefing");
  const fn = src.slice(fnStart, fnEnd);
  check("trailingRecheckPriceVerdict is imported from state.js", /import \{[^}]*\btrailingRecheckPriceVerdict\b[^}]*\} from "\.\/state\.js"/.test(src));
  check("the recheck calls it with the 5m change and the queued PnL", /trailingRecheckPriceVerdict\(md\?\.price_change_5m, tracked\.pending_trailing_current_pnl_pct\)/.test(fn), fn.slice(0, 200));
  check("'cancel' logs the cancel line and returns", /verdict === "cancel"\) \{\s*log\("state", `\[Trailing recheck\] Price recovering \([^`]*cancelling trailing exit for \$\{positionAddress\}`\);\s*return;\s*\}/.test(fn));
  check("'ignored' logs a line that says so and does not return", /verdict === "ignored"\) \{\s*log\("state", `\[Trailing recheck\] Price recovering \([^`]*ignored: queued PnL[^`]*the PnL recheck decides for \$\{positionAddress\}`\);\s*\}/.test(fn));
  check("no unconditional 'price_change_5m > 0' cancel is left in the recheck", fn.includes("price_change_5m > 0") === false);
  check("the PnL recheck still follows (resolvePendingTrailingDrop after the check)", fn.indexOf("trailingRecheckPriceVerdict(") < fn.indexOf("resolvePendingTrailingDrop("));
} finally {
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else fs.rmSync(STATE_FILE, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
