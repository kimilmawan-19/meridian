// The deploy_position tool description must agree with the executor's strategy guard.
// Live 2026-09-25..10-02: 61 of 85 SAFETY_BLOCKs were the LLM following stale text
// ("Never use 'curve'", "bid_ask or spot"): 42 curve-required, 19 spot. Each cost an LLM round-trip.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

try {
  const { tools } = await import("../tools/definitions.js");
  const { config } = await import("../config.js");
  const d = tools.find((t) => t.function?.name === "deploy_position").function;
  const text = d.description;

  console.log("\n[1] description agrees with the executor");
  check("no longer forbids curve", !/never use ['"]?curve/i.test(text));
  check("no longer offers spot as a choice", !/bid_ask or spot/i.test(text));
  check("states the live curveMaxVolatility threshold", text.includes(`volatility <= ${config.strategy?.curveMaxVolatility ?? 3.5}`), text.match(/Strategy follows[^\n]*/)?.[0]);
  check("says never spot", /Never use "spot"/.test(text));
  check("mentions the bullish-cluster exception", /bullish/.test(text) && /1\.5/.test(text));
  check("does not defer to a saved strategy's lp_strategy", !/use the active strategy's lp_strategy/i.test(text));

  console.log("\n[2] parameter schema unchanged");
  check("strategy enum is curve/bid_ask", JSON.stringify(d.parameters.properties.strategy.enum) === '["curve","bid_ask"]');
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
