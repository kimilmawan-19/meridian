// The caution "quality bar" now matches what it really did. Before: minOrganic +10, minMcap ×2 and minTokenAge 72h
// were raised after the candidates were already fetched, so they never filtered anything; only fee/TVL ×1.4 acted
// (at deploy, via the executor), which let the LLM be offered candidates the executor then blocked.
// Data (diag-filters.mjs, 60 days): the positions that bar would have removed made +1.10% (n=25, negative in only
// 30% of resamples) and caution deploys beat healthy ones (+1.19% vs +0.45%), so the dead raises were removed.
// Real dropBelowFeeFloor + config import; source drift checks for the cycle wiring.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

try {
  const { dropBelowFeeFloor } = await import("../tools/screening.js");
  const { config } = await import("../config.js");

  console.log("\n[1] dropBelowFeeFloor (real import)");
  const pools = [{ name: "A", fee_active_tvl_ratio: 0.2 }, { name: "B", fee_active_tvl_ratio: 0.1 }, { name: "C", fee_active_tvl_ratio: 0.126 }, { name: "D", fee_active_tvl_ratio: null }, { name: "E" }];
  const r = dropBelowFeeFloor(pools, 0.126);
  check("below the floor is dropped", r.dropped.map((p) => p.name).join() === "B", JSON.stringify(r.dropped));
  check("exactly at the floor stays", r.kept.some((p) => p.name === "C"));
  check("missing fee data stays (fail-open)", r.kept.some((p) => p.name === "D") && r.kept.some((p) => p.name === "E"));
  check("order of kept candidates is preserved (fee/TVL ranking)", r.kept.map((p) => p.name).join() === "A,C,D,E");
  check("healthy floor 0.09 drops nothing the API already returned", dropBelowFeeFloor([{ fee_active_tvl_ratio: 0.09 }, { fee_active_tvl_ratio: 1.2 }], 0.09).dropped.length === 0);
  check("a non-numeric floor is a no-op", dropBelowFeeFloor(pools, undefined).dropped.length === 0);
  check("caution floor 0.09 × 1.4 = 0.126", +(0.09 * 1.4).toFixed(4) === 0.126);

  console.log("\n[2] the dead raises are gone");
  const idx = src("index.js");
  for (const dead of ["_cautionOrigOrganic", "_cautionOrigMinTokenAgeHours", "_cautionOrigMinMcap", "cautionMinTokenAgeHours", "cautionMinMcapMult", "config.screening.minOrganic = Math.min(85"])
    check(`index.js no longer has ${dead}`, !idx.includes(dead));
  check("config no longer defines the two caution floors", config.marketRegime.cautionMinTokenAgeHours === undefined && config.marketRegime.cautionMinMcapMult === undefined);
  check("update_config no longer maps them", !src("tools/executor.js").includes("cautionMinTokenAgeHours") && !src("tools/executor.js").includes("cautionMinMcapMult"));

  console.log("\n[3] what stays: fee/TVL ×1.4 for the cycle, restored in finally");
  check("fee floor raised ×1.4 in caution", idx.includes("config.screening.minFeeActiveTvlRatio = +(_cautionOrigFeeRatio * 1.4).toFixed(4);"));
  check("fee floor restored in finally", idx.includes("config.screening.minFeeActiveTvlRatio = _cautionOrigFeeRatio;"));

  console.log("\n[4] the floor also applies to candidates before recon (no LLM round-trip on a blocked pick)");
  const floorAt = idx.indexOf("dropBelowFeeFloor(candidates, config.screening.minFeeActiveTvlRatio)");
  const regimeAt = idx.indexOf("assessMarketRegime(candidates");
  const loopAt = idx.indexOf("for (const pool of candidatesAboveFloor)");
  check("applied after the regime block and before the recon loop", regimeAt > 0 && floorAt > regimeAt && loopAt > floorAt, `regime ${regimeAt} floor ${floorAt} loop ${loopAt}`);
  check("recon loop iterates the filtered list", loopAt > 0 && !idx.includes("for (const pool of candidates) {\n      const mint"));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
