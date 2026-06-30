#!/usr/bin/env node
// Purge non-SOL-quote records (e.g. SOL-USDC stable-pair deploys from a different branch) from
// the bot's learning history so metrics/learning reflect only the single-sided-SOL strategy.
//
// This agent only deploys SOL-quoted pools; USDC/USDT-quoted losses pollute aggregate stats
// (tiny bin_step lands in the "80-100" bucket) and skew evolveThresholds. The live lessons.js
// already EXCLUDES these from learning at read time; this script physically removes them so the
// all-time PnL / history no longer counts them.
//
// Usage (run on the BOT machine, where the runtime JSON files live):
//   node scripts/purge-non-sol-records.mjs            # dry-run: report only, no changes
//   node scripts/purge-non-sol-records.mjs --apply    # back up, then delete matching records
//
// Always backs up to <file>.bak-<timestamp> before writing when --apply is set.

import fs from "fs";

const LESSONS_FILE = "./lessons.json";
const POOLMEM_FILE = "./pool-memory.json";
const APPLY = process.argv.includes("--apply");

// Mirror of lessons.js isSolQuoteRecord (kept in sync intentionally — standalone maintenance tool).
const NON_SOL_QUOTES = new Set(["USDC", "USDT", "USD", "USDH", "PYUSD", "USDS"]);
function isSolQuoteName(poolName, quoteSymbol) {
  const qs = String(quoteSymbol ?? "").toUpperCase().trim();
  if (qs) return qs === "SOL" || qs === "WSOL";
  const name = String(poolName ?? "");
  const seg = name.includes("-") ? name.split("-").pop().toUpperCase().trim() : "";
  if (seg) return !NON_SOL_QUOTES.has(seg);
  return true; // unparseable → keep (conservative)
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { console.error(`! Cannot parse ${file}: ${e.message}`); return null; }
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, dest);
  console.log(`  backed up → ${dest}`);
}

console.log(`\n=== purge-non-sol-records (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);

// ── lessons.json: performance[] + lessons[] ──────────────────────
const lessons = loadJson(LESSONS_FILE);
if (lessons) {
  const perf = Array.isArray(lessons.performance) ? lessons.performance : [];
  const lessonArr = Array.isArray(lessons.lessons) ? lessons.lessons : [];

  const perfNonSol = perf.filter((p) => !isSolQuoteName(p.pool_name, p.quote_symbol));
  // Only performance-derived lessons carry pool_name; aggregate/manual/evolution lessons are kept.
  const lessonNonSol = lessonArr.filter(
    (l) => l.sourceType === "performance" && l.pool && !isSolQuoteName(l.pool_name ?? l.context, l.quote_symbol)
  );

  const purgedPnl = perfNonSol.reduce((s, p) => s + (p.pnl_usd ?? 0), 0);
  console.log(`lessons.json:`);
  console.log(`  performance[] matched non-SOL : ${perfNonSol.length}/${perf.length}  (sum pnl_usd ${purgedPnl.toFixed(2)})`);
  console.log(`  lessons[] matched non-SOL     : ${lessonNonSol.length}/${lessonArr.length}`);
  if (perfNonSol.length) {
    const sample = perfNonSol.slice(0, 8).map((p) => `${p.pool_name ?? "?"}(${p.pnl_pct ?? "?"}%)`).join(", ");
    console.log(`  e.g. ${sample}${perfNonSol.length > 8 ? " …" : ""}`);
  }

  if (APPLY && (perfNonSol.length || lessonNonSol.length)) {
    backup(LESSONS_FILE);
    const nonSolPerfSet = new Set(perfNonSol);
    const nonSolLessonSet = new Set(lessonNonSol);
    lessons.performance = perf.filter((p) => !nonSolPerfSet.has(p));
    lessons.lessons = lessonArr.filter((l) => !nonSolLessonSet.has(l));
    // Drop stale aggregate snapshots — they'll be regenerated from clean data on the next refresh.
    lessons.lessons = lessons.lessons.filter((l) => !l.tags?.includes("aggregate"));
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2));
    console.log(`  ✓ removed; aggregate snapshots cleared (regenerate via /evolve or next 20 closes)`);
  }
}

// ── pool-memory.json: pool entries whose name is non-SOL-quote ───
const poolMem = loadJson(POOLMEM_FILE);
if (poolMem && typeof poolMem === "object") {
  const entries = Object.entries(poolMem);
  const nonSolPools = entries.filter(([, e]) => !isSolQuoteName(e?.name, null));
  console.log(`\npool-memory.json:`);
  console.log(`  pool entries matched non-SOL  : ${nonSolPools.length}/${entries.length}`);
  if (nonSolPools.length) {
    console.log(`  e.g. ${nonSolPools.slice(0, 8).map(([, e]) => e?.name ?? "?").join(", ")}${nonSolPools.length > 8 ? " …" : ""}`);
  }
  if (APPLY && nonSolPools.length) {
    backup(POOLMEM_FILE);
    for (const [addr] of nonSolPools) delete poolMem[addr];
    fs.writeFileSync(POOLMEM_FILE, JSON.stringify(poolMem, null, 2));
    console.log(`  ✓ removed ${nonSolPools.length} non-SOL pool entr${nonSolPools.length === 1 ? "y" : "ies"}`);
  }
}

console.log(`\n${APPLY ? "Done." : "Dry-run only — re-run with --apply to delete."}\n`);
