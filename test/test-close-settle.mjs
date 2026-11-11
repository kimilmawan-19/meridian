// Verifies the record-only close settlement lines (see CLAUDE.md, "Close settlement log").
//  - buildCloseSettle (tools/wallet.js): pure, a missing number stays null, never throws.
//  - buildCloseFigures (tools/dlmm.js): numbers only, never throws, long results keep only `total`.
//  - logCloseSettle (tools/executor.js): writes one [CLOSE_SETTLE] line, reads the wallet once more
//    only after a swap, never throws and never changes the close result.
//  - source guards for the wiring inside close_position / closePosition (they need a wallet, the SDK
//    and an RPC, so they are not run whole).
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-settle-"));
process.chdir(tmp);
const repo = new URL("..", import.meta.url);
const { Keypair } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL ||= "http://127.0.0.1:9";
process.env.HELIUS_API_KEY = "test-helius";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const { buildCloseSettle } = await import(new URL("tools/wallet.js", repo).href);
const { buildCloseFigures } = await import(new URL("tools/dlmm.js", repo).href);
const { logCloseSettle } = await import(new URL("tools/executor.js", repo).href);
const NOW = new Date("2026-11-11T12:00:00.000Z");

console.log("[1] buildCloseSettle: a swapped close");
const bal0 = { sol: 2, sol_price: 90, tokens: [] };
const bal1 = { sol: 2.5, sol_price: 90.5 };
const swap = { success: true, tx: "TXSIG", amount_out: "500123456", fee_bps_applied: 10 };
let d = buildCloseSettle({ position: "POS", pool_name: "ABC-SOL", base_mint: "MINT", outcome: "swapped", closeResult: { pnl_usd: -3.5, pnl_pct: -2.1 }, token: { balance: 1000, usd: 46.2 }, balances: bal0, balancesAfter: bal1, swapResult: swap }, NOW);
check("timestamp and ids", d.at === "2026-11-11T12:00:00.000Z" && d.position === "POS" && d.pool_name === "ABC-SOL" && d.base_mint === "MINT" && d.outcome === "swapped");
check("close figures", d.pnl_usd === -3.5 && d.pnl_pct === -2.1);
check("token balance and mark", d.token_balance === 1000 && d.token_usd === 46.2);
check("SOL price is the one before the swap", d.sol_usd === 90);
check("SOL before, after and change", d.sol_before_swap === 2 && d.sol_after_swap === 2.5 && d.sol_change === 0.5);
check("out_sol is raw lamports / 1e9", d.out_sol === 0.500123456, String(d.out_sol));
check("fee and net output", d.fee_bps === 10 && d.out_sol_net === 0.499623333, String(d.out_sol_net));
check("swap tx kept, no error", d.swap_tx === "TXSIG" && d.error === null);

