// Verifies pool-memory cooldowns fire for the rule-text close reasons produced since closes
// run directly in code (index.js direct close). The low-yield cooldown used an exact
// `=== "low yield"` match that the new reasons ("Low yield: fee/TVL …", "Rule 5: low yield (…)")
// never equal, and Rule 11 (liquidity collapse / rug) matched no cooldown at all.
// Real recordPoolDeploy round-trip; pool-memory.json is backed up and restored.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

const FILE = "./pool-memory.json";
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  fs.writeFileSync(FILE, "{}");
  const pm = await import("../pool-memory.js");
  let i = 0;
  const close = (reason, extra = {}) => {
    const pool = `CooldownPool${++i}`;
    const mint = `CooldownMint${i}`;
    pm.recordPoolDeploy(pool, {
      pool_name: `T${i}-SOL`, base_mint: mint, deployed_at: new Date(Date.now() - 3600e3).toISOString(),
      closed_at: new Date().toISOString(), pnl_pct: -0.3, range_efficiency: 50, minutes_held: 60,
      close_reason: reason, strategy: "curve", ...extra,
    });
    return { pool, mint };
  };

  console.log("\n[1] low-yield cooldown (pool)");
  for (const reason of [
    "low yield",                                                            // old LLM text
    "Low yield: fee/TVL 1.46% < min 5% [pnl_api] (age: 75m, depth=20% strat=curve)", // state.js LOW_YIELD
    "Rule 5: low yield (depth=60% strat=bid_ask)",                           // index.js Rule 5
  ]) {
    const { pool } = close(reason);
    check(`"${reason.slice(0, 40)}…" → pool cooldown`, pm.isPoolOnCooldown(pool));
  }
  check("unrelated reason → no cooldown", !pm.isPoolOnCooldown(close("Rule 6: max age reached (6h, grace exhausted)").pool));

  console.log("\n[2] emergency cooldown (pool + base mint)");
  for (const reason of [
    "Rule 8: rapid dump (drop<-4.0% vol=2×1.00 depth=90% strat=curve)",
    "Rule 7: volume collapse (sells>2.00× buys, vol=2×1.00 depth=90% strat=curve)",
    "Rule 11: liquidity collapse ($400 < 40% of peak $5000, depth=90% strat=bid_ask)",
  ]) {
    const { pool, mint } = close(reason, { pnl_pct: -9 });
    check(`"${reason.slice(0, 32)}…" → pool cooldown`, pm.isPoolOnCooldown(pool));
    check(`"${reason.slice(0, 32)}…" → base-mint cooldown`, pm.isBaseMintOnCooldown(mint));
  }
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  if (backup) fs.writeFileSync(FILE, backup);
  else { try { fs.unlinkSync(FILE); } catch (_) { /* ignore */ } }
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
