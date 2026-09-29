// Verifies the LLM-call reductions: the screening cycle gets a narrowed tool list and no forced
// tool call (live: get_pool_memory 93×, smart wallets 21× in 3 days for data already in the
// candidate blocks), while chat/REPL SCREENER calls keep the full role tools. Real module + drift.
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
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
