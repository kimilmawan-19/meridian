// Verifies the fix for a closed position that stays in Meteora's open list (Gato-SOL 2026-10-18:
// claim and close txs confirmed, the list kept the position for 17+ minutes, the verification gave
// up, so no record / notification / auto-swap, and 34 more close attempts on a closed account).
// [1] recently-closed marker  [2] getMyPositions hides it (stubbed fetch)  [3] positionAccountGone
// [4] verifyPositionClosed (fake list + fake connection)  [5] closeFigureFromReading (hand-computed)
// [6] wiring guards for closePosition (it needs a wallet, the SDK and an RPC, so it is not run whole)
// [7] the incident replayed through the helpers.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";
delete process.env.LPAGENT_API_KEY;

import fs from "fs";

const STATE_FILE = "./state.json";
const stateBackup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
const near = (a, b, eps = 1e-9) => typeof a === "number" && Math.abs(a - b) < eps;

const WALLET = "11111111111111111111111111111111"; // dummy (system program id), valid base58 key
const POOL = "GhostPool11111111111111111111111111111111111";
const LIVE = "LivePosn111111111111111111111111111111111111";
const GHOST = "GhostPsn111111111111111111111111111111111111";
const ROWS = {}; // position address → PnL API row, set per case

const row = (addr, { ageMin, value, deposit, pct }) => ({
  positionAddress: addr,
  lowerBinId: 100, upperBinId: 170, poolActiveBinId: 165, isOutOfRange: false,
  createdAt: Math.floor((Date.now() - ageMin * 60_000) / 1000),
  pnlPctChange: pct, pnlUsd: (deposit * pct) / 100,
  unrealizedPnl: { balances: value, unclaimedFeeTokenX: { usd: 0 }, unclaimedFeeTokenY: { usd: 0 } },
  allTimeDeposits: { total: { usd: deposit } },
  allTimeWithdrawals: { total: { usd: 0 } },
  allTimeFees: { total: { usd: 0 } },
  feePerTvl24h: 5,
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes("/portfolio/open")) {
    return json({ pools: [{ poolAddress: POOL, tokenX: "GST", tokenY: "SOL", tokenXMint: "GhostMint", listPositions: Object.keys(ROWS) }] });
  }
  if (u.includes(`/positions/${POOL}/pnl`)) return json({ positions: Object.values(ROWS) });
  throw new Error(`unexpected fetch in test: ${u}`);
};

const logged = [];
const realLog = console.log;
const capture = async (fn) => {
  console.log = (...a) => { logged.push(a.join(" ")); };
  try { return await fn(); } finally { console.log = realLog; }
};
const logsWith = (text) => logged.filter((l) => l.includes(text));

