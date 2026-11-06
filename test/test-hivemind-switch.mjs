// Verifies the HiveMind off switch (hiveMindEnabled=false in user-config.json): no heartbeat, pull or
// push request leaves the bot, and cached shared lessons stay out of the prompt even when
// hiveMindLessonsInPrompt is true. The default stays on. Real modules; fetch is stubbed and counted;
// hivemind-cache.json is backed up/restored; config.js is copied to a temp dir to test the file parsing.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const CACHE = new URL("../hivemind-cache.json", import.meta.url);
const backup = fs.existsSync(CACHE) ? fs.readFileSync(CACHE) : null;
const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; };
let tmp = null;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  const { config } = await import("../config.js");
  const hive = await import("../hivemind.js");
  config.hiveMind.agentId = "agt_test"; // keeps ensureAgentId from writing user-config.json

  console.log("\n[1] on: requests go out");
  config.hiveMind.enabled = true;
  calls = 0;
  check("isHiveMindEnabled → true", hive.isHiveMindEnabled() === true);
  await hive.registerHiveMindAgent({ reason: "test" });
  check("register calls fetch", calls === 1, `calls=${calls}`);
  await hive.pushHiveLesson({ id: 1, rule: "test rule" });
  check("lesson push calls fetch", calls === 2, `calls=${calls}`);

  console.log("\n[2] off: nothing leaves the bot");
  config.hiveMind.enabled = false;
  calls = 0;
  check("isHiveMindEnabled → false", hive.isHiveMindEnabled() === false);
  check("register → null", (await hive.registerHiveMindAgent({ reason: "test" })) === null);
  check("lesson pull → null", (await hive.pullHiveMindLessons()) === null);
  check("preset pull → null", (await hive.pullHiveMindPresets()) === null);
  check("bootstrap → null", (await hive.bootstrapHiveMind()) === null);
  check("background sync → null (no timer)", hive.startHiveMindBackgroundSync() === null);
  check("lesson push → null", (await hive.pushHiveLesson({ id: 2, rule: "test rule" })) === null);
  check("performance push → null", (await hive.pushHivePerformanceEvent({
    pool: "p", pool_name: "T-SOL", close_reason: "test", pnl_usd: 1, pnl_pct: 1, recorded_at: new Date().toISOString(),
  })) === null);
  check("no request was made", calls === 0, `calls=${calls}`);

  console.log("\n[3] off keeps cached shared lessons out of the prompt");
  fs.writeFileSync(CACHE, JSON.stringify({
    sharedLessons: [{ id: "x1", rule: "AVOID thin pools after a pump.", score: 5 }],
    presets: [],
  }));
  config.hiveMind.lessonsInPrompt = true;
  config.hiveMind.enabled = false;
  check("lessonsInPrompt true + off → null", hive.getSharedLessonsForPrompt({ agentType: "SCREENER" }) === null);
  config.hiveMind.enabled = true;
  check("lessonsInPrompt true + on → lesson returned", (hive.getSharedLessonsForPrompt({ agentType: "SCREENER" }) || "").includes("AVOID thin pools"));
  config.hiveMind.lessonsInPrompt = false;

  console.log("\n[4] user-config.json parsing (real config.js, copied)");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-switch-"));
  fs.copyFileSync(new URL("../config.js", import.meta.url), path.join(tmp, "config.js"));
  let n = 0;
  const enabledFor = async (userConfig) => {
    const file = path.join(tmp, "user-config.json");
    if (userConfig === undefined) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(userConfig));
    const mod = await import(`${pathToFileURL(path.join(tmp, "config.js")).href}?v=${++n}`);
    return mod.config.hiveMind.enabled;
  };
  check("no user-config.json → on", (await enabledFor(undefined)) === true);
  check("key absent → on", (await enabledFor({})) === true);
  check("hiveMindEnabled true → on", (await enabledFor({ hiveMindEnabled: true })) === true);
  check("hiveMindEnabled false → off", (await enabledFor({ hiveMindEnabled: false })) === false);
  check('string "false" does not turn it off (only JSON false does)', (await enabledFor({ hiveMindEnabled: "false" })) === true);

  console.log("\n[5] not LLM-toggleable");
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  check("hiveMindEnabled not in update_config", !exec.includes("hiveMindEnabled"));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  globalThis.fetch = realFetch;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (backup) fs.writeFileSync(CACHE, backup);
  else { try { fs.unlinkSync(CACHE); } catch (_) { /* ignore */ } }
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
