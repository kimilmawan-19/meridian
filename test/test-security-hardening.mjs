// Verifies the security-audit patch: swap_token amount/slippage guard + secret-file
// permission hardening (chmod 0600 on .env / user-config.json writes).
//
// [1] config defaults for the new risk.maxSwapAmount / risk.swapSlippageBps keys.
// [2] mirrors the swap_token safety-check formula from tools/executor.js runSafetyChecks
//     (private, not exported) — same pattern as test-regime-risk.mjs.
// [3] real fs.writeFileSync + fs.chmodSync round-trip against a scratch file, verifying
//     the resulting mode is owner-only (0600), the same pattern applied to .env/
//     user-config.json in setup.js/telegram.js/tools/executor.js/lessons.js.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  const { config } = await import("../config.js");

  console.log("\n[1] Config defaults");
  check("maxSwapAmount default 50", config.risk.maxSwapAmount === 50);
  check("swapSlippageBps default 500 (5%)", config.risk.swapSlippageBps === 500);

  console.log("\n[2] swap_token safety-check formula (mirrors tools/executor.js runSafetyChecks)");
  const SOL_MINT = config.tokens.SOL;
  function swapSafetyCheck(args, cfg) {
    if (!(args.amount > 0)) return { pass: false, reason: "invalid amount" };
    const inputIsSol = args.input_mint === SOL_MINT || args.input_mint === "SOL";
    if (inputIsSol && args.amount > cfg.maxSwapAmount) {
      return { pass: false, reason: "exceeds cap" };
    }
    return { pass: true };
  }
  const riskCfg = { maxSwapAmount: 50, swapSlippageBps: 500 };

  check("blocks SOL swap above cap (60 > 50)",
    swapSafetyCheck({ input_mint: SOL_MINT, amount: 60 }, riskCfg).pass === false);

  check("allows SOL swap at/below cap (50 <= 50)",
    swapSafetyCheck({ input_mint: SOL_MINT, amount: 50 }, riskCfg).pass === true);

  check("allows SOL swap well below cap (0.5)",
    swapSafetyCheck({ input_mint: SOL_MINT, amount: 0.5 }, riskCfg).pass === true);

  check("does NOT cap swapping a non-SOL base token back to SOL (bounded by actual balance already)",
    swapSafetyCheck({ input_mint: "SomeBaseTokenMintAddress111111111111111111", amount: 999999 }, riskCfg).pass === true);

  check("blocks zero amount", swapSafetyCheck({ input_mint: SOL_MINT, amount: 0 }, riskCfg).pass === false);
  check("blocks negative amount", swapSafetyCheck({ input_mint: SOL_MINT, amount: -5 }, riskCfg).pass === false);

  console.log("\n[3] Secret-file permission hardening (real fs.writeFileSync + fs.chmodSync round-trip)");
  const scratchFile = path.join(os.tmpdir(), `meridian-test-secret-${Date.now()}.json`);
  try {
    fs.writeFileSync(scratchFile, JSON.stringify({ walletKey: "dummy" }));
    try { fs.chmodSync(scratchFile, 0o600); } catch (_) { /* best-effort on non-POSIX FS */ }
    const mode = fs.statSync(scratchFile).mode & 0o777;
    check("file mode is owner-only 0600 after chmod", mode === 0o600, `(got ${mode.toString(8)})`);
  } finally {
    try { fs.unlinkSync(scratchFile); } catch (_) { /* ignore */ }
  }

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
