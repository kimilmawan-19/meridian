// Verifies entry-grace skip logs are written only on state transitions (index.js).
// Live logs/ reached 603 MB with ~20–35k identical "Rule X skipped … entry grace active"
// lines per day (every 30s poll × positions × rules). index.js is not importable, so the
// helpers are mirrored here and a source check guards against drift.
import fs from "fs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const lines = [];
const log = (_cat, msg) => lines.push(msg);

// Mirror of index.js
const _graceLogged = new Set();
function graceDetail(binsKnown, depthPct, graceDepth, strategy) {
  return `${binsKnown ? `depth=${depthPct.toFixed(1)}% vs grace ${graceDepth}%` : "bin data unavailable (fail-safe)"}, strategy=${strategy}`;
}
function logGraceTransition(rule, position, inGrace, detail) {
  const key = `${rule}:${position.position}`;
  if (inGrace && !_graceLogged.has(key)) {
    _graceLogged.add(key);
    log("market_data", `Rule ${rule} skipped for ${position.pair}: entry grace active (${detail})`);
  } else if (!inGrace && _graceLogged.delete(key)) {
    log("market_data", `Rule ${rule} entry grace ended for ${position.pair} (${detail})`);
  }
}
function pruneGraceLogged(openPositions) {
  const open = new Set(openPositions.map((p) => p.position));
  for (const key of _graceLogged) if (!open.has(key.slice(key.indexOf(":") + 1))) _graceLogged.delete(key);
}

try {
  const A = { position: "PosA", pair: "A-SOL" };
  const B = { position: "PosB", pair: "B-SOL" };
  const d = (x) => graceDetail(true, x, 95, "bid_ask");

  console.log("\n[1] one line per transition, not per poll");
  for (let i = 0; i < 120; i++) for (const r of [7, 8, 9, 11]) logGraceTransition(r, A, true, d(20)); // 1h of polls
  check("120 polls × 4 rules in grace → 4 lines (was 480)", lines.length === 4, `(got ${lines.length})`);
  logGraceTransition(7, A, false, d(96));
  check("leaving grace logs one 'ended' line", lines.length === 5 && /Rule 7 entry grace ended for A-SOL \(depth=96\.0% vs grace 95%/.test(lines[4]), lines[4]);
  logGraceTransition(7, A, false, d(97));
  check("staying out of grace logs nothing", lines.length === 5);
  logGraceTransition(7, A, true, d(40));
  check("re-entering grace logs again", lines.length === 6 && /Rule 7 skipped for A-SOL: entry grace active/.test(lines[5]));
  logGraceTransition(7, B, true, d(10));
  check("each position tracked separately", lines.length === 7 && lines[6].includes("B-SOL"));
  check("fail-safe detail when bins unknown", graceDetail(false, 0, 95, "curve") === "bin data unavailable (fail-safe), strategy=curve");

  console.log("\n[2] pruning closed positions");
  pruneGraceLogged([B]);
  check("closed position keys removed", ![..._graceLogged].some((k) => k.endsWith(":PosA")));
  check("open position keys kept", _graceLogged.has("7:PosB"));
  pruneGraceLogged([]);
  check("all positions gone → set empty", _graceLogged.size === 0);

  console.log("\n[3] mirrors match index.js");
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("logGraceTransition identical", src.includes(logGraceTransition.toString()));
  check("graceDetail identical", src.includes(graceDetail.toString()));
  check("pruneGraceLogged identical", src.includes(pruneGraceLogged.toString()));
  for (const r of [5, 7, 8, 9, 11]) check(`Rule ${r} uses logGraceTransition`, src.includes(`logGraceTransition(${r}, position, inEntryAccumulation${r},`));
  check("no per-poll 'entry grace active' log left", (src.match(/entry grace active/g) || []).length === 1);
  check("prune runs in management finally", src.includes("pruneGraceLogged(positions);"));
} catch (e) {
  fail++;
  console.error("\nFATAL:", e.stack);
} finally {
  console.log(`\n──────────────\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
