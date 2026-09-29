// Verifies HiveMind shared lessons stay out of the LLM prompt unless hiveMindLessonsInPrompt=true.
// Live hivemind-cache.json held only test data ("TEST-SOL … Reason: test close", undefined fields),
// injected as lessons next to the bot's own. Real modules; hivemind-cache.json is backed up/restored.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

const FILE = new URL("../hivemind-cache.json", import.meta.url);
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  fs.writeFileSync(FILE, JSON.stringify({
    sharedLessons: [{ id: "x1", rule: "FAILED: TEST-SOL, strategy=spot → PnL -30.93%. Reason: test close.", score: 5 }],
    presets: [],
  }));
  const { config } = await import("../config.js");
  const { getSharedLessonsForPrompt } = await import("../hivemind.js");
  const { getLessonsForPrompt } = await import("../lessons.js");

  console.log("\n[1] default: off");
  check("config default lessonsInPrompt=false", config.hiveMind.lessonsInPrompt === false);
  check("getSharedLessonsForPrompt → null", getSharedLessonsForPrompt({ agentType: "SCREENER" }) === null);
  const prompt = getLessonsForPrompt({ agentType: "SCREENER" }) || "";
  check("lessons prompt has no HIVEMIND section", !prompt.includes("HIVEMIND") && !prompt.includes("TEST-SOL"));

  console.log("\n[2] opt-in: on");
  config.hiveMind.lessonsInPrompt = true;
  const shared = getSharedLessonsForPrompt({ agentType: "SCREENER" }) || "";
  check("shared lessons returned when enabled", shared.includes("[HIVEMIND score=5]") && shared.includes("TEST-SOL"));
  config.hiveMind.lessonsInPrompt = false;

  console.log("\n[3] not LLM-toggleable");
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  check("hiveMindLessonsInPrompt not in update_config", !exec.includes("hiveMindLessonsInPrompt") && !exec.includes("lessonsInPrompt"));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  if (backup) fs.writeFileSync(FILE, backup);
  else { try { fs.unlinkSync(FILE); } catch (_) { /* ignore */ } }
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
