// Verifies Jupiter order requests retry on 429 (tools/wallet.js). Live logs: 6 of 98 swaps failed
// with "429 Too many requests" on the first order request of an auto-swap after close, leaving
// the base token (CALI $110, e/acc $125, CAKE $88, …) in the wallet. Real module, stubbed fetch.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const realFetch = globalThis.fetch;
function stubFetch(statuses) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return new Response(JSON.stringify({ status }), { status });
  };
  return calls;
}

try {
  const { fetchWithRateLimitRetry } = await import("../tools/wallet.js");
  const fast = [1, 1, 1];

  console.log("\n[1] retry behaviour");
  let calls = stubFetch([429, 429, 200]);
  let res = await fetchWithRateLimitRetry("https://x/order", {}, "test", fast);
  check("429, 429, 200 → succeeds on 3rd call", res.status === 200 && calls.length === 3, `(status ${res.status}, calls ${calls.length})`);

  calls = stubFetch([429]);
  res = await fetchWithRateLimitRetry("https://x/order", {}, "test", fast);
  check("persistent 429 → gives up after 1 + 3 retries", res.status === 429 && calls.length === 4, `(calls ${calls.length})`);

  calls = stubFetch([400]);
  res = await fetchWithRateLimitRetry("https://x/order", {}, "test", fast);
  check("400 is not retried", res.status === 400 && calls.length === 1);

  calls = stubFetch([200]);
  res = await fetchWithRateLimitRetry("https://x/order", {}, "test", fast);
  check("200 → single call", res.status === 200 && calls.length === 1);

  console.log("\n[2] wired into swapToken");
  const src = fs.readFileSync(new URL("../tools/wallet.js", import.meta.url), "utf8");
  check("order request uses fetchWithRateLimitRetry", /await fetchWithRateLimitRetry\(orderUrl,/.test(src));
  check("default delays 2s/5s/10s", src.includes("const RATE_LIMIT_RETRY_DELAYS_MS = [2000, 5000, 10000];"));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  globalThis.fetch = realFetch;
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
