// Verifies the entry flow filter's classifier (computeCandidateFlow) so the screener drops
// bearish-flow candidates (DISTRIBUTION) before the LLM. Importing index.js is safe — the isMain
// guard prevents cron startup — but agent.js instantiates an OpenAI client at import, so we set a
// dummy key first (same pattern as test-briefing.mjs).
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  const { computeCandidateFlow } = await import("../index.js");
  const { config } = await import("../config.js");

  // Helper to build md with a given price direction + volume expansion across timeframes.
  const md = ({ pc5, pc1h, pc6h, v5m, v1h, v6h, v24h }) => ({
    price_change_5m: pc5, price_change_1h: pc1h, price_change_6h: pc6h,
    volume_5m: v5m, volume_1h: v1h, volume_6h: v6h, volume_24h: v24h,
  });

  console.log("\n[1] flow classification");
  // DISTRIBUTION: price falling on ALL tf + volume expanding (vr > 1.1 on each).
  // vr5m = v5m/(v1h/12); need >1.1 → v5m=200, v1h=1200 → 200/100=2.0 ✓
  // vr1h = v1h/(v6h/6);  v1h=1200, v6h=3600 → 1200/600=2.0 ✓
  // vr6h = v6h/(v24h/4); v6h=3600, v24h=7200 → 3600/1800=2.0 ✓
  const distribution = md({ pc5: -2, pc1h: -3, pc6h: -5, v5m: 200, v1h: 1200, v6h: 3600, v24h: 7200 });
  check("falling price + expanding volume → DISTRIBUTION", computeCandidateFlow({}, distribution) === "DISTRIBUTION",
    computeCandidateFlow({}, distribution));

  // MARKUP: rising price + expanding volume.
  const markup = md({ pc5: 2, pc1h: 3, pc6h: 5, v5m: 200, v1h: 1200, v6h: 3600, v24h: 7200 });
  check("rising price + expanding volume → MARKUP", computeCandidateFlow({}, markup) === "MARKUP",
    computeCandidateFlow({}, markup));

  // CAPITULATION: falling price + contracting volume (vr <= 1.1).
  // v5m=50, v1h=1200 → 50/100=0.5; v1h=1200,v6h=12000 → 1200/2000=0.6; v6h=1000,v24h=48000 → 1000/12000=0.08
  const capitulation = md({ pc5: -2, pc1h: -3, pc6h: -5, v5m: 50, v1h: 1200, v6h: 1000, v24h: 48000 });
  check("falling price + contracting volume → CAPITULATION", computeCandidateFlow({}, capitulation) === "CAPITULATION",
    computeCandidateFlow({}, capitulation));

  // NEUTRAL fail-safe: no md.
  check("missing md → NEUTRAL (fail-safe)", computeCandidateFlow({}, null) === "NEUTRAL");
  check("flat price → NEUTRAL", computeCandidateFlow({}, md({ pc5: 0, pc1h: 0, pc6h: 0, v5m: 1, v1h: 1, v6h: 1, v24h: 1 })) === "NEUTRAL");

  console.log("\n[2] filter decision logic (mirrors index.js callback)");
  // Reproduce the block decision used in the screener callback.
  function wouldDrop(pool, marketData) {
    if (!config.screening.entryFlowFilterEnabled) return false;
    const block = new Set(config.screening.entryFlowBlockRegimes ?? ["DISTRIBUTION"]);
    const consensus = computeCandidateFlow(pool, marketData);
    if (!block.has(consensus)) return false;
    const smartPresent = (Number(pool?.gmgn_smart_wallets) || 0) > 0;
    return !(config.screening.entryFlowFilterSmartMoneyOverride && smartPresent);
  }

  check("default config enables filter", config.screening.entryFlowFilterEnabled === true);
  check("default blocks DISTRIBUTION only", JSON.stringify(config.screening.entryFlowBlockRegimes) === JSON.stringify(["DISTRIBUTION"]));
  check("DISTRIBUTION candidate dropped", wouldDrop({}, distribution) === true);
  check("MARKUP candidate kept", wouldDrop({}, markup) === false);
  check("CAPITULATION kept by default (not in block list)", wouldDrop({}, capitulation) === false);
  check("DISTRIBUTION + smart wallets → kept (override)", wouldDrop({ gmgn_smart_wallets: 3 }, distribution) === false);

  // Tightened config: add CAPITULATION.
  config.screening.entryFlowBlockRegimes = ["DISTRIBUTION", "CAPITULATION"];
  check("CAPITULATION dropped when added to block list", wouldDrop({}, capitulation) === true);

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