console.log("[2] gaps never read as zero");
d = buildCloseSettle({ position: "P", outcome: "skipped_small", closeResult: { pnl_usd: 1, pnl_pct: 0.5 }, token: { balance: 5, usd: 0.04 }, balances: bal0 }, NOW);
check("no swap: swap fields are null", d.swap_tx === null && d.out_sol === null && d.fee_bps === null && d.out_sol_net === null && d.sol_after_swap === null && d.sol_change === null);
check("no swap: before-values still shown", d.sol_before_swap === 2 && d.sol_usd === 90 && d.token_usd === 0.04);
d = buildCloseSettle({ position: "P", outcome: "swapped", balances: bal0, balancesAfter: { error: "Helius API error: 500", sol: 0 }, swapResult: swap }, NOW);
check("wallet read after the swap failed: null, not 0", d.sol_after_swap === null && d.sol_change === null && d.sol_before_swap === 2);
d = buildCloseSettle({ position: "P", outcome: "swapped", balances: { error: "x", sol: 0, sol_price: 0 }, balancesAfter: bal1, swapResult: swap }, NOW);
check("wallet read before failed: no before, no price, no change", d.sol_before_swap === null && d.sol_usd === null && d.sol_change === null && d.sol_after_swap === 2.5);
d = buildCloseSettle({ position: "P", outcome: "swapped", balances: bal0, balancesAfter: bal1, swapResult: { success: true, tx: "T", amount_out: "1000000000" } }, NOW);
check("unknown fee: gross output kept, net is null", d.out_sol === 1 && d.fee_bps === null && d.out_sol_net === null);
d = buildCloseSettle({ position: "P", outcome: "swapped", balances: bal0, balancesAfter: bal1, swapResult: { success: true, tx: "T", amount_out: "1000000000", fee_bps_applied: 0 } }, NOW);
check("a real fee of 0 is kept as 0", d.fee_bps === 0 && d.out_sol_net === 1);
d = buildCloseSettle({ position: "P", outcome: "swapped", swapResult: { success: true, tx: "T", amount_out: "abc", fee_bps_applied: 10 } }, NOW);
check("non-numeric output is null", d.out_sol === null && d.out_sol_net === null);
d = buildCloseSettle({ position: "P", outcome: "failed", error: "Swap V2 order failed: 429", swapResult: { success: false, error: "x" } }, NOW);
check("failed swap: error kept, no output", d.outcome === "failed" && d.error === "Swap V2 order failed: 429" && d.out_sol === null);
d = buildCloseSettle({ position: "P", outcome: "failed", error: "e".repeat(500) }, NOW);
check("long error is cut", d.error.length === 120);
d = buildCloseSettle({ position: "P", outcome: "swapped", closeResult: { pnl_usd: null, pnl_pct: undefined } }, NOW);
check("null / undefined PnL stay null", d.pnl_usd === null && d.pnl_pct === null);
d = buildCloseSettle({ position: "P", outcome: "swapped", closeResult: { pnl_usd: 0, pnl_pct: 0 } }, NOW);
check("a real zero PnL is kept as 0", d.pnl_usd === 0 && d.pnl_pct === 0);
d = buildCloseSettle({}, NOW);
check("empty input: nothing throws, all null", d.position === null && d.outcome === null && d.sol_change === null);
d = buildCloseSettle(undefined, NOW);
check("undefined input does not throw", d.position === null);
d = buildCloseSettle({ position: "P", outcome: "swapped", balances: bal0, balancesAfter: { sol: 2 } }, NOW);
check("unchanged wallet gives a real 0 change", d.sol_change === 0);
d = buildCloseSettle({ position: "P" });
check("default clock is a valid ISO time", !Number.isNaN(Date.parse(d.at)));
check("every value is a number, a string or null", Object.values(buildCloseSettle({ position: "P", outcome: "swapped", closeResult: { pnl_usd: "1.5" }, token: { balance: "3", usd: "4" }, balances: bal0, balancesAfter: bal1, swapResult: swap }, NOW)).every((v) => v === null || typeof v === "number" || typeof v === "string"));
check("an empty string is a gap, not 0", buildCloseSettle({ closeResult: { pnl_usd: "", pnl_pct: "" }, token: { balance: "", usd: "" } }, NOW).pnl_usd === null && buildCloseSettle({ token: { balance: "" } }, NOW).token_balance === null);
check("string numbers are converted", buildCloseSettle({ closeResult: { pnl_usd: "1.5" }, token: { balance: "3", usd: "4" } }, NOW).pnl_usd === 1.5);

console.log("[3] buildCloseFigures");
let f = buildCloseFigures({ position: "P", pool_name: "ABC-SOL", source: "api", entry: {
  positionAddress: "ADDR", allTimeDeposits: { total: { sol: 1.5, usd: 140 }, tokenX: { amount: 0, usd: 0 }, tokenY: { amount: 1.5, usd: 140 } },
  allTimeWithdrawals: { total: { sol: 1.4, usd: 130.5 }, tokenX: { amount: 12345, amountSol: 0.6, usd: 56 }, tokenY: { amount: 0.8, usd: 74.5 } },
  allTimeFees: { total: { sol: 0.1, usd: 9 } }, pnlUsd: 1, note: "text" } });
