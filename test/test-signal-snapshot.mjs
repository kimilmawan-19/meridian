// Verifies price_vs_ath_pct (OKX price as % of ATH) plus the flow/transaction fields the screener
// sees (flow_consensus, 5m buys/sells, net_buyers_1h) are recorded in each position's
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
  for (const f of ["flow_consensus: md ? regimeConsensus : null,", "txn_buys_5m: md?.txn_buys_5m ?? null,", "txn_sells_5m: md?.txn_sells_5m ?? null,", "net_buyers_1h: netBuyers ?? null,"])
    check(`screening stages ${f.split(":")[0]}`, src("index.js").includes(f));
  console.log("\n[3] audit fields for evaluating the hard filters (record-only)");
  for (const f of ["top10_pct: ti?.audit?.top_holders_pct ?? null,", "bot_holders_pct: ti?.audit?.bot_holders_pct ?? null,", "bundle_pct: pool.bundle_pct ?? null,",
    "token_fees_sol: ti?.global_fees_sol ?? null,", "token_age_hours: pool.token_age_hours ?? null,", "active_pct: pool.active_pct ?? null,",
    "unique_traders: pool.unique_traders ?? null,", "regime_at_entry: config.marketRegime?._activeRegime ?? null,"])
    check(`screening stages ${f.split(":")[0]}`, src("index.js").includes(f));
  stageSignals("AuditPool1", { base_mint: "AuditMint1", top10_pct: 22.5, bot_holders_pct: 20.7, bundle_pct: 8, token_fees_sol: 158, token_age_hours: 96, active_pct: 41.2, unique_traders: 130, regime_at_entry: "caution" });
  const audit = getAndClearStagedSignals("AuditPool1", "AuditMint1");
  check("round trip keeps all eight audit fields", audit?.top10_pct === 22.5 && audit?.bot_holders_pct === 20.7 && audit?.bundle_pct === 8 && audit?.token_fees_sol === 158
    && audit?.token_age_hours === 96 && audit?.active_pct === 41.2 && audit?.unique_traders === 130 && audit?.regime_at_entry === "caution", JSON.stringify(audit));
  check("none of them is a Darwin weight", !/top10_pct|bot_holders_pct|bundle_pct|token_fees_sol|token_age_hours|active_pct|unique_traders|regime_at_entry/.test(src("signal-weights.js")));
  check("not Darwin weights (signal-weights.js untouched)",
    !/price_vs_ath_pct|flow_consensus|txn_buys_5m|net_buyers_1h/.test(src("signal-weights.js")));

  console.log("\n[4] fields added 2026-10-19 (record-only, data already fetched)");
  const NEW = ["price_change_1h: md?.price_change_1h ?? null,", "price_change_6h: md?.price_change_6h ?? null,", "liquidity_usd: md?.liquidity_usd ?? null,",
    "long_volume_change_pct: pool.long_volume_change_pct ?? null,", "buy_vol_1h: numOrNull(ti?.stats_1h?.buy_vol),", "sell_vol_1h: numOrNull(ti?.stats_1h?.sell_vol),",
    "organic_buyers_1h: numOrNull(ti?.stats_1h?.buyers),", "net_buyers_24h: numOrNull(ti?.stats_24h_net_buyers),"];
  for (const f of NEW) check(`screening stages ${f.split(":")[0]}`, src("index.js").includes(f));
  stageSignals("NewPool1", { base_mint: "NewMint1", price_change_1h: -4.2, price_change_6h: -18.5, liquidity_usd: 41250, long_volume_change_pct: -62.1,
    buy_vol_1h: 12000, sell_vol_1h: 15500, organic_buyers_1h: 37, net_buyers_24h: -12 });
  const nw = getAndClearStagedSignals("NewPool1", "NewMint1");
  check("round trip keeps all eight new fields", nw?.price_change_1h === -4.2 && nw?.price_change_6h === -18.5 && nw?.liquidity_usd === 41250 && nw?.long_volume_change_pct === -62.1
    && nw?.buy_vol_1h === 12000 && nw?.sell_vol_1h === 15500 && nw?.organic_buyers_1h === 37 && nw?.net_buyers_24h === -12, JSON.stringify(nw));
  check("none of them is a Darwin weight",
    !/price_change_1h|price_change_6h|liquidity_usd|long_volume_change_pct|buy_vol_1h|sell_vol_1h|organic_buyers_1h|net_buyers_24h/.test(src("signal-weights.js")));
  const idx = src("index.js");
  const helper = idx.slice(idx.indexOf("function numOrNull("), idx.indexOf("function tfFlowRegime("));
  const numOrNull = new Function(`${helper}; return numOrNull;`)();
  check("numOrNull: numeric strings become numbers (token.js uses toFixed)", numOrNull("12345") === 12345 && numOrNull("-3") === -3);
  check("numOrNull: null, undefined, empty and non-numeric become null (not 0)",
    numOrNull(null) === null && numOrNull(undefined) === null && numOrNull("") === null && numOrNull("abc") === null && numOrNull(NaN) === null);
  const scr = src("tools/screening.js");
  check("condensePool passes long_volume_change_pct through", /long_volume_change_pct: p\.long_volume_change_pct \?\? null/.test(scr));
  const volStart = scr.indexOf("if (config.screening.filterDecliningVolume)");
  const volEnd = scr.indexOf("Volume filter (record-only): would drop");
  const volBlock = volStart >= 0 && volEnd > volStart ? scr.slice(volStart, scr.indexOf("\n    }\n", volEnd)) : "";
  check("declining-volume check only logs: no splice, no filter, no filtered reason",
    volBlock.length > 0 && !/splice|\.filter\(|pushFilteredReason|return false/.test(volBlock), volBlock);
  check("the old drop path is gone", !scr.includes("Volume filter: dropped") && !scr.includes("volume collapsing"));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
