// Record-only 4h/12h breadth and volume trend in the market regime assessment (2026-10-05).
// Meteora has no 6h timeframe, so 4h and 12h bracket it. Nothing here may change the score or the regime.
// Real assessMarketRegime with a stubbed fetch.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

try {
  const { assessMarketRegime, summarizeLongTimeframe } = await import("../market-regime.js");

  console.log("\n[1] summarizeLongTimeframe");
  const mk = (n, up, vc) => Array.from({ length: n }, (_, i) => ({ pool_price_change_pct: i < up ? 1 : -1, volume_change_pct: vc }));
  const s = summarizeLongTimeframe(mk(50, 20, -10));
  check("breadth is the share of positive pools", s?.breadth === 40, JSON.stringify(s));
  check("volume change is the mean", s?.volChange === -10, JSON.stringify(s));
  check("under 10 pools gives null", summarizeLongTimeframe(mk(9, 5, 0)) === null);
  check("not an array gives null", summarizeLongTimeframe(undefined) === null);

  console.log("\n[2] the score does not depend on the 4h/12h data");
  const realFetch = globalThis.fetch;
  const run = async (longMode) => {
    globalThis.fetch = async (url) => {
      const tf = String(url).match(/timeframe=([^&]+)/)?.[1];
      if ((tf === "4h" || tf === "12h")) {
        if (longMode === "fail") return { ok: false, status: 500, statusText: "x", json: async () => ({}) };
        return { ok: true, json: async () => ({ data: mk(50, 5, -60) }) };
      }
      return { ok: true, json: async () => ({ data: mk(50, tf === "5m" ? 10 : 15, -30) }) };
    };
    return assessMarketRegime([], null);
  };
  const a = await run("ok");
  const b = await run("fail");
  globalThis.fetch = realFetch;
  check("same score with and without long-timeframe data", a.score === b.score && a.regime === b.regime, `${a.score}/${a.regime} vs ${b.score}/${b.regime}`);
  check("breadth 4h and 12h are recorded", a.signals.longTf?.["4h"]?.breadth === 10 && a.signals.longTf?.["12h"]?.breadth === 10, JSON.stringify(a.signals.longTf));
  check("volume change is recorded", a.signals.longTf?.["4h"]?.volChange === -60, JSON.stringify(a.signals.longTf));
  check("a failed fetch records null and does not throw", b.signals.longTf?.["4h"] === null && b.regime !== "unknown", JSON.stringify(b.signals.longTf));
} catch (e) {
  fail++; console.log("  ✗ threw", e.stack || e);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
