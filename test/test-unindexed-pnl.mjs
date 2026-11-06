// Verifies that a PnL reading of <= -99% on a position younger than 10 minutes is treated as not yet
// indexed (getMyPositions, tools/dlmm.js): PnL fields null, pnl_pct_suspicious true, so no exit rule
// acts on it. Live: 6 early-dump stop losses at age 0 in 12 days read "PnL -100.00%", 2 executed
// (CLAUDIA, QI closed at ~0%). Older positions and real dumps keep the old behavior.
// Real module round-trip with fetch stubbed for the Meteora portfolio + PnL APIs; backs up + restores state.json.
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

const WALLET = "11111111111111111111111111111111"; // dummy (system program id), valid base58 key
const POOL = "UnindexPool111111111111111111111111111111111";
const ROWS = {}; // position address → PnL API row, set per case

// PnL API row: value = current balance (USD), deposit = all-time deposit (USD), pct = API PnL %.
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
    return json({ pools: [{ poolAddress: POOL, tokenX: "UNI", tokenY: "SOL", tokenXMint: "UniMint", listPositions: Object.keys(ROWS) }] });
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

try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions: {}, recentEvents: [] }, null, 2));
  const state = await import("../state.js");
  const { config } = await import("../config.js");
  const { getMyPositions } = await import("../tools/dlmm.js");
  const mgmt = config.management;
  const solModeWas = mgmt.solMode;
  mgmt.solMode = false;

  const A = "UnindexA111111111111111111111111111111111111"; // age 0, value 0 → -100%
  const B = "UnindexB111111111111111111111111111111111111"; // age 0, deposit not indexed either
  const C = "UnindexC111111111111111111111111111111111111"; // age 12, value 0 → -100% (past the window)
  const D = "UnindexD111111111111111111111111111111111111"; // age 0, real dump -12%
  const E = "UnindexE111111111111111111111111111111111111"; // age 0, normal +0.5%
  ROWS[A] = row(A, { ageMin: 0, value: 0, deposit: 150, pct: -100 });
  ROWS[B] = row(B, { ageMin: 0, value: 0, deposit: 0, pct: -100 });
  ROWS[C] = row(C, { ageMin: 12, value: 0, deposit: 150, pct: -100 });
  ROWS[D] = row(D, { ageMin: 0, value: 132, deposit: 150, pct: -12 });
  ROWS[E] = row(E, { ageMin: 0, value: 150.75, deposit: 150, pct: 0.5 });
  for (const addr of [A, B, C, D, E]) {
    state.trackPosition({
      position: addr, pool: POOL, pool_name: "UNI-SOL", strategy: "curve",
      bin_range: { min: 100, max: 170 }, amount_sol: 1, active_bin: 165,
      bin_step: 100, volatility: 1.8, fee_tvl_ratio: 0.5, organic_score: 80, initial_value_usd: 150,
      sl_pct_override: -8,
    });
  }

  const result = await capture(() => getMyPositions({ wallet_address: WALLET, silent: true }));
  const by = Object.fromEntries((result.positions || []).map((p) => [p.position, p]));
  check("all five positions returned", Object.keys(by).length === 5, JSON.stringify(result.error ?? Object.keys(by)));
  const exit = (addr) => state.updatePnlAndCheckExits(addr, by[addr], mgmt, "healthy");

  console.log("\n[1] age 0, value 0, API -100% → not indexed yet");
  check("pnl_pct is null", by[A]?.pnl_pct === null, `(got ${by[A]?.pnl_pct})`);
  check("pnl_usd and pnl_true_usd are null", by[A]?.pnl_usd === null && by[A]?.pnl_true_usd === null);
  check("pnl_pct_suspicious is true", by[A]?.pnl_pct_suspicious === true);
  check("age and value fields unchanged (age 0, value 0)", by[A]?.age_minutes === 0 && by[A]?.total_value_usd === 0);
  check("one 'Unindexed PnL reading' log line for it", logged.filter((l) => l.includes(`Unindexed PnL reading for ${A.slice(0, 8)}`)).length === 1, logged.join("\n"));
  check("no 'Suspicious pnl_pct' line for it", !logged.some((l) => l.includes(`Suspicious pnl_pct for ${A.slice(0, 8)}`)));
  const eA = exit(A);
  check("no exit (no early-dump stop loss)", eA == null, `(got ${JSON.stringify(eA)})`);

  console.log("\n[2] age 0, deposit not indexed either (derived PnL null), API -100%");
  check("derived PnL is null (deposit 0)", by[B]?.pnl_pct_derived === null);
  check("still caught: pnl_pct null, suspicious true", by[B]?.pnl_pct === null && by[B]?.pnl_pct_suspicious === true);
  const eB = exit(B);
  check("no exit", eB == null, `(got ${JSON.stringify(eB)})`);

  console.log("\n[3] age 12, API -100% → past the 10-minute window, old behavior");
  check("pnl_pct is -100", by[C]?.pnl_pct === -100, `(got ${by[C]?.pnl_pct})`);
  check("not flagged", by[C]?.pnl_pct_suspicious === false);
  const eC = exit(C);
  check("STOP_LOSS with [early-dump override] (age 12 < 15)", eC?.action === "STOP_LOSS" && /early-dump override/.test(eC?.reason ?? ""), `(got ${JSON.stringify(eC)})`);

  console.log("\n[4] age 0, real dump -12% → early-dump still fires");
  check("pnl_pct is -12, not flagged", by[D]?.pnl_pct === -12 && by[D]?.pnl_pct_suspicious === false, `(got ${by[D]?.pnl_pct})`);
  const eD = exit(D);
  check("STOP_LOSS with [early-dump override]", eD?.action === "STOP_LOSS" && /early-dump override/.test(eD?.reason ?? ""), `(got ${JSON.stringify(eD)})`);

  console.log("\n[5] age 0, normal +0.5% → untouched");
  check("pnl_pct 0.5, pnl_usd 0.75, not flagged", by[E]?.pnl_pct === 0.5 && by[E]?.pnl_usd === 0.75 && by[E]?.pnl_pct_suspicious === false, JSON.stringify(by[E]));
  check("no exit", exit(E) == null);
  check("only position A and B logged as unindexed", logged.filter((l) => l.includes("Unindexed PnL reading")).length === 2);

  mgmt.solMode = solModeWas;
} catch (e) {
  fail++;
  console.log(`  ✗ test crashed: ${e.stack}`);
} finally {
  globalThis.fetch = realFetch;
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else fs.rmSync(STATE_FILE, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
