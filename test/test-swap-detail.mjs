// Verifies the swap detail log (tools/wallet.js): one `swap_detail` JSON line per successful swap with
// the numbers needed to measure slippage, the swap result unchanged, and a logging failure that can
// never fail a swap. Also that the three auto-swap callers in tools/executor.js pass the pre-swap USD
// value. Live logs (2026-10-17) had no amount_out, fee or quote for auto-swaps, so the hidden cost
// outside the recorded PnL (551 swaps, $23.8K a month) could not be measured. Real module, stubbed
// fetch, throwaway wallet, temp working directory (logs/ is created in cwd).
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-swap-detail-"));
process.chdir(tmp);
const repo = new URL("..", import.meta.url);

const { Keypair, VersionedTransaction, TransactionMessage } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
const wallet = Keypair.generate();
process.env.WALLET_PRIVATE_KEY = bs58.encode(wallet.secretKey);
process.env.RPC_URL = "http://127.0.0.1:9"; // never contacted: a SOL input skips the mint lookup
process.env.JUPITER_REFERRAL_FEE_BPS = "0";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";
delete process.env.DRY_RUN;

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenMint1111111111111111111111111111111111";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const unsignedTx = Buffer.from(
  new VersionedTransaction(
    new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: "1".repeat(32), instructions: [] }).compileToV0Message(),
  ).serialize(),
).toString("base64");

const realFetch = globalThis.fetch;
const requests = [];
function stub({ order = {}, exec = { status: "Success", signature: "SIG-OK" } } = {}) {
  requests.length = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    requests.push({ url: u, method: opts.method || "GET" });
    if (u.includes("/swap/v2/order")) return new Response(JSON.stringify({ transaction: unsignedTx, requestId: "req-1", ...order }), { status: 200 });
    if (u.includes("/swap/v2/execute")) return new Response(JSON.stringify(exec), { status: 200 });
    return new Response("unexpected request", { status: 500 });
  };
}

const logDir = path.join(tmp, "logs");
const readLogs = () => (fs.existsSync(logDir)
  ? fs.readdirSync(logDir).sort().map((f) => fs.readFileSync(path.join(logDir, f), "utf8")).join("")
  : "");
const TAG = "[SWAP_DETAIL] ";
const detailLines = () => readLogs().split("\n").filter((l) => l.includes(TAG)).map((l) => JSON.parse(l.slice(l.indexOf(TAG) + TAG.length)));
const successCount = () => (readLogs().match(/\[SWAP\] SUCCESS tx: /g) || []).length;

async function quiet(fn) {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = orig; }
}

