// Verifies the record-only daily equity line: buildEquityDetail (tools/wallet.js) is pure and never
// lets a missing source read as zero; index.js schedules one `[EQUITY]` line at 17:00 UTC, stops it
// with the other cron tasks, and the logging function cannot throw into the bot.
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-equity-"));
process.chdir(tmp);
const repo = new URL("..", import.meta.url);
process.env.WALLET_PRIVATE_KEY ||= "x";
process.env.RPC_URL ||= "http://127.0.0.1:9";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const { buildEquityDetail } = await import(new URL("tools/wallet.js", repo).href);
const NOW = new Date("2026-11-02T17:00:00.000Z");
const wallet = { total_usd: 1000.126, sol: 4.5, sol_price: 100.004 };
const pos = (v, f, p) => ({ total_value_true_usd: v, unclaimed_fees_true_usd: f, pnl_true_usd: p });

console.log("[1] numbers");
let d = buildEquityDetail(wallet, { positions: [pos(200, 2, 5), pos(100.5, 1.25, -3)] }, NOW);
check("timestamp", d.at === "2026-11-02T17:00:00.000Z");
check("complete", d.complete === true);
check("equity = wallet + position value", d.equity_usd === 1300.63, String(d.equity_usd));
check("wallet rounded", d.wallet_usd === 1000.13);
check("sol and price", d.sol === 4.5 && d.sol_price === 100.004);
check("count, value, unclaimed, pnl", d.pos_count === 2 && d.pos_value_usd === 300.5 && d.pos_unclaimed_usd === 3.25 && d.pos_pnl_usd === 2);
check("no missing", d.pos_missing === 0);

console.log("[2] no open positions");
d = buildEquityDetail(wallet, { positions: [] }, NOW);
check("complete with zero positions", d.complete === true && d.equity_usd === 1000.13 && d.pos_count === 0 && d.pos_value_usd === 0);

console.log("[3] gaps never read as zero");
d = buildEquityDetail({ error: "Helius API error: 500", total_usd: 0 }, { positions: [pos(10, 0, 0)] }, NOW);
check("wallet error: incomplete, no equity, no wallet numbers", d.complete === false && d.equity_usd === null && d.wallet_usd === null && d.sol === null);
check("wallet error: position numbers still shown", d.pos_value_usd === 10 && d.pos_count === 1);
d = buildEquityDetail(wallet, { error: "boom" }, NOW);
check("positions error: incomplete, no equity", d.complete === false && d.equity_usd === null && d.pos_count === null && d.wallet_usd === 1000.13);
d = buildEquityDetail(wallet, { error: "boom", positions: [pos(5, 0, 0)] }, NOW);
check("positions error with a partial list is still a gap", d.complete === false && d.equity_usd === null && d.pos_count === null);
d = buildEquityDetail(wallet, null, NOW);
check("positions null", d.complete === false && d.equity_usd === null);
d = buildEquityDetail(null, { positions: [] }, NOW);
check("wallet null", d.complete === false && d.equity_usd === null);
d = buildEquityDetail({ total_usd: NaN }, { positions: [] }, NOW);
check("wallet NaN total", d.complete === false && d.equity_usd === null);
d = buildEquityDetail(wallet, { positions: [pos(200, 2, 5), { total_value_true_usd: null, total_value_usd: null, pnl_true_usd: null }] }, NOW);
check("a position with missing figures: incomplete and counted", d.complete === false && d.pos_missing === 1 && d.pos_value_usd === 200 && d.equity_usd === 1200.13);
d = buildEquityDetail(wallet, { positions: [{ total_value_true_usd: 30, pnl_true_usd: null }] }, NOW);
check("only the PnL missing still counts as missing", d.complete === false && d.pos_missing === 1 && d.pos_value_usd === 30);
d = buildEquityDetail({ total_usd: null }, { positions: [] }, NOW);
check("wallet total null is a gap, not zero", d.complete === false && d.equity_usd === null);
d = buildEquityDetail({ total_usd: 0, sol: 0, sol_price: 0 }, { positions: [] }, NOW);
check("a real zero wallet is kept as zero", d.complete === true && d.equity_usd === 0);
d = buildEquityDetail(wallet, { positions: [{ total_value_usd: 50, pnl_true_usd: 1 }] }, NOW);
check("falls back to total_value_usd", d.pos_value_usd === 50 && d.complete === true);
d = buildEquityDetail(wallet, { positions: [pos(40, 0, 0)] });
check("default clock is a valid ISO time", !Number.isNaN(Date.parse(d.at)));

console.log("[4] source guards (index.js)");
const src = fs.readFileSync(new URL("index.js", repo), "utf8");
check("imports buildEquityDetail", /import \{[^}]*buildEquityDetail[^}]*\} from "\.\/tools\/wallet\.js"/.test(src));
check("scheduled at 17:00 UTC", /equityTask = cron\.schedule\(`0 17 \* \* \*`, \(\) => \{ logDailyEquity\(\); \}, \{ timezone: 'UTC' \}\)/.test(src));
check("stopped with the other tasks", /_cronTasks = \[[^\]]*equityTask[^\]]*\]/.test(src));
const fnStart = src.indexOf("export async function logDailyEquity");
const fn = src.slice(fnStart, src.indexOf("function stopCronJobs", fnStart));
check("logDailyEquity wrapped in try/catch", fnStart > 0 && /try \{[\s\S]*\} catch \(e\) \{[\s\S]*equity_warn/.test(fn));
check("each source failure is caught on its own", (fn.match(/\.catch\(/g) || []).length === 2);
check("writes the [EQUITY] line", /log\("equity", JSON\.stringify\(buildEquityDetail\(wallet, positions\)\)\)/.test(fn));
check("reads only (no executeTool, no state write)", !/executeTool|saveState|writeFileSync|recordClose|trackPosition/.test(fn));
check("positions call is silent", /getMyPositions\(\{ force: true, silent: true \}\)/.test(fn));

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
