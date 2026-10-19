// Verifies the record-only shadow break-even (state.js updatePnlAndCheckExits, `be_probe`).
// Live breakEvenTriggerPct is 5: trailing (trigger 3) always closes first, so break-even never closed a
// position (Oct: 82 activations, 0 "Rule 1: break-even" closes) and peaks of 1–3% had no protection
// (20 stop losses in 14 days). For levels 1/2/3 the probe stores the first PnL <= 0 reading after the
// peak reached the level — the reading Rule 1 would close on. It must not change any exit.
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
  const mgmt = { ...config.management, breakEvenTriggerPct: 5, trailingTriggerPct: 3, trailingDropPct: 3 }; // live values

  const open = (addr) => state.trackPosition({
    position: addr, pool: `Pool-${addr}`, pool_name: "PROBE-SOL", strategy: "bid_ask",
    bin_range: { min: 100, max: 170 }, amount_sol: 1, active_bin: 165,
    bin_step: 100, volatility: 3, fee_tvl_ratio: 1, organic_score: 80, initial_value_usd: 100,
  });
  const dropProbe = (addr) => { // a position tracked before this change has no be_probe
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    delete s.positions[addr].be_probe;
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  };
  const data = (pnl, { inRange = true, above = false, suspicious = false } = {}) => ({
    pnl_pct: pnl,
    pnl_pct_suspicious: suspicious,
    in_range: inRange && !above,
    active_bin: above ? 180 : 150, lower_bin: 100, upper_bin: 170,
    age_minutes: 120,
    total_value_usd: 100, collected_fees_usd: 0, unclaimed_fees_usd: 1, fee_per_tvl_24h: 20,
  });
  const probe = (addr) => state.getTrackedPosition(addr)?.be_probe;

  console.log("\n[1] peak 1.5%, then PnL -0.4% in range");
  const A = "ProbeA111111111111111111111111111111111111";
  const A0 = "ProbeA0" + "1".repeat(37); // twin without be_probe, for the no-behavior-change check
  open(A); open(A0); dropProbe(A0);
  check("new position starts with an empty be_probe", JSON.stringify(state.getTrackedPosition(A)?.be_probe) === "{}");
  const steps = [];
  const run = (pnl, opts) => {
    const a = state.updatePnlAndCheckExits(A, data(pnl, opts), mgmt);
    const b = state.updatePnlAndCheckExits(A0, data(pnl, opts), mgmt);
    steps.push([JSON.stringify(a), JSON.stringify(b)]);
    return a;
  };
  state.queuePeakConfirmation(A, 1.5, { immediate: true });
  state.queuePeakConfirmation(A0, 1.5, { immediate: true });
  run(1.2);
  check("level 1 armed at peak 1.5", probe(A)?.["1"]?.armed_at != null && probe(A)["1"].hit_at == null, JSON.stringify(probe(A)));
  check("levels 2 and 3 not armed", probe(A)?.["2"] == null && probe(A)?.["3"] == null);
  run(-0.4);
  check("first PnL <= 0 stored: hit_pnl -0.4, in range", probe(A)["1"].hit_pnl === -0.4 && probe(A)["1"].hit_in_range === true && probe(A)["1"].hit_at != null, JSON.stringify(probe(A)["1"]));
  check("hit_depth_pct 28.6 (bin 150 of 100..170)", probe(A)["1"].hit_depth_pct === 28.6, JSON.stringify(probe(A)["1"]));
  check("real break-even is not armed at peak 1.5 (live trigger 5)", state.getTrackedPosition(A)?.break_even_active === false);

  console.log("\n[2] deeper reading does not overwrite the first hit");
  run(-2);
  check("hit_pnl stays -0.4", probe(A)["1"].hit_pnl === -0.4);

  console.log("\n[3] peak rises to 3.2%, then PnL -0.1%");
  state.queuePeakConfirmation(A, 3.2, { immediate: true });
  state.queuePeakConfirmation(A0, 3.2, { immediate: true });
  run(2.9);
  check("levels 2 and 3 armed", probe(A)["2"]?.armed_at != null && probe(A)["3"]?.armed_at != null);
  run(-0.1);
  check("levels 2 and 3 hit at -0.1", probe(A)["2"].hit_pnl === -0.1 && probe(A)["3"].hit_pnl === -0.1, JSON.stringify(probe(A)));
  check("level 1 unchanged at -0.4", probe(A)["1"].hit_pnl === -0.4);

  console.log("\n[4] probe never changes an exit");
  check("same return value as the twin without be_probe at every step", steps.every(([a, b]) => a === b), JSON.stringify(steps));
  check("twin never gets a be_probe", state.getTrackedPosition(A0)?.be_probe === undefined);

  console.log("\n[5] arming follows the real break-even: not while OOR ABOVE");
  const B = "ProbeB111111111111111111111111111111111111";
  open(B);
  state.queuePeakConfirmation(B, 2.5, { immediate: true });
  state.updatePnlAndCheckExits(B, data(2.4, { above: true }), mgmt);
  check("no probe armed while OOR ABOVE", Object.keys(probe(B) ?? {}).length === 0, JSON.stringify(probe(B)));
  state.updatePnlAndCheckExits(B, data(2.0), mgmt);
  check("armed once back in range (levels 1 and 2)", probe(B)?.["1"]?.armed_at != null && probe(B)?.["2"]?.armed_at != null && probe(B)?.["3"] == null);

  console.log("\n[6] arm and hit in the same reading");
  const C = "ProbeC111111111111111111111111111111111111";
  open(C);
  state.queuePeakConfirmation(C, 1.1, { immediate: true });
  state.updatePnlAndCheckExits(C, data(-0.3, { inRange: false }), mgmt);
  check("armed and hit at -0.3, out of range", probe(C)?.["1"]?.hit_pnl === -0.3 && probe(C)["1"].hit_in_range === false, JSON.stringify(probe(C)));

  console.log("\n[7] unusable readings are ignored");
  const D = "ProbeD111111111111111111111111111111111111";
  open(D);
  state.queuePeakConfirmation(D, 1.8, { immediate: true });
  state.updatePnlAndCheckExits(D, data(-100, { suspicious: true }), mgmt);
  check("suspicious reading: nothing recorded", Object.keys(probe(D) ?? {}).length === 0, JSON.stringify(probe(D)));
  state.updatePnlAndCheckExits(D, data(null), mgmt);
  check("null PnL: nothing recorded", Object.keys(probe(D) ?? {}).length === 0);

  console.log("\n[8] depth at the hit when the bins are unknown");
  const E = "ProbeE111111111111111111111111111111111111";
  open(E);
  state.queuePeakConfirmation(E, 1.4, { immediate: true });
  const eData = data(-0.2);
  delete eData.lower_bin;
  state.updatePnlAndCheckExits(E, eData, mgmt);
  check("hit recorded, hit_depth_pct null", probe(E)?.["1"]?.hit_pnl === -0.2 && probe(E)["1"].hit_depth_pct === null, JSON.stringify(probe(E)));

  console.log("\n[9] carried into the performance record");
  const dlmmSrc = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  check("both recordPerformance calls (relay + SDK) carry be_probe",
    (dlmmSrc.match(/be_probe:\s+tracked\.be_probe\s+\?\? null/g) || []).length === 2);
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else fs.rmSync(STATE_FILE, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