try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions: {}, recentEvents: [] }, null, 2));
  const state = await import("../state.js");
  const { config } = await import("../config.js");
  const dlmm = await import("../tools/dlmm.js");
  const { markRecentlyClosed, isRecentlyClosed, RECENTLY_CLOSED_MS, getMyPositions, positionAccountGone, verifyPositionClosed, closeFigureFromReading } = dlmm;
  const MIN = 60_000, t0 = 1_700_000_000_000;
  const listAddrs = async () => (await capture(() => getMyPositions({ wallet_address: WALLET, silent: true }))).positions.map((p) => p.position).sort();

  console.log("\n[1] recently-closed marker");
  const q = {}; // answers are collected first: the predicate logs once per address, and the log goes to the console
  await capture(async () => {
    q.unmarked = isRecentlyClosed("MarkerAddrA", t0);
    markRecentlyClosed("MarkerAddrA", t0);
    q.justMarked = isRecentlyClosed("MarkerAddrA", t0);
    q.at2999 = isRecentlyClosed("MarkerAddrA", t0 + 30 * MIN - 1);
    q.at3000 = isRecentlyClosed("MarkerAddrA", t0 + 30 * MIN);
    q.after = isRecentlyClosed("MarkerAddrA", t0 + 1);
    markRecentlyClosed("MarkerAddrB", t0);
    q.other = [isRecentlyClosed("MarkerAddrC", t0), isRecentlyClosed("MarkerAddrB", t0)];
    markRecentlyClosed("MarkerAddrD", t0);
    markRecentlyClosed("MarkerAddrD", t0 + 20 * MIN);
    q.again40 = isRecentlyClosed("MarkerAddrD", t0 + 40 * MIN);
    q.again50 = isRecentlyClosed("MarkerAddrD", t0 + 50 * MIN);
    markRecentlyClosed("HideOnce111111111111", Date.now());
    isRecentlyClosed("HideOnce111111111111"); isRecentlyClosed("HideOnce111111111111"); isRecentlyClosed("HideOnce111111111111");
    markRecentlyClosed("PruneAddrA", t0 + 100 * MIN);
    markRecentlyClosed("PruneAddrC", t0 + 120 * MIN);
    markRecentlyClosed("PruneAddrB", t0 + 130 * MIN); // exactly 30:00.000 after A: A is dropped on this call, C (10 min old) is not
    q.prunedA = isRecentlyClosed("PruneAddrA", t0 + 100 * MIN + 1); // an earlier time: true only if A was not pruned
    q.keptC = isRecentlyClosed("PruneAddrC", t0 + 130 * MIN + 1);
    q.keptB = isRecentlyClosed("PruneAddrB", t0 + 130 * MIN + 1);
  });
  check("window is 30 minutes", RECENTLY_CLOSED_MS === 30 * MIN);
  check("an unmarked address is not hidden", q.unmarked === false);
  check("hidden right after the mark", q.justMarked === true);
  check("still hidden at 29:59.999", q.at2999 === true);
  check("not hidden at exactly 30:00.000", q.at3000 === false);
  check("and forgotten for good (also for an earlier time)", q.after === false);
  check("another address is not affected", q.other[0] === false && q.other[1] === true);
  check("marking again restarts the clock (hidden at +40 min)", q.again40 === true);
  check("and it ends 30 min after the second mark (+50 min)", q.again50 === false);
  check("one 'Hiding' log line per address, however often it is asked", logsWith("Hiding HideOnce").length === 1, logged.join("\n"));
  check("a new mark drops marks that are exactly 30 minutes old, and keeps younger ones and its own", q.prunedA === false && q.keptC === true && q.keptB === true, JSON.stringify([q.prunedA, q.keptC, q.keptB]));

  console.log("\n[2] getMyPositions hides a position whose close the chain confirmed");
  ROWS[LIVE] = row(LIVE, { ageMin: 30, value: 150, deposit: 150, pct: 0 });
  ROWS[GHOST] = row(GHOST, { ageMin: 30, value: 0.4, deposit: 150, pct: -0.3 });
  for (const addr of [LIVE, GHOST]) {
    state.trackPosition({
      position: addr, pool: POOL, pool_name: "GST-SOL", strategy: "bid_ask",
      bin_range: { min: 100, max: 170 }, amount_sol: 1, active_bin: 165,
      bin_step: 100, volatility: 3.2, fee_tvl_ratio: 0.5, organic_score: 80, initial_value_usd: 150,
    });
  }
  check("control: both positions are listed when nothing is marked", JSON.stringify(await listAddrs()) === JSON.stringify([GHOST, LIVE].sort()));
  markRecentlyClosed(GHOST);
  const hidden = await capture(() => getMyPositions({ wallet_address: WALLET, silent: true }));
  check("the marked address is gone from the list", !hidden.positions.some((p) => p.position === GHOST));
  check("the other position stays, with its figures", hidden.positions.length === 1 && hidden.positions[0].position === LIVE && hidden.positions[0].total_value_usd === 150, JSON.stringify(hidden.positions.map((p) => p.position)));
  check("total_positions follows (1)", hidden.total_positions === 1, `(got ${hidden.total_positions})`);
  markRecentlyClosed(GHOST, Date.now() - 31 * MIN);
  check("a mark older than 30 minutes no longer hides it", JSON.stringify(await listAddrs()) === JSON.stringify([GHOST, LIVE].sort()));

  console.log("\n[3] positionAccountGone: only 'no account at all' counts");
  const seen = [];
  const conn = (impl) => ({ getAccountInfo: async (pk) => { seen.push(pk); return impl(); } });
  check("null → gone", (await positionAccountGone(conn(() => null), "PK1")) === true);
  check("the public key is passed through", seen[0] === "PK1");
  check("an account object → not gone", (await positionAccountGone(conn(() => ({ lamports: 5, owner: "Prog", data: [] })), "PK2")) === false);
  check("undefined → not gone (unknown)", (await positionAccountGone(conn(() => undefined), "PK3")) === false);
  check("an RPC error → not gone (unknown)", (await positionAccountGone(conn(() => { throw new Error("rpc down"); }), "PK4")) === false);
  check("a connection without getAccountInfo → not gone", (await positionAccountGone({}, "PK5")) === false);

  console.log("\n[4] verifyPositionClosed (fake list, fake connection, no delay)");
  const POS = "VerifyPos1111111111111111111111111111111111111";
  const mk = ({ lists, account }) => {
    const calls = { list: 0, chain: 0 };
    const listPositions = async () => {
      const step = lists[Math.min(calls.list, lists.length - 1)];
      calls.list++;
      if (step === "throw") throw new Error("Portfolio API 500");
      return { positions: step === "ghost" ? [{ position: POS }, { position: "Other" }] : [{ position: "Other" }] };
    };
    const connection = { getAccountInfo: async () => { calls.chain++; if (account === "throw") throw new Error("rpc down"); return account === "exists" ? { lamports: 1 } : null; } };
    return { calls, args: { position_address: POS, positionPubKey: "PK", listPositions, connection, delayMs: 0 } };
  };
  const run = async (cfg) => { const m = mk(cfg); logged.length = 0; const res = await capture(() => verifyPositionClosed(m.args)); return { res, calls: m.calls }; };

  let r = await run({ lists: ["gone"], account: "none" });
  check("a. missing from the list at the first check → closed via list", r.res.closed === true && r.res.via === "list");
  check("a. one list read, no chain read", r.calls.list === 1 && r.calls.chain === 0, JSON.stringify(r.calls));

  r = await run({ lists: ["ghost"], account: "none" });
  check("b. listed 4 times, account gone on-chain → closed via chain", r.res.closed === true && r.res.via === "chain", JSON.stringify(r.res));
  check("b. exactly 4 list reads and 1 chain read", r.calls.list === 4 && r.calls.chain === 1, JSON.stringify(r.calls));
  const attemptLines = logged.map((l) => /Position (\S+) still appears open after close txs \(attempt (\d)\/4\)/.exec(l)).filter(Boolean);
  check("b. the 4 'still appears open' lines keep the text diag-gato.mjs parses", attemptLines.length === 4 && attemptLines.every((m, i) => m[1] === POS && Number(m[2]) === i + 1), logged.join("\n"));
  check("b. one line says the account is gone on-chain", logsWith("is still in the open list but its account is gone on-chain: the close is confirmed").length === 1);

  r = await run({ lists: ["ghost"], account: "exists" });
  check("c. listed 4 times and the account still exists → not closed", r.res.closed === false && r.res.via === null, JSON.stringify(r.res));
  check("c. the chain was asked once", r.calls.chain === 1 && r.calls.list === 4);
  check("c. no 'gone on-chain' line", logsWith("account is gone on-chain").length === 0);

  r = await run({ lists: ["throw"], account: "none" });
  check("d. the list fails 4 times, account gone → closed via chain", r.res.closed === true && r.res.via === "chain");
  check("d. 4 'Close verification failed (attempt k/4)' lines", [1, 2, 3, 4].every((k) => logsWith(`Close verification failed (attempt ${k}/4): Portfolio API 500`).length === 1), logged.join("\n"));

  r = await run({ lists: ["ghost"], account: "throw" });
  check("e. listed 4 times and the chain read fails → not closed, no throw", r.res.closed === false && r.res.via === null, JSON.stringify(r.res));

  r = await run({ lists: ["ghost", "ghost", "gone"], account: "none" });
  check("f. gone at the third check → closed via list, stops there", r.res.closed === true && r.res.via === "list" && r.calls.list === 3 && r.calls.chain === 0, JSON.stringify(r.calls));

  const m2 = mk({ lists: ["ghost"], account: "none" });
  logged.length = 0;
  const res2 = await capture(() => verifyPositionClosed({ ...m2.args, attempts: 2 }));
  check("g. attempts: 2 → two list reads, the lines say /2, then the chain", res2.via === "chain" && m2.calls.list === 2 && logsWith("(attempt 2/2)").length === 1);

  // The sleeps between reads, counted without waiting: setTimeout is wrapped to record the requested delay.
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, 0, ...rest); };
  try {
    const m3 = mk({ lists: ["ghost"], account: "none" });
    const { delayMs: _unused, ...noDelay } = m3.args;
    await capture(() => verifyPositionClosed(noDelay));
  } finally { globalThis.setTimeout = realSetTimeout; }
  check("h. defaults: 4 list reads, 3 sleeps of 3000 ms between them and none after the last", JSON.stringify(delays) === JSON.stringify([3000, 3000, 3000]), JSON.stringify(delays));

  console.log("\n[5] closeFigureFromReading (hand-computed)");
  const R1 = { total_value_true_usd: 107.62, total_value_usd: 107.62, collected_fees_true_usd: 0, unclaimed_fees_true_usd: 7.95, pnl_true_usd: 2.2, pnl_usd: 2.2, pnl_pct: 1.94, pnl_pct_suspicious: false };
  let f = closeFigureFromReading(R1, false);
  check("USD mode: value 107.62, fees 7.95, pnl 2.20, pct 1.94", f && near(f.finalValueUsd, 107.62) && near(f.feesUsd, 7.95) && near(f.pnlTrueUsd, 2.2) && near(f.pnlUsd, 2.2) && near(f.pnlPct, 1.94), JSON.stringify(f));
  check("initial = value + fees - pnl = 113.37 (not an LLM estimate)", f && near(f.initialUsd, 113.37), JSON.stringify(f));
  const R2 = { total_value_true_usd: 114.51, collected_fees_true_usd: 5.17, unclaimed_fees_true_usd: 5.57, pnl_true_usd: 10.4, pnl_usd: 10.4, pnl_pct: 9.06 };
  f = closeFigureFromReading(R2, false);
  check("claimed + unclaimed fees both count: 10.74, initial 114.85", f && near(f.feesUsd, 10.74) && near(f.initialUsd, 114.85), JSON.stringify(f));
  const R3 = { total_value_true_usd: 200, total_value_usd: 1.9, collected_fees_true_usd: 1, unclaimed_fees_true_usd: 3, pnl_true_usd: -6, pnl_usd: -0.057, pnl_pct: -2.8 };
  f = closeFigureFromReading(R3, true);
  check("SOL mode: pnlUsd is the SOL figure, pnlTrueUsd and value stay USD, initial 210", f && near(f.pnlUsd, -0.057) && near(f.pnlTrueUsd, -6) && near(f.finalValueUsd, 200) && near(f.initialUsd, 210) && near(f.pnlPct, -2.8), JSON.stringify(f));
  f = closeFigureFromReading(R3, false);
  check("USD mode on the same reading: pnlUsd = pnlTrueUsd = -6", f && near(f.pnlUsd, -6) && near(f.pnlTrueUsd, -6), JSON.stringify(f));
  check("no reading → null", closeFigureFromReading(null, false) === null && closeFigureFromReading(undefined, true) === null);
  check("a suspicious reading → null", closeFigureFromReading({ ...R1, pnl_pct_suspicious: true }, false) === null);
  check("pnl_pct null → null", closeFigureFromReading({ ...R1, pnl_pct: null }, false) === null);
  f = closeFigureFromReading({ ...R1, pnl_true_usd: null }, false);
  check("USD mode: pnl_true_usd null falls back to pnl_usd", f && near(f.pnlTrueUsd, 2.2) && near(f.initialUsd, 113.37), JSON.stringify(f));
  check("SOL mode: pnl_true_usd null → null", closeFigureFromReading({ ...R1, pnl_true_usd: null }, true) === null);
  f = closeFigureFromReading({ ...R1, total_value_true_usd: null }, false);
  check("total_value_true_usd null falls back to total_value_usd", f && near(f.finalValueUsd, 107.62), JSON.stringify(f));
  check("no position value at all → null", closeFigureFromReading({ ...R1, total_value_true_usd: null, total_value_usd: null }, false) === null);
  f = closeFigureFromReading({ ...R1, collected_fees_true_usd: null, unclaimed_fees_true_usd: null }, false);
  check("null fees count as 0: initial 105.42", f && near(f.feesUsd, 0) && near(f.initialUsd, 105.42), JSON.stringify(f));
  check("a position value of 0 → null (0 is the 'no figures' marker in closePosition)", closeFigureFromReading({ ...R1, total_value_true_usd: 0, total_value_usd: 0 }, false) === null);
  check("derived initial value of exactly 0 → null", closeFigureFromReading({ total_value_true_usd: 1, pnl_true_usd: 1, pnl_usd: 1, pnl_pct: 5 }, false) === null);
  check("derived initial value below 0 → null", closeFigureFromReading({ total_value_true_usd: 1, pnl_true_usd: 2, pnl_usd: 2, pnl_pct: 5 }, false) === null);
  check("a string number is not a number → null", closeFigureFromReading({ ...R1, pnl_pct: "1.94" }, false) === null);
  check("NaN and Infinity → null", closeFigureFromReading({ ...R1, pnl_pct: NaN }, false) === null && closeFigureFromReading({ ...R1, total_value_true_usd: Infinity }, false) === null);

  console.log("\n[6] wiring guards for closePosition and getMyPositions");
  const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const from = src.indexOf("export async function closePosition(");
  const to = src.indexOf("// ─── Helpers", from);
  const body = src.slice(from, to);
  const count = (hay, needle) => hay.split(needle).length - 1;
  check("closePosition body found", from > 0 && to > from);
  check("getMyPositions skips recently closed addresses as the first statement of its inner loop",
    /for \(const positionAddress of \(pool\.listPositions \|\| \[\]\)\) \{\n\s+if \(isRecentlyClosed\(positionAddress\)\) continue;/.test(src));
  check("the SDK path verifies through verifyPositionClosed (once)", count(body, "await verifyPositionClosed({") === 1);
  check("only a result confirmed by the chain sets closedViaChain", body.includes('const closedViaChain = verified.via === "chain";'));
  check("the figures from the reading fill all six variables", body.includes("({ pnlUsd, pnlTrueUsd, pnlPct, feesUsd, finalValueUsd, initialUsd } = figure);"));
  check("the old inline SDK loop text is gone", !src.includes("still appears open after close txs (attempt ${attempt + 1}/4)"));
  check("the shared verifier keeps the text Block C parses",
    src.includes("still appears open after close txs (attempt ${attempt + 1}/${attempts})") && /attempts = 4, delayMs = 3000/.test(src));
  check("the relay path keeps its own loop and text", src.includes("Relay close still appears open after submit (attempt ${attempt + 1}/4)"));
  check("the verifier gets a fresh forced list and the real connection",
    body.includes("listPositions: () => getMyPositions({ force: true, silent: true }),") && body.includes("connection: getConnection(),"));
  check("preCloseReading is taken before Step 1", body.indexOf("const preCloseReading = _positionsCache?.positions?.find(") > 0
    && body.indexOf("const preCloseReading") < body.indexOf("Step 1: Claiming fees"));
  check("the old failure branch is intact (recordClose + the same error text) under !verified.closed",
    /if \(!verified\.closed\) \{[\s\S]*?recordClose\(position_address, reason \|\| "agent decision"\);[\s\S]*?error: "Close transactions sent but position still appears open after verification window",/.test(body));
  check("markRecentlyClosed is called once in the file besides its definition", count(src, "markRecentlyClosed(") === 2);
  check("... and that call sits in the closedViaChain block, after recordClose",
    /if \(closedViaChain\) \{[^}]*recordClose\(position_address, reason \|\| "agent decision"\);\s*markRecentlyClosed\(position_address\);/.test(body));
  check("... followed by dropping the cached list, which still holds the position",
    /markRecentlyClosed\(position_address\);\s*_positionsCacheAt = 0;/.test(body));
  check("the closedViaChain block comes after the failure branch and before the record",
    body.indexOf("if (!verified.closed) {") < body.indexOf("if (closedViaChain) {") && body.indexOf("if (closedViaChain) {") < body.indexOf("// Record performance for learning"));
  check("the reading from before the close is used only for a chain-only close, when the API gave nothing",
    body.includes("if (finalValueUsd === 0 && closedViaChain) {") && body.includes("closeFigureFromReading(preCloseReading, config.management.solMode)"));
  check("the old post-close cache fallback is skipped for a chain-only close", body.includes("if (finalValueUsd === 0 && !closedViaChain) {"));
  check("no record of zeros for a chain-only close without figures",
    body.includes('if (closedViaChain && finalValueUsd === 0) throw new Error("no usable PnL source (close confirmed by the chain only)");'));
  check("the success result says how it was confirmed, as its first field after success (the action log cuts at 1,000 characters)",
    /success: true,\n\s+\.\.\.\(closedViaChain \? \{ confirmed_via: "chain" \} : \{\}\),/.test(body));
  check("the decision log mentions it", body.includes('closedViaChain ? "close confirmed by the chain while the open list lagged" : null,'));

  console.log("\n[7] the Gato-SOL incident replayed through the helpers");
  for (const k of Object.keys(ROWS)) delete ROWS[k];
  const G2 = "GatoPosn111111111111111111111111111111111111";
  const L2 = "OtherPsn111111111111111111111111111111111111";
  ROWS[G2] = row(G2, { ageMin: 21, value: 0.3, deposit: 150, pct: 0.02 });
  ROWS[L2] = row(L2, { ageMin: 40, value: 150, deposit: 150, pct: 0 });
  const calls7 = { chain: 0 };
  logged.length = 0;
  const v = await capture(() => verifyPositionClosed({
    position_address: G2,
    positionPubKey: "PK7",
    listPositions: () => getMyPositions({ wallet_address: WALLET, silent: true }),
    connection: { getAccountInfo: async () => { calls7.chain++; return null; } },
    delayMs: 0,
  }));
  check("the list still shows the closed position at all 4 checks, the chain says gone → closed via chain", v.closed === true && v.via === "chain" && calls7.chain === 1, JSON.stringify(v));
  check("(this is the point where the old code returned success:false)", logsWith(`Position ${G2} still appears open after close txs (attempt 4/4)`).length === 1);
  markRecentlyClosed(G2);
  const next = await listAddrs();
  check("the next poll sees only the other position: no 35 more close attempts", JSON.stringify(next) === JSON.stringify([L2]), JSON.stringify(next));
  markRecentlyClosed(G2, Date.now() - 31 * MIN);
  check("after 30 minutes the address is listed again if the indexer still has it", (await listAddrs()).includes(G2));
} catch (e) {
  fail++;
  console.log(`  ✗ test crashed: ${e.stack}`);
} finally {
  console.log = realLog;
  globalThis.fetch = realFetch;
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else fs.rmSync(STATE_FILE, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
