// Verifies price_vs_ath_pct (OKX price as % of ATH) is recorded in each position's
// signal_snapshot so closed-position performance can later be grouped by distance to ATH
// before turning on athFilterPct. Record-only: it must not become a Darwin weight.
// Real signal-tracker import + source drift checks for the deploy → close path.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

try {
  console.log("\n[1] staged signals keep price_vs_ath_pct (real import)");
  const { stageSignals, getAndClearStagedSignals } = await import("../signal-tracker.js");
  stageSignals("TestPool111", { base_mint: "TestMint111", organic_score: 70, price_vs_ath_pct: 62.5 });
  const got = getAndClearStagedSignals("TestPool111", "TestMint111");
  check("round trip returns price_vs_ath_pct", got?.price_vs_ath_pct === 62.5, `(got ${JSON.stringify(got)})`);
  stageSignals("TestPool222", { base_mint: "TestMint222", price_vs_ath_pct: null });
  check("missing OKX data stays null", getAndClearStagedSignals("TestPool222")?.price_vs_ath_pct === null);

  console.log("\n[2] deploy → close wiring (drift)");
  check("screening stages price_vs_ath_pct from the candidate",
    src("index.js").includes("price_vs_ath_pct: pool.price_vs_ath_pct ?? null,"));
  check("deploy stores the whole staged snapshot on the tracked position",
    src("tools/dlmm.js").includes("signal_snapshot: signalSnapshot,") && src("state.js").includes("signal_snapshot: signal_snapshot || null,"));
  check("close carries the tracked snapshot into the performance record",
    src("tools/dlmm.js").includes("...(tracked?.signal_snapshot || {}),") && src("lessons.js").includes("const snapshot = { ...(perf.signal_snapshot || {}) };"));
  check("not a Darwin weight (signal-weights.js untouched)", !src("signal-weights.js").includes("price_vs_ath_pct"));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
