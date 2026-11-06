// Verifies the LLM-call reductions: the screening cycle gets a narrowed tool list and no forced
// tool call (live: get_pool_memory 93×, smart wallets 21× in 3 days for data already in the
// candidate blocks), while chat/REPL SCREENER calls keep the full role tools. Also: deploy strategy
// enum matches the executor, no per-candidate TA fetch, LPAgent stops after a 401. Real modules + drift.
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
  const { selectTools } = await import("../agent.js");
  const names = (list) => list.map(t => t.function.name).sort();
  const cycleTools = ["deploy_position", "get_token_holders", "get_token_narrative", "get_token_info"];

  console.log("\n[1] selectTools");
  const full = names(selectTools("SCREENER", "SCREENING CYCLE"));
  check("no allowlist → full SCREENER set (chat/REPL deploys)", full.includes("get_top_candidates") && full.includes("get_active_bin") && full.includes("get_pool_memory"));
  const narrowed = names(selectTools("SCREENER", "SCREENING CYCLE", cycleTools));
  check("allowlist → exactly the 4 screening-cycle tools", JSON.stringify(narrowed) === JSON.stringify([...cycleTools].sort()), `(got ${narrowed})`);
  check("allowlist cannot add tools outside the role", names(selectTools("SCREENER", "x", ["close_position", "deploy_position"])).join() === "deploy_position");

  console.log("\n[2] wiring");
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8");
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("agentLoop sends the selected tools", /tools: callTools,/.test(agent));
  check("requireToolUse overrides tool-use inference", agent.includes("const mustUseRealTool = requireToolUse ?? shouldRequireRealToolUse("));
  check("requireToolUse overrides forced tool_choice on step 0", agent.includes("(step === 0 && (requireToolUse ?? (ACTION_INTENTS.test(goal) || mustUseRealTool)))"));
  check("index.js screening-cycle tool list", index.includes(`const SCREENING_CYCLE_TOOLS = ${JSON.stringify(cycleTools).replace(/,/g, ", ")};`));
  check("screening cycle passes allowedTools + requireToolUse:false", /allowedTools: SCREENING_CYCLE_TOOLS,\s*requireToolUse: false,/.test(index));

  console.log("\n[3] deploy strategy consistency (live: 836 SAFETY_BLOCKs in 30 days)");
  const { tools } = await import("../tools/definitions.js");
  const deploy = tools.find(t => t.function.name === "deploy_position");
  const en = deploy.function.parameters.properties.strategy.enum;
  check("deploy_position strategy enum is curve/bid_ask", JSON.stringify(en) === JSON.stringify(["curve", "bid_ask"]), `(got ${JSON.stringify(en)})`);
  check("screening goal no longer injects the strategy-library entry", !index.includes("getActiveStrategy()") && index.includes("Strategy and bins: follow DEPLOY RULES"));
  const prompt = fs.readFileSync(new URL("../prompt.js", import.meta.url), "utf8");
  check("no per-candidate TA entry fetch/line", !index.includes("taEntry") && !index.includes("ta_entry") && !prompt.includes("ta_entry"));

  console.log("\n[4] LPAgent stops after a rejected key");
  process.env.LPAGENT_API_KEY = "stale-key";
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{"message":"Unauthorized"}', { status: 401 }); };
  try {
    const { fetchLpAgentOpenPositions } = await import("../tools/dlmm.js");
    const a = await fetchLpAgentOpenPositions("TestOwner1111111111111111111111111111111111");
    const b = await fetchLpAgentOpenPositions("TestOwner1111111111111111111111111111111111");
    check("401 → empty result, second call skips the HTTP request", JSON.stringify(a) === "{}" && JSON.stringify(b) === "{}" && calls === 1, `(calls ${calls})`);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LPAGENT_API_KEY;
  }
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
