// Verifies the record-only shadow stop (state.js updatePnlAndCheckExits, `sl_probe`).
// Peaks of 1–3% have almost no protection (break-even arms at 5, trailing at 3), and the 2026-10-17
// estimate of what a -3% stop would have saved came from pool-memory snapshots biased toward stops.
// For levels 3 and 5 the probe stores the first reading at PnL <= -level once the position is old enough
// for the real stop loss, with the peak so far, the age, the fee so far and the in-range flag. It must
// not change any exit. Real module round-trip; backs up + restores state.json.
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
  const mgmt = { ...config.management, minAgeBeforeStopLoss: 15, allowLlmRiskParams: true, breakEvenTriggerPct: 5, trailingTriggerPct: 3, trailingDropPct: 3 };

  const open = (addr) => state.trackPosition({
    position: addr, pool: `Pool-${addr}`, pool_name: "SLPROBE-SOL", strategy: "bid_ask",
    bin_range: { min: 100, max: 170 }, amount_sol: 1, active_bin: 165,
    bin_step: 100, volatility: 3, fee_tvl_ratio: 1, organic_score: 80, initial_value_usd: 100,
    sl_pct_override: -12,
  });
  const edit = (addr, fn) => {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    fn(s.positions[addr]);
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  };
  const data = (pnl, { age = 120, inRange = true, suspicious = false, collected = 0.4, unclaimed = 0.85 } = {}) => ({
    pnl_pct: pnl,
    pnl_pct_suspicious: suspicious,
    in_range: inRange,
    active_bin: inRange ? 150 : 90, lower_bin: 100, upper_bin: 170,
    age_minutes: age,
    total_value_usd: 100, collected_fees_usd: collected, unclaimed_fees_usd: unclaimed, fee_per_tvl_24h: 20,
  });
  const probe = (addr) => state.getTrackedPosition(addr)?.sl_probe;
  const upd = (addr, pnl, opts) => state.updatePnlAndCheckExits(addr, data(pnl, opts), mgmt);

  console.log("\n[1] age gate, then the first reading at -3%");
  const A = "SlProbeA11111111111111111111111111111111111";
  open(A);
  check("new position starts with an empty sl_probe", JSON.stringify(probe(A)) === "{}");
  upd(A, -4, { age: 10 });
  check("below the age gate (10 < 15): nothing recorded", Object.keys(probe(A)).length === 0, JSON.stringify(probe(A)));
  upd(A, -2.9, { age: 15 });
  check("at the gate but above -3: nothing recorded", Object.keys(probe(A)).length === 0);
  upd(A, -4, { age: 15 });
  const a3 = probe(A)["3"];
  check("exactly at the gate (15): level 3 recorded with every field",
    a3 && a3.hit_pnl === -4 && a3.age_min === 15 && a3.peak === 0 && a3.fee_usd === 1.25 && a3.in_range === true && typeof a3.hit_at === "string",
    JSON.stringify(a3));
  check("level 5 not recorded at -4", probe(A)["5"] == null);

  console.log("\n[2] the first reading stays; level 5 is separate");
  upd(A, -9, { age: 40 });
  check("level 3 unchanged (hit_pnl -4, age 15)", probe(A)["3"].hit_pnl === -4 && probe(A)["3"].age_min === 15, JSON.stringify(probe(A)["3"]));
  check("level 5 recorded at -9, age 40", probe(A)["5"]?.hit_pnl === -9 && probe(A)["5"].age_min === 40, JSON.stringify(probe(A)["5"]));
  const before = JSON.stringify(probe(A));
  upd(A, -11, { age: 50 });
  check("a deeper reading changes nothing", JSON.stringify(probe(A)) === before);

  console.log("\n[3] boundary: -2.99 misses, exactly -3 counts");
  const B = "SlProbeB11111111111111111111111111111111111";
  open(B);
  upd(B, -2.99, { age: 60 });
  check("-2.99: nothing", Object.keys(probe(B)).length === 0);
  upd(B, -3, { age: 60 });
  check("-3: level 3 recorded, level 5 not", probe(B)["3"]?.hit_pnl === -3 && probe(B)["5"] == null);
  upd(B, -5, { age: 61 });
  check("-5: level 5 recorded", probe(B)["5"]?.hit_pnl === -5);

  console.log("\n[4] one deep reading fills both levels");
  const C = "SlProbeC11111111111111111111111111111111111";
  open(C);
  upd(C, -12.4, { age: 30 });
  check("both levels carry the same reading", probe(C)["3"]?.hit_pnl === -12.4 && probe(C)["5"]?.hit_pnl === -12.4, JSON.stringify(probe(C)));

  console.log("\n[5] the peak is the peak at the hit");
  const D = "SlProbeD11111111111111111111111111111111111";
  open(D);
  state.queuePeakConfirmation(D, 2.2, { immediate: true });
  upd(D, -3.4, { age: 90 });
  check("level 3 peak 2.2", probe(D)["3"]?.peak === 2.2, JSON.stringify(probe(D)));
  state.queuePeakConfirmation(D, 3.4, { immediate: true });
  upd(D, -5.5, { age: 95 });
  check("level 5 peak 3.4; level 3 keeps 2.2", probe(D)["5"]?.peak === 3.4 && probe(D)["3"].peak === 2.2, JSON.stringify(probe(D)));

  console.log("\n[6] fee, rounding and the in-range flag");
  const E = "SlProbeE11111111111111111111111111111111111";
  open(E);
  upd(E, -3.456, { age: 70, collected: 0.123, unclaimed: 0.456, inRange: false });
  check("fee_usd = collected + unclaimed rounded to 2 decimals (0.58); in_range false", probe(E)["3"]?.fee_usd === 0.58 && probe(E)["3"].in_range === false, JSON.stringify(probe(E)["3"]));
  check("hit_pnl rounded to 2 decimals (-3.456 -> -3.46)", probe(E)["3"]?.hit_pnl === -3.46, JSON.stringify(probe(E)["3"]));
  const E2 = "SlProbeE2111111111111111111111111111111111";
  open(E2);
  const e2data = data(-3.2, { age: 70 });
  delete e2data.collected_fees_usd; // key missing
  e2data.unclaimed_fees_usd = null; // key present but empty
  state.updatePnlAndCheckExits(E2, e2data, mgmt);
  check("missing or empty fee fields count as 0", probe(E2)["3"]?.fee_usd === 0, JSON.stringify(probe(E2)["3"]));

  console.log("\n[7] unusable readings and a missing age");
  const F = "SlProbeF11111111111111111111111111111111111";
  open(F);
  upd(F, -100, { suspicious: true });
  check("suspicious reading: nothing recorded", Object.keys(probe(F)).length === 0, JSON.stringify(probe(F)));
  state.updatePnlAndCheckExits(F, { ...data(-4), pnl_pct: null }, mgmt);
  check("null PnL: nothing recorded", Object.keys(probe(F)).length === 0);
  upd(F, -3.5, { age: null });
  check("age missing counts as passed (like the real stop loss); age_min null", probe(F)["3"]?.hit_pnl === -3.5 && probe(F)["3"].age_min === null, JSON.stringify(probe(F)["3"]));

  console.log("\n[8] the probe never changes an exit");
  const T = "SlProbeT11111111111111111111111111111111111";
  const T0 = "SlProbeT0" + "1".repeat(35); // twin without sl_probe
  open(T); open(T0);
  edit(T0, (p) => { delete p.sl_probe; });
  check("a position tracked before this change has no sl_probe", state.getTrackedPosition(T0)?.sl_probe === undefined);
  const steps = [];
  for (const [pnl, age] of [[1.2, 120], [-2, 120], [-3, 120], [-6, 125], [-13, 130], [-4, 135]]) {
    const a = JSON.stringify(upd(T, pnl, { age }));
    const b = JSON.stringify(upd(T0, pnl, { age }));
    steps.push([a, b]);
  }
  check("same return value as the twin without sl_probe at every step", steps.every(([a, b]) => a === b), JSON.stringify(steps));
  check("the sequence includes a STOP_LOSS (so the check covers a real exit)", steps.some(([a]) => a.includes("STOP_LOSS")), JSON.stringify(steps));
  check("the twin never gets an sl_probe", state.getTrackedPosition(T0)?.sl_probe === undefined);
  check("the tracked position did record its readings", probe(T)["3"]?.hit_pnl === -3 && probe(T)["5"]?.hit_pnl === -6, JSON.stringify(probe(T)));

  console.log("\n[9] a corrupt sl_probe cannot break an exit");
  const G = "SlProbeG11111111111111111111111111111111111";
  const G0 = "SlProbeG0" + "1".repeat(35);
  open(G); open(G0);
  edit(G, (p) => { p.sl_probe = 7; }); // a number: assigning a property to it throws in strict mode
  edit(G0, (p) => { delete p.sl_probe; });
  let threw = false;
  let ga, gb;
  try { ga = JSON.stringify(upd(G, -13, { age: 120 })); } catch { threw = true; }
  gb = JSON.stringify(upd(G0, -13, { age: 120 }));
  check("no exception and the same STOP_LOSS as the twin", threw === false && ga === gb && ga.includes("STOP_LOSS"), `${ga} | ${gb}`);
  check("the corrupt value is left alone", JSON.stringify(state.getTrackedPosition(G)?.sl_probe) === "7");

  console.log("\n[10] the age gate follows the real stop-loss setting");
  const H = "SlProbeH1" + "1".repeat(35);
  open(H);
  const mgmtDefault = { ...mgmt };
  delete mgmtDefault.minAgeBeforeStopLoss; // the real stop loss then uses 15
  state.updatePnlAndCheckExits(H, data(-4, { age: 14 }), mgmtDefault);
  check("no setting: default gate 15, so age 14 records nothing", Object.keys(probe(H)).length === 0, JSON.stringify(probe(H)));
  state.updatePnlAndCheckExits(H, data(-4, { age: 15 }), mgmtDefault);
  check("no setting: age 15 records", probe(H)["3"]?.age_min === 15, JSON.stringify(probe(H)));
  const H2 = "SlProbeH2" + "1".repeat(35);
  open(H2);
  const mgmt20 = { ...mgmt, minAgeBeforeStopLoss: 20 };
  state.updatePnlAndCheckExits(H2, data(-4, { age: 19 }), mgmt20);
  check("gate 20: age 19 records nothing", Object.keys(probe(H2)).length === 0);
  state.updatePnlAndCheckExits(H2, data(-4, { age: 20 }), mgmt20);
  check("gate 20: age 20 records", probe(H2)["3"]?.age_min === 20);

  console.log("\n[11] carried into the performance record");
  const dlmmSrc = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  check("both recordPerformance calls (relay + SDK) carry sl_probe",
    (dlmmSrc.match(/sl_probe:\s+tracked\.sl_probe\s+\?\? null/g) || []).length === 2);
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else fs.rmSync(STATE_FILE, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
