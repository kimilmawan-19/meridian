// Verifies that a wide-range deploy failing after its create txs closes the empty position it
// left on-chain (cleanupOrphanPosition, tools/dlmm.js). Live: ~129 such failures since July
// ("Simulation failed" / "block height exceeded" on add liquidity), ~3/day in Sep 2026. The
// untracked position kept a slot and its rent; since direct closes nothing closed it (bukangi/SOL).
// Real module import with a stub pool + stub sender; source drift checks for the deploy wiring.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const pubkey = { toString: () => "OrphanPos1111111111111111111111111111111111" };
const wallet = { publicKey: { toString: () => "Wallet111" } };
const stubPool = (liquidity) => {
  const calls = [];
  return {
    calls,
    getPosition: async () => ({ positionData: { lowerBinId: -610, upperBinId: -541,
      positionBinData: [{ positionLiquidity: "0" }, { positionLiquidity: liquidity }] } }),
    closePosition: async (args) => { calls.push(["closePosition", args]); return "closeTx"; },
    removeLiquidity: async (args) => { calls.push(["removeLiquidity", args]); return ["removeTx"]; },
  };
};

try {
  const { cleanupOrphanPosition } = await import("../tools/dlmm.js");

  console.log("\n[1] empty position → account closed");
  const p1 = stubPool("0"), sent1 = [];
  await cleanupOrphanPosition(p1, pubkey, wallet, async (tx) => sent1.push(tx));
  check("closePosition used", p1.calls.length === 1 && p1.calls[0][0] === "closePosition", JSON.stringify(p1.calls));
  check("close tx sent", sent1.length === 1 && sent1[0] === "closeTx");

  console.log("\n[2] partial add-liquidity landed → liquidity removed and account closed");
  const p2 = stubPool("12345"), sent2 = [];
  await cleanupOrphanPosition(p2, pubkey, wallet, async (tx) => sent2.push(tx));
  const rm = p2.calls[0]?.[1];
  check("removeLiquidity used", p2.calls[0]?.[0] === "removeLiquidity");
  check("full removal with claim-and-close over the position's bins",
    rm?.bps?.toString() === "10000" && rm?.shouldClaimAndClose === true && rm?.fromBinId === -610 && rm?.toBinId === -541);
  check("remove tx sent", sent2.length === 1 && sent2[0] === "removeTx");

  console.log("\n[3] cleanup failure is logged, never thrown");
  let threw = false, tries = 0;
  try { await cleanupOrphanPosition(stubPool("0"), pubkey, wallet, async () => { tries++; throw new Error("block height exceeded"); }, { delayMs: 0 }); }
  catch { threw = true; }
  check("no throw (deploy still returns its own error)", !threw);
  check("retried 4 times before giving up", tries === 4, `tries=${tries}`);

  console.log("\n[3b] close tx expires once (live OP/SOL 2026-10-02) → retried with a rebuilt tx");
  const p3 = stubPool("0"); let n3 = 0;
  await cleanupOrphanPosition(p3, pubkey, wallet, async () => { if (++n3 === 1) throw new Error("Signature has expired: block height exceeded"); }, { delayMs: 0 });
  check("second attempt succeeds", n3 === 2, `sends=${n3}`);
  check("tx rebuilt per attempt", p3.calls.length === 2, JSON.stringify(p3.calls));

  console.log("\n[3c] earlier attempt landed late → account missing on re-read, treated as closed");
  let reads = 0, sends4 = 0;
  const p4 = { getPosition: async () => { if (++reads > 1) throw new Error("Account not found"); return { positionData: { positionBinData: [] } }; },
    closePosition: async () => "closeTx" };
  await cleanupOrphanPosition(p4, pubkey, wallet, async () => { sends4++; throw new Error("block height exceeded"); }, { delayMs: 0 });
  check("stops after the missing-account read", reads === 2 && sends4 === 1, `reads=${reads} sends=${sends4}`);

  console.log("\n[4] deploy wiring (drift)");
  const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const createLoopEnd = src.indexOf("positionCreated = true;");
  const createLog = src.indexOf("Create tx ${i + 1}");
  check("flag set right after the wide-range create txs, before add liquidity",
    createLog > 0 && createLoopEnd > createLog && createLoopEnd < src.indexOf("addLiquidityByStrategyChunkable", createLog));
  check("deploy catch cleans up only when the position was created",
    src.includes("if (positionCreated) await cleanupOrphanPosition(pool, newPosition.publicKey, wallet);"));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
