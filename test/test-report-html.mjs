// Verifies the HTML report (report-html.js) and the shortened briefing text (briefing.js).
//   [1] close-reason categories are case-insensitive
//   [2] trailingLevels() matches updatePnlAndCheckExits() in state.js (drift guard; real module round-trip)
//   [3] period numbers (1 / 7 / 30 / 60 days, since 30 Sep, all) from a small hand-built fixture
//   [4] the file is static and safe: no script, no outside URL, injected HTML is escaped
//   [5] the briefing text and the report show the same 24h numbers; Lessons is condensed
//   [6] modes (briefing / viz), file names, caption, empty data, live positions unavailable
// Backs up + restores state.json for [2]. Set DUMP=<file> to write the rendered fixture report.
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY ||= "test-key";
process.env.OPENROUTER_API_KEY ||= "test-key";

import fs from "fs";

const STATE_FILE = "./state.json";
const stateBackup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

try {
  const R = await import("../report-html.js");
  const { collectBriefingStats, generateBriefing, truncateText, lessonType } = await import("../briefing.js");
  const { config } = await import("../config.js");

  // ─────────────────────────────────────────────────────────────
  console.log("\n[1] close-reason categories");
  const cat = R.closeCategory;
  check("stop loss", cat("Stop loss: PnL -10.2% <= -10%") === "stop loss");
  check("case-insensitive", cat("STOP LOSS: pnl -9%") === "stop loss" && cat("trailing tp: GIVE-BACK floor") === "trailing");
  check("break-even", cat("Rule 1: break-even stop") === "break-even");
  check("trailing (give-back floor, grace expired)", cat("Trailing TP: give-back floor (peak 6%)") === "trailing" && cat("x in-range grace expired") === "trailing");
  check("low yield (Rule 5 and 'Low yield:')", cat("Rule 5: low yield (fee/TVL 0.04)") === "low yield" && cat("Low yield: fee/TVL 0.03 < min") === "low yield");
  check("max age", cat("Rule 6: max age 612m") === "max age");
  check("OOR (Rule 3 / Rule 4)", cat("Rule 3: pumped above range") === "OOR" && cat("Rule 4: OOR below") === "OOR");
  check("Rule 10 trim", cat("Rule 10: trim to cap") === "Rule 10");
  check("emergency rules 7/9/11", cat("Rule 7: volume collapse") === "darurat" && cat("Rule 9: sell pressure") === "darurat" && cat("Rule 11: liquidity collapse") === "darurat");
  check("unknown / empty → lain", cat("agent decision") === "lain" && cat(null) === "lain");

  // ─────────────────────────────────────────────────────────────
  console.log("\n[2] trailingLevels() vs updatePnlAndCheckExits()");
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions: {}, recentEvents: [] }, null, 2));
  const state = await import("../state.js");
  const mgmt = config.management;
  const open = (addr) => {
    state.trackPosition({
      position: addr, pool: `Pool-${addr}`, pool_name: "DRIFT-SOL", strategy: "curve",
      bin_range: { min: 100, max: 200 }, amount_sol: 1, active_bin: 150,
      bin_step: 100, volatility: 2, fee_tvl_ratio: 2, organic_score: 80, initial_value_usd: 100,
    });
    state.queuePeakConfirmation(addr, 8, { immediate: true });
    // First poll arms trailing (peak 8 >= trigger); PnL 7.5 is above every trigger below, so no exit.
    state.updatePnlAndCheckExits(addr, poll(7.5, true), mgmt);
  };
  const poll = (pnl, inRange) => ({ pnl_pct: pnl, in_range: inRange, age_minutes: 120, total_value_usd: 100, collected_fees_usd: 0, unclaimed_fees_usd: 1, fee_per_tvl_24h: 20 });

  const A = "DriftPosA11111111111111111111111111111111111";
  open(A);
  const levA = R.trailingLevels(state.getTrackedPosition(A), mgmt, "healthy");
  check("peak 8, healthy: trigger = 8 − max(1.5, 8/3) = 5.333", Math.abs(levA.trigger - (8 - 8 / 3)) < 1e-9, JSON.stringify(levA));
  check("floor = 8 − 8/2 = 4", Math.abs(levA.floor - 4) < 1e-9);
  const above = state.updatePnlAndCheckExits(A, poll(levA.trigger + 0.05, false), mgmt, "healthy");
  const below = state.updatePnlAndCheckExits(A, poll(levA.trigger - 0.05, false), mgmt, "healthy");
  check("OOR just above the reported trigger → no exit", above == null, JSON.stringify(above));
  check("OOR just below the reported trigger → TRAILING_TP", below?.action === "TRAILING_TP", JSON.stringify(below));

  const B = "DriftPosB11111111111111111111111111111111111";
  open(B);
  const levB = R.trailingLevels(state.getTrackedPosition(B), mgmt, "caution");
  check("caution scales the drop by 0.8: trigger = 8 − (8/3 × 0.8)", Math.abs(levB.trigger - (8 - (8 / 3) * 0.8)) < 1e-9, JSON.stringify(levB));
  check("caution OOR above trigger → no exit", state.updatePnlAndCheckExits(B, poll(levB.trigger + 0.05, false), mgmt, "caution") == null);
  check("caution OOR below trigger → TRAILING_TP", state.updatePnlAndCheckExits(B, poll(levB.trigger - 0.05, false), mgmt, "caution")?.action === "TRAILING_TP");

  const C = "DriftPosC11111111111111111111111111111111111";
  open(C);
  const levC = R.trailingLevels(state.getTrackedPosition(C), mgmt, "healthy");
  check("in range just above the floor → still deferred", state.updatePnlAndCheckExits(C, poll(levC.floor + 0.1, true), mgmt, "healthy") == null);
  check("in range just below the floor → TRAILING_TP at once", state.updatePnlAndCheckExits(C, poll(levC.floor - 0.1, true), mgmt, "healthy")?.action === "TRAILING_TP");

  check("not armed → null", R.trailingLevels({ trailing_active: false, peak_pnl_pct: 5 }, mgmt) === null && R.trailingLevels(null, mgmt) === null);
  check("trailing disabled → null", R.trailingLevels({ trailing_active: true, peak_pnl_pct: 5 }, { ...mgmt, trailingTakeProfit: false }) === null);
  const stale = R.trailingLevels({ trailing_active: true, peak_pnl_pct: 6, peak_pnl_at: new Date(Date.now() - 200 * 60_000).toISOString() }, mgmt, "healthy");
  const fresh = R.trailingLevels({ trailing_active: true, peak_pnl_pct: 6, peak_pnl_at: new Date().toISOString() }, mgmt, "healthy");
  check("stale peak widens the drop (trigger lower)", stale.trigger < fresh.trigger, `${stale.trigger} vs ${fresh.trigger}`);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[3] periods from a hand-built fixture");
  const NOW = Date.parse("2026-10-13T01:00:00Z"); // 08:00 WIB
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const H = 3600e3, D = 24 * H;
  const perf = [
    { recorded_at: ago(1 * H), pnl_usd: 10, pnl_pct: 5, close_reason: "Trailing TP: give-back floor (peak 6%)", fees_earned_usd: 3 },
    { recorded_at: ago(2 * H), pnl_usd: -12, pnl_pct: -10, close_reason: "Stop loss: PnL -10.2% <= -10%", fees_earned_usd: 1 },
    { recorded_at: ago(5 * H), pnl_usd: 2, pnl_pct: 1.5, close_reason: "Rule 5: low yield (fee/TVL 0.04 < min 0.09)", fees_earned_usd: 2 },
    { recorded_at: ago(23 * H), pnl_usd: 4, pnl_pct: 3, close_reason: "Rule 6: max age 600m", fees_earned_usd: 2.5 },
    { recorded_at: ago(30 * H), pnl_usd: -3, pnl_pct: -2.5, close_reason: "Rule 3: pumped above range", fees_earned_usd: 0 },
    { recorded_at: ago(3 * D), pnl_usd: 6, pnl_pct: 4, close_reason: "Rule 6: max age 610m", fees_earned_usd: 1 },
    { recorded_at: ago(40 * D), pnl_usd: 20, pnl_pct: 9, close_reason: "Rule 6: max age 700m", fees_earned_usd: 4 },
    { recorded_at: ago(100 * D), pnl_usd: -50, pnl_pct: -12, close_reason: "Stop loss: PnL -12% <= -12%", fees_earned_usd: 0 },
  ];
  const rule = (prefix, rest = "") => `${prefix}: ${rest || "x"}`;
  const lessons = [
    { rule: rule("WARN", "A-SOL dumped IN-RANGE (80% range-eff) → PnL -12% due to Stop loss: PnL -12% <= -10%. High in-range efficiency does NOT guarantee safety — token price fell within the bin range. strategy=curve, volatility=2.2, bin_step=100."), outcome: "bad", pnl_pct: -12, created_at: ago(1 * H) },
    { rule: rule("WORKED", "B-SOL, strategy=bid_ask → PnL +6%"), outcome: "good", pnl_pct: 6, created_at: ago(3 * H) },
    { rule: rule("AVOID", "C-SOL-type pools went OOR 70% of the time"), outcome: "bad", pnl_pct: -7, created_at: ago(4 * H) },
    { rule: "Operator note: keep size small on Fridays", sourceType: "manual", created_at: ago(2 * H) },
    { rule: "AGGREGATE: curve + bin_step 80-100 → 58% win, -0.2% avg PnL, 55.1% range-eff, 2.6% fee-yield (n=211, effN=23.2)", tags: ["aggregate", "curve"], created_at: ago(1 * H) },
    { rule: "AGGREGATE: bid_ask + bin_step 100-125 → 69% win, +1.1% avg PnL, 64.2% range-eff, 3.7% fee-yield (n=402, effN=44.2)", tags: ["aggregate", "bid_ask"], created_at: ago(1 * H) },
    { rule: rule("WARN", "old lesson"), outcome: "bad", pnl_pct: -9, created_at: ago(5 * D) },
  ];
  const stateData = { positions: {
    P1: { position: "P1", pool_name: "OCTO-SOL", strategy: "bid_ask", deployed_at: ago(3 * H), closed: false, peak_pnl_pct: 5.1, trailing_active: true, break_even_active: true, sl_pct_override: -15, peak_pnl_at: ago(10 * 60_000), signal_snapshot: { candidate_rank: 2, candidate_count: 7 } },
    P2: { position: "P2", pool_name: "DONE-SOL", deployed_at: ago(10 * H), closed: true, closed_at: ago(2 * H) },
    P3: { position: "P3", pool_name: "OLD-SOL", deployed_at: ago(30 * H), closed: true, closed_at: ago(26 * H) },
    P4: { position: "P4", pool_name: "HOT-SOL", strategy: "curve", deployed_at: ago(2 * H), closed: false, peak_pnl_pct: 0.4, sl_pct_override: -12 },
  } };
  const decisions = [
    { ts: ago(10 * 60_000), type: "skip", summary: "Screening skipped", reason: "Max positions reached (3/3)" },
    { ts: ago(20 * 60_000), type: "skip", summary: "Screening skipped", reason: "Max positions reached (3/3)" },
    { ts: ago(30 * 60_000), type: "skip", summary: "Screening skipped", reason: "Max positions reached (3/3)" },
    { ts: ago(40 * 60_000), type: "deploy", pool_name: "OCTO-SOL", position: "P1", summary: "Deployed 0.92 SOL with bid_ask", risks: ["volatility 4.6", "fee/TVL 2.41%"], metrics: { strategy: "bid_ask", amount_sol: 0.92 } },
    { ts: ago(50 * 60_000), type: "close", pool_name: "EVIL<img src=x onerror=alert(1)>-SOL", reason: "Stop loss: PnL -10.92% <= -10.2% \"><script>alert(1)</script>", metrics: { pnl_usd: -12, pnl_pct: -10.92, minutes_held: 82 } },
    { ts: ago(60 * 60_000), type: "no_deploy", summary: "No candidates available", reason: "All candidates filtered", rejected: ["SPEC-SOL: top10 64% > 60%", "X & Y: <b>bold</b>"] },
    { ts: ago(30 * H), type: "close", pool_name: "TOO-OLD-SOL", reason: "Rule 6", metrics: {} },
  ];
  const inputs = {
    perf, lessons, decisions, tracked: Object.values(stateData.positions),
    stats: collectBriefingStats(NOW, { state: stateData, lessonsData: { lessons, performance: perf } }),
  };
  const live = [
    { position: "P1", pair: "OCTO-SOL", pnl_pct: 3.95, in_range: true, lower_bin: -100, upper_bin: 20, active_bin: -40, age_minutes: 134, total_value_true_usd: 148.2 },
    { position: "P4", pair: "HOT-SOL", pnl_pct: -6.8, in_range: true, lower_bin: -50, upper_bin: 10, active_bin: -20, age_minutes: 47, total_value_true_usd: 121.4 },
  ];
  const mg = { ...config.management, allowLlmRiskParams: true };
  const data = R.buildReportData(inputs, { now: NOW, mode: "briefing", positions: live, regime: "caution", mgmt: mg });
  const P = Object.fromEntries(data.periods.map((p) => [p.id, p]));
  check("periods: 1, 7, 30, 60 days, since 30 Sep, all (in that order)", data.periods.map((p) => p.id).join() === "p1,p7,p30,p60,psince,pall");
  check("only 60 days is the default", data.periods.filter((p) => p.def).map((p) => p.id).join() === "p60");
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check("1 day: 4 closes, net +4, 3 wins, avg −0.125%", P.p1.agg.n === 4 && near(P.p1.agg.net, 4) && P.p1.agg.wins === 3 && near(P.p1.agg.avg, -0.125), JSON.stringify(P.p1.agg));
  check("1 day: 1 stop loss (−12), 1 trailing", P.p1.agg.slN === 1 && near(P.p1.agg.slUsd, -12) && P.p1.agg.trailing === 1);
  check("1 day: hourly buckets, at most 25, cumulative ends at the net", P.p1.pts.length <= 25 && near(P.p1.pts.at(-1).y, 4), `${P.p1.pts.length} ${P.p1.pts.at(-1)?.y}`);
  check("7 days: 6 closes, net +7 (includes the 30h and 3-day-old closes)", P.p7.agg.n === 6 && near(P.p7.agg.net, 7), JSON.stringify(P.p7.agg));
  check("7 days: 7 daily buckets", P.p7.pts.length === 7 && P.p7.gran === "hari");
  check("30 days: 6 closes", P.p30.agg.n === 6);
  check("60 days: 7 closes, net +27, weekly bars", P.p60.agg.n === 7 && near(P.p60.agg.net, 27) && P.p60.gran === "minggu", `${P.p60.agg.n} ${P.p60.agg.net} ${P.p60.gran}`);
  check("since 30 Sep: 6 closes (the 40-day-old one is before it)", P.psince.agg.n === 6, String(P.psince.agg.n));
  check("all: 8 closes, net −23", P.pall.agg.n === 8 && near(P.pall.agg.net, -23), `${P.pall.agg.n} ${P.pall.agg.net}`);
  check("reasons sorted by $ and sum to the period net", near(P.pall.agg.rows.reduce((s, r) => s + r.usd, 0), P.pall.agg.net) && P.pall.agg.rows[0].usd >= P.pall.agg.rows.at(-1).usd);
  check("30 Sep marker exists on the 60-day line, not on 'since 30 Sep' (it starts there)", P.p60.annotI > 0 && P.psince.annotI === -1);
  check("'since' strip numbers", data.since?.n === 6 && data.since.trailing === 1);
  check("decisions: skips grouped into one ×3 entry; too-old entry dropped", data.decisions.items.filter((e) => e.kind === "skip").length === 1 && data.decisions.items[0].count === 3 && !data.decisions.items.some((e) => /TOO-OLD/.test(e.pool ?? "")));
  check("decisions: rank joined from state signal_snapshot", data.decisions.items.find((e) => e.kind === "deploy")?.rank === 2 && data.decisions.items.find((e) => e.kind === "deploy")?.of === 7);
  check("no cover note below the 100-entry cap", data.decisions.coverFrom == null);
  const capped = R.buildReportData({ ...inputs, decisions: Array.from({ length: 100 }, (_, i) => ({ ts: ago((i + 1) * 5 * 60_000), type: "skip", reason: "r" })) }, { now: NOW, positions: live, regime: "caution", mgmt: mg });
  check("100 entries that stop short of 24h → cover note date set", capped.decisions.coverFrom != null && capped.decisions.coverFrom > NOW - D);
  const octo = data.positions.find((p) => p.pair === "OCTO-SOL");
  check("position SL uses effectiveStopLossPct with regime (−15 × 0.85 = −12.75)", near(octo.sl, -12.75), String(octo.sl));
  check("position trailing: peak 5.1, caution → trigger 3.74, floor 2.55", near(octo.trail.trigger, 5.1 - 1.7 * 0.8) && near(octo.trail.floor, 2.55), JSON.stringify(octo.trail));
  check("range used from bins: (20 − (−40)) / 120 = 50%", octo.depth === 50);
  check("OCTO is 'Dekat trailing' (0.21 above the trigger)", octo.status.label === "Dekat trailing", octo.status.label);
  check("HOT (−6.8% vs its SL) is 'Dekat stop loss'", data.positions.find((p) => p.pair === "HOT-SOL").status.label === "Dekat stop loss");
  check("attention list: stop loss first", /dekat stop loss/.test(data.attention[0]?.head));
  check("lessons: 4 non-aggregate in 24h, aggregates listed separately", data.lessons.items.length === 4 && data.lessons.aggregates.length === 2);
  check("aggregate rule parsed into columns", data.lessons.aggregates[1].strat === "bid_ask" && data.lessons.aggregates[1].range === "100-125" && data.lessons.aggregates[1].win === 69 && data.lessons.aggregates[1].n === 402);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[4] static and safe");
  const html = R.renderReportHtml(data);
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, html);
  check("no <script> anywhere", !/<script/i.test(html));
  check("no outside URL (http/https/protocol-relative)", !/https?:|\/\/[a-z]/i.test(html.replace(/<!doctype/i, "")));
  check("no inline event handlers / javascript: in any tag", !/<[a-z][^>]*\son[a-z]+\s*=/i.test(html) && !/javascript:/i.test(html));
  check("injected <img onerror> is escaped", html.includes("EVIL&lt;img src=x onerror=alert(1)&gt;-SOL") && !html.includes("<img src=x"));
  check("injected \"><script> in a reason is escaped", html.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  check("'<b>bold</b>' in a rejected candidate is escaped", html.includes("X &amp; Y: &lt;b&gt;bold&lt;/b&gt;"));
  check("lesson text '<=' is escaped", html.includes("&lt;= -10%"));
  const radios = [...html.matchAll(/<input type="radio" name="per" id="per-(\w+)"( checked)?>/g)];
  check("6 radios, only 60 days checked", radios.length === 6 && radios.filter((m) => m[2]).map((m) => m[1]).join() === "p60");
  check("6 panels, each selectable by CSS", [...html.matchAll(/<div class="panel" id="pan-(\w+)">/g)].length === 6 && /#per-p1:checked~\.panels #pan-p1\{display:grid\}/.test(html));
  check("dark mode via prefers-color-scheme", html.includes("prefers-color-scheme: dark"));
  check("viewport meta for phones", html.includes('name="viewport"'));
  check("charts are inline SVG with titles for tooltips", (html.match(/<svg class="chart"/g) || []).length >= 12 && (html.match(/<title>/g) || []).length > 50);
  check("a few hundred KB at most for this fixture", Buffer.byteLength(html) < 400_000, String(Buffer.byteLength(html)));

  // ─────────────────────────────────────────────────────────────
  console.log("\n[5] briefing text and report agree; Lessons condensed");
  const s = inputs.stats;
  check("24h stats: opened 3, closed 1, open now 2", s.opened === 3 && s.closed === 1 && s.openCount === 2, JSON.stringify({ o: s.opened, c: s.closed, n: s.openCount }));
  check("24h stats: net +4, fees 8.5, 3 of 4 wins", near(s.net, 4) && near(s.fees, 8.5) && s.wins === 3 && s.perfCount === 4 && s.winRatePct === 75);
  check("report KPI = text stats = 1-day panel", near(P.p1.agg.net, s.net) && P.p1.agg.n === s.perfCount && P.p1.agg.wins === s.wins);
  check("learned excludes AGGREGATE; manual + 3 per-close = 4", s.learned.length === 4 && s.aggregateRefreshed === 2);
  const text = await generateBriefing(NOW, { state: stateData, lessonsData: { lessons, performance: perf } });
  check("text keeps the header and sections", text.includes("<b>Morning Briefing</b>") && text.includes("<b>Activity:</b>") && text.includes("<b>Current Portfolio:</b>"));
  check("text: 'Lessons: 4 new' with a type breakdown", /<b>Lessons:<\/b> 4 new \(.*1 WARN.*\)/.test(text), text.split("\n").find((l) => l.includes("Lessons")));
  const bullets = text.split("\n").filter((l) => l.startsWith("• "));
  check("text: exactly 2 example lines", bullets.length === 2, String(bullets.length));
  check("text: operator note ranks first, then the biggest-PnL lesson (WARN −12)", !!bullets[0]?.includes("Operator note") && !!bullets[1]?.startsWith("• WARN"), bullets.join(" | "));
  check("text: WORKED (+6) and AVOID (−7) are counted but not listed", !text.includes("• WORKED") && !text.includes("• AVOID") && /1 WORKED/.test(text) && /1 AVOID/.test(text));
  check("text: examples are cut at a word boundary within ~90 chars", bullets.length === 2 && bullets.every((b) => b.length <= 2 + 91 + 10) && bullets[1].endsWith("…"), bullets[1]);
  check("text: AGGREGATE lessons never appear", !text.includes("AGGREGATE"));
  check("text: points to the report", text.includes("Full list: HTML report (/viz)"));
  check("text: '<=' in a lesson is escaped for Telegram HTML", text.includes("&lt;="));
  check("truncateText never splits a word and keeps short text whole", truncateText("a".repeat(5), 90) === "aaaaa" && !/\s…$/.test(truncateText("word ".repeat(40), 90)) && truncateText("word ".repeat(40), 90).length <= 90);
  check("lessonType: prefix, MANUAL, AGGREGATE, EVOLVED, NOTE", lessonType({ rule: "WARN: x" }) === "WARN" && lessonType({ rule: "y", sourceType: "manual" }) === "MANUAL" && lessonType({ tags: ["aggregate"], rule: "AGGREGATE: z" }) === "AGGREGATE" && lessonType({ tags: ["evolution"], rule: "[AUTO-EVOLVED @ 5]" }) === "EVOLVED" && lessonType({ rule: "plain" }) === "NOTE");
  const noLessons = await (async () => { const t = collectBriefingStats(NOW, { state: stateData, lessonsData: { lessons: [], performance: perf } }); return t.learned.length; })();
  check("no fresh lessons → learned empty", noLessons === 0);

  // ─────────────────────────────────────────────────────────────
  console.log("\n[6] modes, file names, caption, degraded inputs");
  const viz = R.buildReportData(inputs, { now: NOW, mode: "viz", positions: live, regime: "caution", mgmt: mg });
  const vizHtml = R.renderReportHtml(viz);
  check("viz wording: 'snapshot', not 'semalam'", vizHtml.includes("Meridian · snapshot") && vizHtml.includes("Keputusan agent 24 jam terakhir") && !/semalam/.test(vizHtml));
  check("briefing wording: 'briefing pagi', 'semalam'", html.includes("Meridian · briefing pagi") && html.includes("Keputusan agent semalam"));
  check("file names", R.reportFileName("briefing", NOW) === "meridian-briefing-2026-10-13.html" && R.reportFileName("viz", NOW) === "meridian-viz-2026-10-13_0800.html", `${R.reportFileName("viz", NOW)}`);
  const cap = R.reportCaption(viz);
  check("viz caption: 3 short lines with PnL, close count and win rate", cap.split("\n").length === 3 && cap.includes("+$4.00") && cap.includes("4 close") && cap.includes("win 75%") && cap.length < 300, cap);
  check("briefing caption is the fixed short line", R.reportCaption(data).startsWith("Laporan lengkap"));
  const noLive = R.renderReportHtml(R.buildReportData(inputs, { now: NOW, positions: null, regime: "healthy", mgmt: mg }));
  check("live positions unavailable → notice + cards from state without PnL", noLive.includes("Data posisi live tidak tersedia") && noLive.includes("PnL saat ini tidak tersedia"));
  const empty = R.renderReportHtml(R.buildReportData({ perf: [], lessons: [], decisions: [], tracked: [], stats: collectBriefingStats(NOW, { state: { positions: {} }, lessonsData: { lessons: [], performance: [] } }) }, { now: NOW, positions: [], regime: null, mgmt: mg }));
  check("empty data renders: no open positions, no closes, no lessons", empty.includes("Tidak ada posisi terbuka") && empty.includes("Belum ada posisi ditutup pada periode ini") && empty.includes("Tidak ada lesson baru semalam") && empty.includes("N/A"));
  check("empty data: no NaN / undefined / Infinity in the output", !/NaN|undefined|Infinity/.test(empty), (empty.match(/.{20}(NaN|undefined|Infinity).{20}/) || [""])[0]);
  check("full fixture: no NaN / undefined / Infinity either", !/NaN|undefined|Infinity/.test(html) && !/NaN|undefined|Infinity/.test(noLive));
  const bigPerf = Array.from({ length: 4000 }, (_, i) => ({ recorded_at: ago((i % 120) * D + (i % 24) * H + 1000), pnl_usd: Math.sin(i) * 6, pnl_pct: Math.cos(i) * 5, close_reason: i % 9 === 0 ? "Stop loss: x" : "Rule 5: low yield" }));
  const t0 = performance.now();
  const bigHtml = R.renderReportHtml(R.buildReportData({ ...inputs, perf: bigPerf }, { now: NOW, positions: live, regime: "caution", mgmt: mg }));
  const ms = performance.now() - t0;
  check("4000 closes build + render in well under a second", ms < 1000, `${ms.toFixed(0)} ms`);
  console.log(`    (4000 closes: ${ms.toFixed(0)} ms, ${Math.round(Buffer.byteLength(bigHtml) / 1024)} KB)`);
} finally {
  if (stateBackup) fs.writeFileSync(STATE_FILE, stateBackup);
  else fs.rmSync(STATE_FILE, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
