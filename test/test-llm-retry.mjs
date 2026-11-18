// Verifies agent.js retries OpenRouter "Provider timed out" body errors once (live: 12 in 3 days,
// none retried, 4 management + 2 screening cycles failed) and logs why a response came back empty
// (live: 180 of 637 LLM calls). Real module import + source-drift checks.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  const { isTransientProviderError } = await import("../agent.js");
  const timeout = { error: { message: "Provider timed out after 143000ms" } };

  console.log("\n[1] transient classification");
  check("timeout body, attempt 0 → retry", isTransientProviderError(timeout, 0) === true);
  check("timeout body, attempt 1 → give up", isTransientProviderError(timeout, 1) === false);
  check("code 504, attempt 0 → retry", isTransientProviderError({ error: { code: 504 } }, 0) === true);
  check("502/503/529 still retried on later attempts", [502, 503, 529].every((c) => isTransientProviderError({ error: { code: c } }, 1)));
  check("400 not retried", isTransientProviderError({ error: { code: 400, message: "bad request" } }, 0) === false);
  check("no error object → not retried", isTransientProviderError({}, 0) === false);

  console.log("\n[2] wiring");
  const src = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8");
  check("retry loop uses isTransientProviderError", /if \(isTransientProviderError\(response, attempt\)\)/.test(src));
  check("empty response logs finish_reason", /Empty response \(finish_reason=/.test(src));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