check("ids and source", f.position === "P" && f.pool_name === "ABC-SOL" && f.source === "api");
check("raw objects are kept as numbers", f.withdrawals.tokenX.usd === 56 && f.withdrawals.total.usd === 130.5 && f.deposits.tokenY.amount === 1.5 && f.fees.total.sol === 0.1);
check("entry key names are listed (names only)", f.entry_keys.includes("allTimeWithdrawals") && f.entry_keys.includes("positionAddress"));
check("no string value leaks into the objects", !JSON.stringify([f.deposits, f.withdrawals, f.fees]).includes("ADDR") && !JSON.stringify([f.deposits, f.withdrawals, f.fees]).includes("text"));
f = buildCloseFigures({ position: "P", source: "none", entry: null });
check("no entry: objects are null, no keys", f.deposits === null && f.withdrawals === null && f.fees === null && f.entry_keys === null && f.source === "none");
f = buildCloseFigures({ position: "P", entry: { allTimeWithdrawals: { total: { usd: NaN, sol: Infinity }, weird: "s", list: [1, 2] } } });
check("NaN, Infinity, strings and arrays are dropped", JSON.stringify(f.withdrawals) === "{}", JSON.stringify(f.withdrawals));
const big = {}; for (let i = 0; i < 60; i++) big[`k${i}`] = { usd: i + 0.123456, amount: i * 1000.5, sol: i / 7 };
f = buildCloseFigures({ position: "P", source: "api", entry: { allTimeDeposits: { total: { usd: 1 } }, allTimeWithdrawals: { total: { usd: 2, sol: 0.02 }, ...big }, allTimeFees: { total: { usd: 3 } } } });
check("a long result keeps only the totals and says so", f.truncated === true && JSON.stringify(f.withdrawals) === JSON.stringify({ total: { usd: 2, sol: 0.02 } }) && f.deposits.total.usd === 1 && f.fees.total.usd === 3);
check("the truncated line stays short", JSON.stringify(f).length < 700, String(JSON.stringify(f).length));
check("an object without `total` is not kept when truncated", buildCloseFigures({ position: "P", entry: { allTimeWithdrawals: big } }).withdrawals === null);
check("no input does not throw", buildCloseFigures().position === null);
check("a long key is cut to 24 characters", Object.keys(buildCloseFigures({ position: "P", entry: { allTimeFees: { ["k".repeat(40)]: 5 } } }).fees)[0].length === 24);
check("a short result is not marked truncated", buildCloseFigures({ position: "P", entry: { allTimeFees: { total: { usd: 1 } } } }).truncated === undefined);
check("long ids are cut", buildCloseFigures({ position: "x".repeat(200), pool_name: "y".repeat(200), source: "z".repeat(50) }).position.length === 64);

