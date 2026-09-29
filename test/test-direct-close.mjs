// Verifies the direct deterministic-close path (index.js runManagementCycle): CLOSE actions are
// executed via executeTool("close_position") in code instead of being handed to the LLM.
// [1] real executeTool round-trip in DRY_RUN — result shape is recognised as success.
// [2] failure-detection predicate + LLM routing filter (mirrors index.js, which is not importable).
// CLAIM is executed directly as well (claim_fees); via the LLM it cost ~59 calls/day.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// Same predicate as index.js direct-close loop.
const closeFailed = (res) => !res || !!res.error || !!res.blocked || res.success === false;
// Same filter as index.js: LLM only gets judgment calls.
const sentToLlm = (a) => a.action !== "STAY" && a.action !== "CLOSE" && a.action !== "CLAIM";

try {
  const { executeTool } = await import("../tools/executor.js");

  console.log("\n[1] real executeTool('close_position') in DRY_RUN");
  const res = await executeTool("close_position", {
    position_address: "DirectClose1111111111111111111111111111111",
    reason: "Rule 1: break-even stop",
  });
  check("DRY_RUN close returns a dry_run result", res?.dry_run === true, `(got ${JSON.stringify(res)})`);
  check("DRY_RUN result is treated as success (not retried)", closeFailed(res) === false);

  console.log("\n[2] failure detection");
  check("null result → failed", closeFailed(null) === true);
  check("{error} → failed", closeFailed({ error: "RPC timeout" }) === true);
  check("{blocked} → failed", closeFailed({ blocked: true, reason: "safety" }) === true);
  check("{success:false} → failed", closeFailed({ success: false, error: "tx failed" }) === true);
  check("{success:true} → ok", closeFailed({ success: true, pnl_pct: 1.2 }) === false);

  console.log("\n[3] LLM routing");
  check("CLOSE is not sent to the LLM", sentToLlm({ action: "CLOSE", rule: 1 }) === false);
  check("STAY is not sent to the LLM", sentToLlm({ action: "STAY" }) === false);
  check("TP_PROPOSAL still goes to the LLM", sentToLlm({ action: "TP_PROPOSAL" }) === true);
  check("INSTRUCTION still goes to the LLM", sentToLlm({ action: "INSTRUCTION" }) === true);
  check("CLAIM is not sent to the LLM", sentToLlm({ action: "CLAIM" }) === false);

  console.log("\n[4] direct claim");
  const claim = await executeTool("claim_fees", { position_address: "DirectClaim1111111111111111111111111111111" });
  check("DRY_RUN claim_fees is treated as success", closeFailed(claim) === false, `(got ${JSON.stringify(claim)})`);
  const src = (await import("fs")).readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("index.js filter matches this test", src.includes('return a.action !== "STAY" && a.action !== "CLOSE" && a.action !== "CLAIM";'));
  check("index.js executes claim_fees directly", src.includes('await executeTool("claim_fees", { position_address: p.position })'));

} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
