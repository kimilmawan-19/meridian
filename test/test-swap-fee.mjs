// Verifies the Jupiter swap fee (referral) settings in tools/wallet.js: when the order request
// carries a fee, when it is off, and that the fee is described for the startup log and /wallet.
// Real module, config mutated in place.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";
delete process.env.JUPITER_REFERRAL_ACCOUNT;
delete process.env.JUPITER_REFERRAL_FEE_BPS;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  const { config } = await import("../config.js");
  const { getJupiterReferralParams, describeSwapFee } = await import("../tools/wallet.js");
  const VALID_ACCOUNT = "So11111111111111111111111111111111111111112"; // any valid base58 pubkey
  const set = (referralAccount, referralFeeBps) => {
    config.jupiter.referralAccount = referralAccount;
    config.jupiter.referralFeeBps = referralFeeBps;
  };

  console.log("\n[1] defaults");
  check("default fee is 50 bps", config.jupiter.referralFeeBps === 50, `(${config.jupiter.referralFeeBps})`);
  check(
    "default account is not the old hard-coded foreign account",
    config.jupiter.referralAccount !== "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    `(${config.jupiter.referralAccount})`,
  );

  console.log("\n[2] fee on");
  set(VALID_ACCOUNT, 50);
  let p = getJupiterReferralParams();
  check("valid account + 50 bps → params", p?.referralAccount === VALID_ACCOUNT && p?.referralFee === 50, JSON.stringify(p));
  set(VALID_ACCOUNT, 255);
  check("255 bps (upper bound) accepted", getJupiterReferralParams()?.referralFee === 255);
  set(`  ${VALID_ACCOUNT}  `, 100);
  check("account is trimmed", getJupiterReferralParams()?.referralAccount === VALID_ACCOUNT);

  console.log("\n[3] fee off");
  set("", 50);
  check("empty account → null", getJupiterReferralParams() === null);
  set(VALID_ACCOUNT, 0);
  check("0 bps → null", getJupiterReferralParams() === null);
  set(VALID_ACCOUNT, 49);
  check("49 bps (below Jupiter minimum) → null", getJupiterReferralParams() === null);
  set(VALID_ACCOUNT, 256);
  check("256 bps (above maximum) → null", getJupiterReferralParams() === null);
  set(VALID_ACCOUNT, NaN);
  check("NaN bps → null", getJupiterReferralParams() === null);
  set("not-a-public-key", 50);
  check("invalid account → null", getJupiterReferralParams() === null);

  console.log("\n[4] description");
  set(VALID_ACCOUNT, 50);
  const on = describeSwapFee();
  check("on: shows bps and a shortened account", on.includes("50 bps") && on.includes("So11…1112") && !on.includes(VALID_ACCOUNT), on);
  set("", 50);
  check("off: says off", describeSwapFee() === "off", describeSwapFee());
  set(VALID_ACCOUNT, 0);
  check("0 bps: says off", describeSwapFee() === "off");
} catch (e) {
  fail++;
  console.log(`  ✗ test crashed: ${e.stack || e.message}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