console.log("[4] logCloseSettle (real executor module, wallet read stubbed through fetch)");
const realFetch = globalThis.fetch;
const realLog = console.log;
let captured = [];
let fetchCalls = 0;
let heliusMode = "ok";
const SOL_MINT = "So11111111111111111111111111111111111111112";
globalThis.fetch = async (url) => {
  if (String(url).includes("helius")) {
    fetchCalls++;
    if (heliusMode === "fail") return { ok: false, status: 500, statusText: "boom", json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ balances: [{ mint: SOL_MINT, symbol: "SOL", balance: 2.5, pricePerToken: 90.5, usdValue: 226.25 }] }) };
  }
  return { ok: false, status: 404, statusText: "x", text: async () => "", json: async () => ({}) };
};
const lines = () => captured.filter((l) => l.includes("[CLOSE_SETTLE]"));
async function run(settle, args = { position_address: "POSX" }, result = { success: true, pool_name: "AAA-SOL", base_mint: "MINTX", pnl_usd: 2, pnl_pct: 1 }) {
  captured = []; fetchCalls = 0;
  console.log = (...a) => { captured.push(a.join(" ")); };
  try { await logCloseSettle({ args, result, settle }); } finally { console.log = realLog; }
}
try {
  const before = { sol: 2, sol_price: 90, tokens: [] };
  const sw = { success: true, tx: "T1", amount_out: "500000000", fee_bps_applied: 10 };
  const parse = () => JSON.parse(lines()[0].replace(/^.*\[CLOSE_SETTLE\] /, ""));

  await run({ outcome: "swapped", balances: before, token: { balance: 10, usd: 20 }, swapResult: sw, error: null });
  let j = lines().length === 1 ? parse() : null;
  check("swapped: one [CLOSE_SETTLE] line", lines().length === 1);
  check("swapped: the wallet is read once more", fetchCalls === 1, `calls=${fetchCalls}`);
  check("swapped: SOL after comes from that read", j?.sol_after_swap === 2.5 && j?.sol_change === 0.5, JSON.stringify(j));
  check("swapped: ids from args and result", j?.position === "POSX" && j?.pool_name === "AAA-SOL" && j?.base_mint === "MINTX" && j?.outcome === "swapped");
  check("swapped: output figures", j?.out_sol === 0.5 && j?.out_sol_net === 0.4995 && j?.swap_tx === "T1");

  heliusMode = "fail";
  await run({ outcome: "swapped", balances: before, token: { balance: 10, usd: 20 }, swapResult: sw, error: null });
  j = lines().length === 1 ? parse() : null;
  check("wallet read after the swap fails: the line is still written, SOL after is null", j && j.sol_after_swap === null && j.sol_change === null && j.out_sol === 0.5);
  heliusMode = "ok";

  await run({ outcome: "skipped_small", balances: before, token: { balance: 1, usd: 0.05 }, swapResult: null, error: null });
  j = lines().length === 1 ? parse() : null;
  check("skipped: line written, no extra wallet read", j?.outcome === "skipped_small" && fetchCalls === 0 && j?.sol_after_swap === null);
  await run({ outcome: "failed", balances: before, token: { balance: 10, usd: 20 }, swapResult: { success: false, error: "429" }, error: "429 Too many requests" });
  j = lines().length === 1 ? parse() : null;
  check("failed: error kept, no extra wallet read", j?.outcome === "failed" && j?.error === "429 Too many requests" && fetchCalls === 0);
  await run({ outcome: "skip_swap", balances: null, token: null, swapResult: null, error: null });
  j = lines().length === 1 ? parse() : null;
  check("skip_swap: line written with only the close figures", j?.outcome === "skip_swap" && j?.pnl_usd === 2 && j?.sol_before_swap === null && fetchCalls === 0);
  await run({ outcome: "no_base_mint", balances: null, token: null, swapResult: null, error: null }, { position_address: "POSY" }, { success: true });
  j = lines().length === 1 ? parse() : null;
  check("no base mint: line written, position from args", j?.position === "POSY" && j?.base_mint === null && j?.pnl_usd === null);
  await run({ outcome: "no_base_mint", balances: null, token: null, swapResult: null, error: null }, {}, { success: true, position: "FROM_RESULT" });
  j = lines().length === 1 ? parse() : null;
  check("position falls back to the result's", j?.position === "FROM_RESULT");

  const result = { success: true, pool_name: "AAA-SOL", base_mint: "MINTX", pnl_usd: 2, pnl_pct: 1 };
  const snapshot = JSON.stringify(result);
  await run({ outcome: "swapped", balances: before, token: null, swapResult: sw, error: null }, { position_address: "POSX" }, result);
  check("the close result is not changed", JSON.stringify(result) === snapshot);

  let threw = false;
  captured = [];
  console.log = (...a) => { captured.push(a.join(" ")); };
  try { await logCloseSettle({ args: null, result: null, settle: { outcome: "swapped", balances: null, token: null, swapResult: null, error: null } }); } catch { threw = true; } finally { console.log = realLog; }
  check("null args and result do not throw", threw === false);
  threw = false;
  console.log = (...a) => { captured.push(a.join(" ")); };
  try { await logCloseSettle({ args: {}, result: {}, settle: null }); } catch { threw = true; } finally { console.log = realLog; }
  check("a broken settle object does not throw, it logs a warning", threw === false && captured.some((l) => l.includes("[CLOSE_SETTLE_WARN]")));
} finally {
  console.log = realLog;
  globalThis.fetch = realFetch;
}

