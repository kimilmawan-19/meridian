// Verifies the one-deploy-at-a-time lock (tools/executor.js: runExclusiveDeploy, executeTool).
// Live 2026-10-22 (CLAUDIA-SOL): the LLM sent two deploy_position calls in one response. agent.js runs the
// calls of one response in parallel, its one-deploy-per-session guard is filled only after a deploy
// returns, and both safety checks read the same position list before either deploy had landed, so two
// identical positions were opened 1.5 s apart. Now a second call while one is running is refused with
// { blocked: true }, the lock is released in finally, and a lock older than 5 minutes is ignored.
// Real module; the network is stubbed (fetch) and no transaction can be sent (the safety check refuses).
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

const realFetch = globalThis.fetch;
const realConsoleLog = console.log;

try {
  const { runExclusiveDeploy, executeTool, DEPLOY_LOCK_STALE_MS } = await import("../tools/executor.js");
  const STALE = DEPLOY_LOCK_STALE_MS;

  console.log("\n[1] runExclusiveDeploy");
  check("the lock goes stale after 5 minutes", STALE === 5 * 60_000, String(STALE));
  const solo = await runExclusiveDeploy(async () => ({ success: true, position: "P1" }), () => 1000);
  check("a single call runs and returns its result", solo.success === true && solo.position === "P1", JSON.stringify(solo));

  {
    const g = gate(); let ran = 0;
    const first = runExclusiveDeploy(async () => { ran++; await g.p; return { success: true, position: "A" }; }, () => 2000);
    const second = await runExclusiveDeploy(async () => { ran++; return { success: true, position: "B" }; }, () => 2000);
    check("second call while the first runs → { blocked: true } with a reason", second.blocked === true && /already running/.test(second.reason ?? "") && second.success === undefined && second.error === undefined, JSON.stringify(second));
    check("the second call's function never ran", ran === 1, `ran=${ran}`);
    g.open();
    const r1 = await first;
    check("the first call still returns its own result", r1.success === true && r1.position === "A", JSON.stringify(r1));
    const third = await runExclusiveDeploy(async () => { ran++; return { success: true, position: "C" }; }, () => 2001);
    check("after the first finishes the next call runs", third.position === "C" && ran === 2, `${JSON.stringify(third)} ran=${ran}`);
  }

  {
    const g = gate(); let ran = 0;
    const run = async () => { ran++; await g.p; return { success: true }; };
    const calls = [1, 2, 3].map(() => runExclusiveDeploy(run, () => 3000));
    g.open();
    const out = await Promise.all(calls);
    check("three calls at once: one runs, two are refused", ran === 1 && out[0].success === true && out.filter((r) => r.blocked).length === 2, `ran=${ran} ${JSON.stringify(out)}`);
  }

  {
    let threw = null;
    try { await runExclusiveDeploy(async () => { throw new Error("boom"); }, () => 4000); } catch (e) { threw = e; }
    check("an error thrown by the deploy still propagates", threw?.message === "boom");
    const after = await runExclusiveDeploy(async () => ({ success: true, position: "AFTER_THROW" }), () => 4001);
    check("the lock is released after an error", after.position === "AFTER_THROW", JSON.stringify(after));
    const errRes = await runExclusiveDeploy(async () => ({ error: "tx expired" }), () => 4002);
    const after2 = await runExclusiveDeploy(async () => ({ success: true, position: "AFTER_ERR" }), () => 4003);
    check("... and after a result that is an error", errRes.error === "tx expired" && after2.position === "AFTER_ERR", JSON.stringify([errRes, after2]));
  }

  {
    const g = gate();
    const first = runExclusiveDeploy(async () => { await g.p; return { success: true }; }, () => 0);
    const second = await runExclusiveDeploy(async () => ({ success: true }), () => 0);
    check("time 0 is a valid lock time (not read as 'no lock')", second.blocked === true, JSON.stringify(second));
    g.open(); await first;
  }

  {
    const T = 10_000, g1 = gate(), g2 = gate(), ran = [];
    const A = runExclusiveDeploy(async () => { ran.push("A"); await g1.p; return { success: true, id: "A" }; }, () => T);
    const B = await runExclusiveDeploy(async () => { ran.push("B"); return { id: "B" }; }, () => T + STALE - 1);
    check("a lock 1 ms short of 5 minutes still blocks", B.blocked === true && !ran.includes("B"), JSON.stringify(B));
    const C = runExclusiveDeploy(async () => { ran.push("C"); await g2.p; return { success: true, id: "C" }; }, () => T + STALE);
    check("a lock of exactly 5 minutes is stale: the next call runs", ran.includes("C"), ran.join());
    g1.open();
    const a = await A;
    check("the stale call finishing late does not release the newer lock", a.id === "A");
    const D = await runExclusiveDeploy(async () => { ran.push("D"); return { id: "D" }; }, () => T + STALE + 10);
    check("... so a call while the newer one runs is still refused", D.blocked === true && !ran.includes("D"), JSON.stringify(D));
    g2.open();
    const c = await C;
    const E = await runExclusiveDeploy(async () => { ran.push("E"); return { id: "E" }; }, () => T + STALE + 20);
    check("after the newer call finishes the lock is free again", c.id === "C" && E.id === "E", JSON.stringify([c, E]));
  }

  console.log("\n[2] real executeTool (network stubbed)");
  const args = { pool_address: "TestPool1111111111111111111111111111111111", pool_name: "TEST-SOL", strategy: "curve", amount_y: 1, bins_below: 40, bins_above: 6, volatility: 2 };
  const emptyDetail = { ok: true, status: 200, json: async () => ({ data: [] }) };
  let fetchCalls = 0;
  {
    const g = gate();
    globalThis.fetch = async () => { fetchCalls++; await g.p; return emptyDetail; };
    const p1 = executeTool("deploy_position", args);
    const lines = [];
    console.log = (...a) => { lines.push(a.join(" ")); };
    const r2 = await executeTool("deploy_position", { ...args });
    console.log = realConsoleLog;
    check("second deploy_position in the same step is refused by the lock", r2.blocked === true && /already running/.test(r2.reason ?? ""), JSON.stringify(r2));
    check("it never reached the safety checks (one fetch only)", fetchCalls === 1, `fetchCalls=${fetchCalls}`);
    check("the refusal is logged as a safety block", lines.some((l) => /\[SAFETY_BLOCK\] deploy_position blocked: another deploy_position call is already running/.test(l)), lines.join(" | ").slice(0, 200));
    g.open();
    const r1 = await p1;
    check("the first call ran its own safety check (refused by it, not by the lock)", r1.blocked === true && /Could not verify pool screening thresholds/.test(r1.reason ?? ""), JSON.stringify(r1));
    const r3 = await executeTool("deploy_position", args);
    check("the lock is free afterwards: the next call runs its safety check again", r3.blocked === true && /Could not verify pool screening thresholds/.test(r3.reason ?? "") && fetchCalls === 2, `${JSON.stringify(r3)} fetchCalls=${fetchCalls}`);
  }
  {
    const g = gate(); fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; await g.p; return emptyDetail; };
    const q1 = executeTool("deploy_position<|channel|>commentary", args);
    const q2 = await executeTool("deploy_position", args);
    check("a tool name with a model artifact takes the same lock", q2.blocked === true && /already running/.test(q2.reason ?? "") && fetchCalls === 1, `${JSON.stringify(q2)} fetchCalls=${fetchCalls}`);
    const [s1, s2] = await Promise.all([executeTool("list_strategies", {}), executeTool("list_strategies", {})]);
    check("other tools stay parallel and unblocked while a deploy runs", !s1.blocked && !s2.blocked && !s1.error && !s2.error, JSON.stringify([s1, s2]).slice(0, 200));
    g.open();
    await q1;
  }

  console.log("\n[3] wiring (source)");
  const src = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  const wrapStart = src.indexOf("export async function executeTool(");
  const innerStart = src.indexOf("async function executeToolUnlocked(");
  const wrap = src.slice(wrapStart, innerStart);
  const inner = src.slice(innerStart, src.indexOf("async function runSafetyChecks("));
  check("executeTool sends only deploy_position through the lock", wrapStart > 0 && innerStart > wrapStart && /toolName !== "deploy_position"\) return executeToolUnlocked\(name, args\);/.test(wrap) && /return runExclusiveDeploy\(\(\) => executeToolUnlocked\(name, args\)\);/.test(wrap), wrap);
  check("the model-artifact suffix is stripped before the comparison", /name\.replace\(\/<\.\*\$\/, ""\)\.trim\(\)/.test(wrap));
  check("the unlocked body does not take the lock again (no deadlock)", innerStart > 0 && !inner.includes("runExclusiveDeploy("));
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const dl = idx.slice(idx.indexOf("async function deployLatestCandidate("), idx.indexOf("function appendHistory("));
  check("/deploy treats a blocked result as a failure (no false '✅ Deployed')", /result\?\.success === false \|\| result\?\.error \|\| result\?\.blocked/.test(dl) && /result\.reason/.test(dl), dl.slice(-300));
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8");
  check("agent.js: a blocked deploy result does not use up the session's single deploy", agent.includes("if (!result?.blocked) firedOnce.add(functionName);"));
} finally {
  globalThis.fetch = realFetch;
  console.log = realConsoleLog;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
