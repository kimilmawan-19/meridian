// Verifies the Telegram /positions message: one line per position (unchanged), then a total across
// all open positions (value, PnL, unclaimed fees). Pure formatting, no network.
process.env.DRY_RUN = "true";
delete process.env.TELEGRAM_CHAT_ID;
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const { formatPositionsMessage } = await import("../index.js");
const pos = (pair, value, pnl, fees, age = 30, inRange = true) => ({ pair, total_value_usd: value, pnl_usd: pnl, unclaimed_fees_usd: fees, age_minutes: age, in_range: inRange });
const totalOf = (msg) => msg.split("\n").find((l) => l.startsWith("Total"));

console.log("\n[1] USD mode");
const three = [pos("OCTO-SOL", 148.2, 5.86, 1.25), pos("HOTBOT-SOL", 121.4, -8.25, 0.4, 47), pos("baton-SOL", 133.1, 1.49, 2.55, 425, false)];
const msg = formatPositionsMessage(three, 3, { solMode: false });
check("header keeps the position count", msg.startsWith("📊 Open Positions (3):"));
check("each position line is unchanged", msg.includes("1. OCTO-SOL | $148.2 | PnL: +$5.86 | fees: $1.25 | 30m") && msg.includes("2. HOTBOT-SOL | $121.4 | PnL: -$8.25 | fees: $0.4 | 47m") && msg.includes("3. baton-SOL | $133.1 | PnL: +$1.49 | fees: $2.55 | 425m ⚠️OOR"));
check("total line: value 402.70, PnL −0.90, fees 4.20 (fixed decimals)", totalOf(msg) === "Total (3): $402.70 | PnL: -$0.90 | fees: $4.20", totalOf(msg));
check("total comes after the last position and before the footer", msg.indexOf("3. baton-SOL") < msg.indexOf("Total (3)") && msg.indexOf("Total (3)") < msg.indexOf("/close <n> to close"));
check("footer kept", msg.endsWith("/close <n> to close | /set <n> <note> to set instruction"));

console.log("\n[2] sign, rounding, single position");
check("positive total PnL gets '+'", totalOf(formatPositionsMessage([pos("A", 100, 3.5, 0), pos("B", 50, 1.25, 0)])).includes("PnL: +$4.75"));
check("zero total PnL is '+$0.00', not '-$0.00'", totalOf(formatPositionsMessage([pos("A", 100, 2, 0), pos("B", 50, -2, 0)])).includes("PnL: +$0.00"));
check("float noise stripped (0.1 + 0.2)", totalOf(formatPositionsMessage([pos("A", 0.1, 0.1, 0.1), pos("B", 0.2, 0.2, 0.2)])) === "Total (2): $0.30 | PnL: +$0.30 | fees: $0.30");
check("one position still gets a total", totalOf(formatPositionsMessage([pos("A", 10, -1, 0.5)])) === "Total (1): $10.00 | PnL: -$1.00 | fees: $0.50");
check("values are summed from numbers even when they arrive as strings", totalOf(formatPositionsMessage([pos("A", "10.5", "1", "0"), pos("B", 4.5, 1, 0)])).startsWith("Total (2): $15.00 | PnL: +$2.00"));

console.log("\n[3] SOL mode");
const sol = formatPositionsMessage([pos("A", 1.2345, 0.1111, 0.0123), pos("B", 0.7655, -0.3, 0.0002)], 2, { solMode: true });
check("uses ◎ and 4 decimals", totalOf(sol) === "Total (2): ◎2.0000 | PnL: -◎0.1889 | fees: ◎0.0125", totalOf(sol));
check("lines use ◎ too", sol.includes("1. A | ◎1.2345 | PnL: +◎0.1111"));

console.log("\n[4] missing figures never read as zero");
const gap = formatPositionsMessage([pos("A", 100, 5, 1), { pair: "B", total_value_usd: 50, pnl_usd: null, unclaimed_fees_usd: 0.5, age_minutes: 5, in_range: true }, pos("C", 20, null, null)], 3);
check("known figures are still summed (value 170, PnL 5, fees 1.50)", totalOf(gap).startsWith("Total (3): $170.00 | PnL: +$5.00 | fees: $1.50"), totalOf(gap));
check("positions with a gap are counted (2)", totalOf(gap).endsWith("| data kurang: 2 posisi"), totalOf(gap));
check("complete data → no 'data kurang' note", !totalOf(msg).includes("data kurang"));
check("a position line with null PnL prints 'PnL: ?', not '+$null'", gap.includes("2. B | $50 | PnL: ? | fees: $0.5"), gap);
check("null fees print '?' too; no 'null' anywhere", gap.includes("3. C | $20 | PnL: ? | fees: ? |") && !gap.includes("null"), gap);

console.log("\n[5] header uses the count the caller passes");
check("total_positions differs from the list length → header follows the caller, total follows the list", formatPositionsMessage([pos("A", 1, 0, 0)], 3).startsWith("📊 Open Positions (3):") && totalOf(formatPositionsMessage([pos("A", 1, 0, 0)], 3)).startsWith("Total (1)"));
check("default count is the list length", formatPositionsMessage([pos("A", 1, 0, 0), pos("B", 1, 0, 0)]).startsWith("📊 Open Positions (2):"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
