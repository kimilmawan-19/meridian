// Screener picks by fee_tvl first (CANDIDATE ORDER) without contradicting the other selection rules in the
// prompt/goal, and records what the fee/TVL prioritisation check needs (rank, TVL, 24h fee/TVL).
// Basis: 60-day data, top fee_tvl quintile +1.03 points PnL over the rest (bootstrap 90% 0.32..1.63), mostly bid_ask;
// 2026-10-02 activation data: fee comes from how far price travels into the range, not from how fast it starts.
// Real buildSystemPrompt + source drift checks on index.js.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

try {
  const { buildSystemPrompt } = await import("../prompt.js");
  const screener = buildSystemPrompt("SCREENER", {}, {}, null, null, null, "WEIGHTS SUMMARY LINE");
  const general = buildSystemPrompt("GENERAL", {}, {}, null, null, null, null);
  const goal = src("index.js");

  console.log("\n[1] CANDIDATE ORDER is in the SCREENER prompt");
  check("block present", /CANDIDATE ORDER/.test(screener));
  check("starts at the top and picks the first candidate without a skip signal", /Start at the top/.test(screener) && /first candidate with no skip signal/.test(screener));
  check("lists the existing skip signals instead of inventing new ones",
    /RISK SIGNALS above/.test(screener) && /POOL MEMORY/.test(screener) && /DISTRIBUTION\/CAPITULATION/.test(screener) && /AVOID lines/.test(screener));
  check("lower rank only when higher ones are skipped or within about 20% with smart wallets / better narrative",
    /every higher-ranked one has a skip signal/.test(screener) && /within about 20%/.test(screener));
  check("decides WHICH, not WHETHER (NO DEPLOY stays valid)", /WHICH candidate, not WHETHER/.test(screener) && /answer NO DEPLOY/.test(screener));
  check("a lower fee_tvl is not a skip reason", /never a reason to skip/.test(screener));
  check("user instruction still overrides", /direct user instruction always overrides this order/.test(screener));

  console.log("\n[2] no overlapping instruction left that ranks by something else");
  check("old 'highest-conviction' wording gone", !/highest-conviction/i.test(screener));
  check("narrative is no longer 'your main judgment call'", !/main judgment call/.test(screener) && /skip signal and tie-break, not the ranking key/.test(screener));
  check("signal weights only break ties", !/Prioritize candidates whose strongest/.test(screener) && /weights only to break ties/.test(screener));
  check("ideal/PREFER lines are declared tie-breaks", /only breaks ties\. It does not outrank fee_tvl/.test(screener));
  check("goal STEP 2 no longer ranks by narrative/smart wallets", !/Pick the best candidate based on narrative quality/.test(goal) && /Pick the candidate by CANDIDATE ORDER/.test(goal));
  check("goal STEP 1 (is anything worth deploying) kept", /Decide if any candidate is actually worth deploying/.test(goal));
  check("report asks for rank and fee_tvl", /start with its rank \(#k of n\) and fee_tvl/.test(goal));
  check("GENERAL prompt is unaffected", !/CANDIDATE ORDER/.test(general));

  console.log("\n[3] candidates carry their rank");
  check("each block states its rank", goal.includes("`POOL #${i + 1} of ${passing.length}: ${pool.name} (${pool.pool})`,"));
  check("one log line lists the order the LLM saw", goal.includes("Candidates (best first):"));
  check("the pick is logged with its rank when deploy starts", goal.includes("Screener pick: ${passing[k].pool.name} rank #${k + 1} of ${passing.length}"));

  console.log("\n[4] record-only fields reach the position's signal_snapshot (same path as price_vs_ath_pct)");
  for (const f of ["tvl: pool.tvl ?? pool.active_tvl ?? null,", "fee_tvl_24h: fee_tvl_24h ?? null,", "candidate_rank: i + 1,", "candidate_count: passing.length,", "top_fee_tvl: passing[0]?.pool?.fee_active_tvl_ratio ?? null,"])
    check(`stages ${f.split(":")[0]}`, goal.includes(f));
  check("24h detail fetched per candidate, fail-open", goal.includes('getPoolDetail({ pool_address: pool.pool, timeframe: "24h" })') && goal.includes("Number.isFinite(feeTvl24h) ? feeTvl24h : null"));
  const { stageSignals, getAndClearStagedSignals } = await import("../signal-tracker.js");
  stageSignals("PoolRank1", { base_mint: "MintRank1", fee_tvl_ratio: 1.2, tvl: 80000, fee_tvl_24h: 0.4, candidate_rank: 2, candidate_count: 5, top_fee_tvl: 1.9 });
  const snap = getAndClearStagedSignals("PoolRank1", "MintRank1");
  check("round trip keeps rank, count, tvl and 24h fee/TVL", snap?.candidate_rank === 2 && snap?.candidate_count === 5 && snap?.tvl === 80000 && snap?.fee_tvl_24h === 0.4 && snap?.top_fee_tvl === 1.9, JSON.stringify(snap));
  check("none of them is a Darwin weight", !/candidate_rank|top_fee_tvl|fee_tvl_24h|\btvl\b/.test(src("signal-weights.js")));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