try {
  const { buildSwapDetail, swapToken } = await import(new URL("tools/wallet.js", repo).href);
  const { config } = await import(new URL("config.js", repo).href);

  console.log("\n[1] buildSwapDetail (pure)");
  const full = buildSwapDetail({
    result: { signature: "SIG1", outputAmountResult: "123456789" },
    order: { outAmount: "123500000", feeBps: 0, priceImpact: -0.42, inUsdValue: 18.8, outUsdValue: 18.7 },
    input_mint: TOKEN, output_mint: SOL, amount: 5, expected_usd: 18.9, sol_usd: 152.3,
  });
  check("token → SOL: tx, in, out, in_ui", full.tx === "SIG1" && full.in === TOKEN && full.out === "SOL" && full.in_ui === 5, JSON.stringify(full));
  check("out_raw kept as a string, out_sol in SOL", full.out_raw === "123456789" && full.out_sol === 0.123456789);
  check("quote_out, price_impact and Jupiter USD values pass through", full.quote_out === "123500000" && full.price_impact === -0.42 && full.jup_in_usd === 18.8 && full.jup_out_usd === 18.7);
  check("fee_bps 0 stays 0 (not null)", full.fee_bps === 0);
  check("expected_usd and sol_usd pass through", full.expected_usd === 18.9 && full.sol_usd === 152.3);
  const slip = 1 - (full.out_sol * full.sol_usd) / full.expected_usd;
  // 0.123456789 SOL x $152.3 = $18.80247 received against $18.90 expected: 0.5160% lost
  check("documented formula gives the slippage (0.5160%)", Math.abs(slip - 0.00516037) < 1e-7, `(${slip})`);
  check("JSON round trip is lossless", JSON.stringify(JSON.parse(JSON.stringify(full))) === JSON.stringify(full));

  const sparse = buildSwapDetail({});
  check("empty input: every value null, no throw", Object.values(sparse).every((v) => v === null), JSON.stringify(sparse));
  const odd = buildSwapDetail({
    result: { outputAmountResult: "abc" }, order: { feeBps: "50", priceImpact: "x" },
    input_mint: SOL, output_mint: TOKEN, amount: "7", expected_usd: Infinity, sol_usd: NaN,
  });
  check("garbage numbers become null, numeric strings become numbers", odd.out_raw === "abc" && odd.out_sol === null && odd.price_impact === null && odd.fee_bps === 50 && odd.in_ui === 7 && odd.expected_usd === null && odd.sol_usd === null, JSON.stringify(odd));
  check("SOL input reads \"SOL\", token output keeps its mint and has no out_sol", odd.in === "SOL" && odd.out === TOKEN && odd.out_sol === null);
  const alt = buildSwapDetail({ order: { priceImpactPct: "-0.3" } });
  check("priceImpactPct is the fallback for price_impact", alt.price_impact === -0.3);

  console.log("\n[2] written by swapToken, result unchanged");
  stub({
    order: { outAmount: "1000000", feeBps: 0, priceImpact: -0.12, inUsdValue: 76.1, outUsdValue: 76.0 },
    exec: { status: "Success", signature: "SIG-1", inputAmountResult: "500000000", outputAmountResult: "999000" },
  });
  const r1 = await quiet(() => swapToken({ input_mint: SOL, output_mint: TOKEN, amount: 0.5, expected_usd: 76.1, sol_usd: 152.2 }));
  check("swap succeeds with the same result fields as before",
    r1.success === true && r1.tx === "SIG-1" && r1.amount_out === "999000" && r1.fee_bps_applied === 0
      && JSON.stringify(Object.keys(r1)) === JSON.stringify(["success", "tx", "input_mint", "output_mint", "amount_in", "amount_out", "referral_account", "referral_fee_bps_requested", "fee_bps_applied", "fee_mint"]),
    JSON.stringify(r1));
  check("one order (GET) and one execute (POST), no other request", requests.length === 2 && requests[0].method === "GET" && requests[1].method === "POST", JSON.stringify(requests));
  check("referral fee off: no referralAccount in the order", !requests[0].url.includes("referralAccount") && requests[0].url.includes("slippageBps="));
  check("the SUCCESS line is still written once", successCount() === 1);
  let lines = detailLines();
  check("exactly one swap_detail line", lines.length === 1, `(${lines.length})`);
  const d1 = lines[0] || {};
  check("detail carries tx, amounts, quote and fee",
    d1.tx === "SIG-1" && d1.in === "SOL" && d1.out === TOKEN && d1.in_ui === 0.5 && d1.out_raw === "999000" && d1.quote_out === "1000000" && d1.fee_bps === 0 && d1.price_impact === -0.12,
    JSON.stringify(d1));
  check("detail carries the caller's pre-swap USD value and SOL price", d1.expected_usd === 76.1 && d1.sol_usd === 152.2);

  console.log("\n[3] fee on shows up in the log");
  config.jupiter.referralFeeBps = 50;
  stub({ order: { outAmount: "1000000", feeBps: 50 }, exec: { status: "Success", signature: "SIG-2", outputAmountResult: "995000" } });
  const r2 = await quiet(() => swapToken({ input_mint: SOL, output_mint: TOKEN, amount: 1 }));
  config.jupiter.referralFeeBps = 0;
  check("order carries the referral params", /referralAccount=/.test(requests[0].url) && /referralFee=50/.test(requests[0].url));
  lines = detailLines();
  check("second detail line records fee_bps 50 and null caller metadata", r2.success === true && lines.length === 2 && lines[1].fee_bps === 50 && lines[1].expected_usd === null && lines[1].sol_usd === null, JSON.stringify(lines[1]));

  console.log("\n[4] sparse responses and failures");
  stub({ order: {}, exec: { status: "Success", signature: "SIG-3" } });
  const r3 = await quiet(() => swapToken({ input_mint: SOL, output_mint: TOKEN, amount: 0.2 }));
  lines = detailLines();
  const d3 = lines[2] || {};
  check("missing amounts and fee: swap still succeeds, detail has nulls",
    r3.success === true && lines.length === 3 && d3.tx === "SIG-3" && d3.out_raw === null && d3.quote_out === null && d3.fee_bps === null && d3.price_impact === null,
    JSON.stringify(d3));

  stub({ order: {}, exec: { status: "Success", signature: "SIG-4" } });
  const before = detailLines().length;
  const r4 = await quiet(() => swapToken({ input_mint: SOL, output_mint: TOKEN, amount: 0.2, expected_usd: { valueOf() { throw new Error("boom"); } } }));
  check("a logging failure does not fail the swap", r4.success === true && r4.tx === "SIG-4", JSON.stringify(r4));
  check("it is reported as a warning and writes no detail line", readLogs().includes("Swap detail not logged: boom") && detailLines().length === before);

  stub({ order: {}, exec: { status: "Failed", code: -1 } });
  const okBefore = successCount(), detailBefore = detailLines().length;
  const r5 = await quiet(() => swapToken({ input_mint: SOL, output_mint: TOKEN, amount: 0.2 }));
  check("a failed swap reports failure and logs neither SUCCESS nor detail",
    r5.success === false && /Swap failed on-chain/.test(r5.error || "") && successCount() === okBefore && detailLines().length === detailBefore, JSON.stringify(r5));

  console.log("\n[5] wired into the auto-swap callers");
  const execSrc = fs.readFileSync(new URL("tools/executor.js", repo), "utf8");
  const callers = execSrc.match(/swapToken\(\{ input_mint: result\.base_mint[^}]*\}\)/g) || [];
  check("three auto-swap callers (close, partial close, claim)", callers.length === 3, `(${callers.length})`);
  check("each passes expected_usd and sol_usd", callers.length === 3 && callers.every((c) => c.includes("expected_usd: token.usd") && c.includes("sol_usd: balances.sol_price")));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  globalThis.fetch = realFetch;
  try { process.chdir(os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