console.log("[5] source guards");
const ex = fs.readFileSync(new URL("tools/executor.js", repo), "utf8");
const closeStart = ex.indexOf('} else if (name === "close_position") {');
const closeEnd = ex.indexOf('} else if (name === "partial_close_position"', closeStart);
const closeBlock = ex.slice(closeStart, closeEnd);
check("executor imports buildCloseSettle", /import \{[^}]*buildCloseSettle[^}]*\} from "\.\/wallet\.js"/.test(ex));
check("close branch declares settle with a default outcome", /const settle = \{ outcome: args\.skip_swap \? "skip_swap" : \(result\.base_mint \? "no_token" : "no_base_mint"\)/.test(closeBlock));
check("close branch records balances and token", /settle\.balances = balances;[\s\S]*settle\.token = token \|\| null;/.test(closeBlock));
check("close branch marks skipped_small, swapped and failed", /settle\.outcome = "skipped_small"/.test(closeBlock) && /settle\.outcome = "swapped"/.test(closeBlock) && /settle\.outcome = "failed"/.test(closeBlock) && /settle\.error = e\.message/.test(closeBlock));
check("swapped is assigned alone (no other field set with it)", /\n\s*settle\.outcome = "swapped";\n/.test(closeBlock));
check("the swap result is stored before the failure check", closeBlock.indexOf("settle.swapResult = swapResult || null;") > 0 && closeBlock.indexOf("settle.swapResult = swapResult || null;") < closeBlock.indexOf('throw new Error(swapResult?.error'));
{
  const assigned = new Set((closeBlock.match(/result\.[a-z_]+ =/g) || []).map((x) => x.replace(" =", "")));
  check("the close branch sets the same result fields as before", [...assigned].sort().join(",") === "result.auto_swap_failed,result.auto_swap_note,result.auto_swapped,result.sol_received", [...assigned].join(","));
}
check("sol_received is still set once, only after a successful swap", (closeBlock.match(/result\.sol_received =/g) || []).length === 1 && /if \(swapResult\?\.amount_out\) result\.sol_received = swapResult\.amount_out;/.test(closeBlock));
check("swapped is set only after the failure check", closeBlock.indexOf('throw new Error(swapResult?.error') < closeBlock.indexOf('settle.outcome = "swapped"'));
check("the line is written after the swap block, once", (closeBlock.match(/await logCloseSettle\(\{ args, result, settle \}\)/g) || []).length === 1 && closeBlock.indexOf("await logCloseSettle") > closeBlock.indexOf("auto_swap_failed = true"));
check("nothing else in the close branch changed (sol_received, auto_swapped kept)", /result\.sol_received = swapResult\.amount_out/.test(closeBlock) && /result\.auto_swapped = true/.test(closeBlock) && /notifyAutoSwapFailed/.test(closeBlock));
check("logCloseSettle is wrapped in try/catch and logs close_settle_warn", /export async function logCloseSettle[\s\S]*try \{[\s\S]*\} catch \(e\) \{[\s\S]*close_settle_warn/.test(ex));
check("logCloseSettle writes only the [CLOSE_SETTLE] line and never touches result", !/result\.[a-z_]+ =/.test(ex.slice(ex.indexOf("export async function logCloseSettle"), ex.indexOf("export async function executeTool"))));
check("partial close and claim swaps are untouched", !/logCloseSettle/.test(ex.slice(closeEnd)));

const dl = fs.readFileSync(new URL("tools/dlmm.js", repo), "utf8");
const sdkStart = dl.indexOf("// Fetch closed PnL from API — authoritative source after withdrawal settles", dl.indexOf("Record performance for learning", dl.indexOf("closedViaChain = verified.via")));
check("SDK close path found", sdkStart > 0);
const sdk = dl.slice(sdkStart, dl.indexOf("appendDecision({", sdkStart));
check("figuresSource starts as none and is set at the three sources", /let figuresSource = "none"/.test(sdk) && /figuresSource = "api"/.test(sdk) && /figuresSource = "reading"/.test(sdk) && /figuresSource = "cache"/.test(sdk));
check("the figures line is not disabled and gets the closed record", /\/\/ Record-only: the raw closed record[^\n]*\n\s*try \{\s*log\("close_figures"/.test(sdk) && /source: figuresSource,\s*entry: closedEntry,/.test(sdk));
check("the raw closed record is kept only on the API branch", /closedEntry\s+= posEntry;/.test(sdk));
check("[CLOSE_FIGURES] is written before recordPerformance, in its own try/catch", /try \{\s*log\("close_figures", JSON\.stringify\(buildCloseFigures\(\{[\s\S]*?\}\)\)\);\s*\} catch \(e\) \{\s*log\("close_warn", `Close figures not logged/.test(sdk) && sdk.indexOf('log("close_figures"') < sdk.indexOf("await recordPerformance("));
check("closePosition's return value is unchanged (no figures field)", !/close_figures|closedEntry/.test(sdk.slice(sdk.indexOf("return {\n        success: true,"))));

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
