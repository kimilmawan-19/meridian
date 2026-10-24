/**
 * HTML report for the morning briefing and Telegram /briefing, /viz.
 *
 * One self-contained .html file: inline CSS, inline SVG charts, no JavaScript and no outside requests,
 * so it opens the same way in any viewer. The period selector (1 day … all) is radio buttons + CSS:
 * every period is rendered into the file and the checked one is shown.
 *
 * Read-only: it reads state.json, lessons.json, decision-log.json and (optionally) the live position
 * list the caller passes in. Nothing here touches trading logic.
 */

import fs from "fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import { effectiveStopLossPct } from "./state.js";
import { collectBriefingStats, isAggregateLesson, lessonType } from "./briefing.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
const DECISION_LOG_FILE = "./decision-log.json";

// ─── time (WIB = UTC+7, the briefing's timezone; no DST so fixed-step day math is safe) ───────────
const WIB_MS = 7 * 3600e3;
const HOUR = 36e5;
const DAY = 864e5;
const MON = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const DOW = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const wib = (t) => new Date(t + WIB_MS);
const hm = (t) => wib(t).toISOString().slice(11, 16);
const dm = (t) => `${wib(t).getUTCDate()} ${MON[wib(t).getUTCMonth()]}`;
const dowName = (t) => DOW[wib(t).getUTCDay()];
const ymd = (t) => wib(t).toISOString().slice(0, 10);
const dayStart = (t) => Math.floor((t + WIB_MS) / DAY) * DAY - WIB_MS;
const hourStart = (t) => Math.floor(t / HOUR) * HOUR;

/** The "Sejak 30 Sep" period: closes since the exit fixes of 2026-09-29/30 (evaluation on 2026-10-16). */
export const SINCE_FIX = Date.parse("2026-09-30T00:00:00+07:00");
const DECISION_LOG_CAP = 100; // decision-log.js keeps the newest 100 entries
const SL_NEAR_POINTS = 4;     // "close to stop loss" when PnL is within this many points of it
const TRAIL_NEAR_POINTS = 0.5;
const AGE_NEAR_MIN = 180;     // "close to max age" when this many minutes (or fewer) remain
const TIMELINE_VISIBLE = 8;
const LESSONS_VISIBLE = 5;

// ─── formatting ────────────────────────────────────────────────────────────────────────────────
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MINUS = "−";
const sign = (v) => (v > 0 ? "+" : v < 0 ? MINUS : "");
const fx = (v, d = 2) => sign(Math.round(v * 10 ** d) / 10 ** d) + Math.abs(v).toFixed(d);
const pct = (v, d = 2) => `${fx(v, d)}%`;
const usd = (v, d = 0) => `${sign(Math.round(v * 10 ** d) / 10 ** d)}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}j ${String(Math.round(m % 60)).padStart(2, "0")}m` : `${Math.round(m)}m`);
const num = (v) => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; };

// ─── close-reason categories (case-insensitive: reasons are the rule's own text) ─────────────────
export const CLOSE_CATEGORIES = ["max age", "OOR", "low yield", "trailing", "break-even", "Rule 10", "darurat", "stop loss", "lain"];
export function closeCategory(reason) {
  const r = String(reason ?? "");
  if (/stop.?loss/i.test(r)) return "stop loss";
  if (/break.?even/i.test(r)) return "break-even";
  if (/trail|give-back|grace expired/i.test(r)) return "trailing";
  if (/low.?yield|rule 5/i.test(r)) return "low yield";
  if (/max.?age|rule 6|no longer earning/i.test(r)) return "max age";
  if (/out of range|oor|rule [34]\b|pumped/i.test(r)) return "OOR";
  if (/trim|rule 10/i.test(r)) return "Rule 10";
  if (/collapse|rapid|sell.?pressure|rule (7|8|9|11)\b/i.test(r)) return "darurat";
  return "lain";
}

// ─── exit levels of an open position (mirrors updatePnlAndCheckExits in state.js) ─────────────────
/**
 * Where the trailing take-profit triggers and where the give-back floor force-closes it.
 * In range, a trigger below the floor is deferred up to trailingInRangeDeferMin; the floor closes at once.
 * Returns null when trailing is not armed. Guarded against drift by test/test-report-html.mjs.
 */
export function trailingLevels(tracked, mgmt, regime = "healthy", now = Date.now()) {
  if (!tracked || !mgmt.trailingTakeProfit || !tracked.trailing_active) return null;
  const peak = Number(tracked.peak_pnl_pct);
  if (!Number.isFinite(peak)) return null;
  const dropFloor = mgmt.allowLlmRiskParams && tracked.trailing_drop_override != null
    ? Math.max(0.5, tracked.trailing_drop_override)
    : mgmt.trailingDropPct;
  let drop = Math.max(dropFloor, peak / (mgmt.trailingGivebackDivisor ?? 3));
  if (regime === "bearish") drop *= mgmt.marketRegimeBearishTrailMult ?? 0.6;
  else if (regime === "caution") drop *= mgmt.marketRegimeCautionTrailMult ?? 0.8;
  const staleMin = mgmt.trailingStalePeakMinutes;
  if (staleMin != null && tracked.peak_pnl_at && (now - Date.parse(tracked.peak_pnl_at)) / 60_000 >= staleMin) {
    drop *= mgmt.trailingStalePeakDropMult ?? 1.75;
  }
  return { trigger: peak - drop, floor: peak - peak / (mgmt.tpVetoFloorDivisor ?? 2) };
}

// ─── data: open positions ──────────────────────────────────────────────────────────────────────
function buildPositions({ tracked, live, mgmt, regime, now }) {
  const trackedBy = new Map(tracked.map((p) => [p.position, p]));
  const rows = live
    ? live.map((lp) => ({ lp, tr: trackedBy.get(lp.position) ?? null }))
    : tracked.filter((p) => !p.closed).map((tr) => ({ lp: null, tr }));
  return rows.map(({ lp, tr }) => {
    const pnl = num(lp?.pnl_pct);
    const peak = num(tr?.peak_pnl_pct);
    const lower = num(lp?.lower_bin), upper = num(lp?.upper_bin), active = num(lp?.active_bin);
    const depth = lower != null && upper != null && active != null && upper > lower
      ? Math.round(Math.max(0, Math.min(100, ((upper - active) / (upper - lower)) * 100)))
      : null;
    const ageMin = num(lp?.age_minutes) ?? (tr?.deployed_at ? Math.floor((now - Date.parse(tr.deployed_at)) / 60_000) : null);
    const sl = effectiveStopLossPct(tr, mgmt, regime);
    const trail = trailingLevels(tr, mgmt, regime, now);
    const beOn = !!tr?.break_even_active;
    const p = {
      pair: lp?.pair || tr?.pool_name || "?",
      strat: tr?.strategy ?? null,
      ageMin,
      usdVal: num(lp?.total_value_true_usd),
      pnl, peak, depth, sl, trail, beOn,
      inRange: lp?.in_range ?? null,
      oorMin: num(lp?.minutes_out_of_range),
      leftAge: ageMin != null && mgmt.maxPositionAgeMinutes != null ? mgmt.maxPositionAgeMinutes - ageMin : null,
      maxAge: mgmt.maxPositionAgeMinutes ?? null,
      toSl: pnl != null && sl != null ? pnl - sl : null,
      toTrail: pnl != null && trail ? pnl - trail.trigger : null,
      toFloor: pnl != null && trail ? pnl - trail.floor : null,
    };
    if (pnl == null) p.status = { cls: "neutral", icon: "info", label: "Tanpa data live" };
    else if (p.toSl != null && p.toSl < SL_NEAR_POINTS) p.status = { cls: "serious", icon: "excl", label: "Dekat stop loss" };
    else if (p.toTrail != null && p.toTrail < TRAIL_NEAR_POINTS) p.status = { cls: "warn", icon: "tri", label: "Dekat trailing" };
    else if (p.inRange === false) p.status = { cls: "warn", icon: "tri", label: "Out of range" };
    else p.status = { cls: "good", icon: "check", label: "Aman" };
    return p;
  });
}

function buildAttention(positions) {
  const items = [];
  for (const p of positions) {
    if (p.pnl == null) continue;
    if (p.toSl != null && p.toSl < SL_NEAR_POINTS) items.push({ sev: 0, cls: "serious", ic: "excl", head: `${p.pair} dekat stop loss`, body: `PnL ${pct(p.pnl)}, stop loss ${pct(p.sl)}. Jarak ${p.toSl.toFixed(2)} poin.` });
    if (p.toTrail != null && p.toTrail < TRAIL_NEAR_POINTS) items.push({ sev: 1, cls: "warn", ic: "tri", head: `${p.pair} dekat trailing`, body: `Trailing mulai di ${pct(p.trail.trigger)}, PnL ${pct(p.pnl)}. Jarak ${Math.max(0, p.toTrail).toFixed(2)} poin dari peak ${pct(p.peak)}.` });
    if (p.inRange === false) items.push({ sev: 1, cls: "warn", ic: "tri", head: `${p.pair} di luar range`, body: p.oorMin != null ? `Sudah ${dur(p.oorMin)} di luar range.` : "Harga di luar range." });
    if (p.leftAge != null && p.leftAge >= 0 && p.leftAge < AGE_NEAR_MIN) items.push({ sev: 2, cls: "neutral", ic: "info", head: `${p.pair} mendekati batas umur`, body: `Umur ${dur(p.ageMin)} dari batas ${p.maxAge}m. Setelah itu ditutup kalau sudah berhenti earning, atau diperpanjang kalau masih earning.` });
  }
  return items.sort((a, b) => a.sev - b.sev);
}

// ─── data: performance periods ─────────────────────────────────────────────────────────────────
function normalizePerf(list) {
  return (list || [])
    .map((p) => ({ t: Date.parse(p.recorded_at), usd: Number(p.pnl_usd) || 0, pct: Number(p.pnl_pct) || 0, k: closeCategory(p.close_reason) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}

function aggregateCloses(closes) {
  const by = new Map(CLOSE_CATEGORIES.map((k) => [k, { k, n: 0, usd: 0, pct: 0 }]));
  let net = 0, wins = 0, pctSum = 0;
  for (const c of closes) {
    net += c.usd; pctSum += c.pct;
    if (c.usd > 0) wins++;
    const e = by.get(c.k); e.n++; e.usd += c.usd; e.pct += c.pct;
  }
  const sl = by.get("stop loss");
  return {
    n: closes.length, net, wins,
    avg: closes.length ? pctSum / closes.length : 0,
    slN: sl.n, slUsd: sl.usd, trailing: by.get("trailing").n,
    rows: [...by.values()].filter((e) => e.n).map((e) => ({ k: e.k, n: e.n, usd: e.usd, avg: e.pct / e.n })).sort((a, b) => b.usd - a.usd),
  };
}

function bucketize(closes, from, to, hourly) {
  const step = hourly ? HOUR : DAY, key = hourly ? hourStart : dayStart;
  const sums = new Map();
  for (const c of closes) { const k = key(c.t), e = sums.get(k) || { d: 0, n: 0 }; e.d += c.usd; e.n++; sums.set(k, e); }
  const out = [];
  for (let t = key(from); t <= to; t += step) {
    const e = sums.get(t);
    out.push({ t, d: Math.round((e?.d || 0) * 100) / 100, n: e?.n || 0 });
  }
  return out;
}

function weeklyBars(days) {
  const out = [];
  for (let e = days.length; e > 0; e -= 7) {
    const c = days.slice(Math.max(0, e - 7), e);
    const d = Math.round(c.reduce((x, q) => x + q.d, 0) * 100) / 100, n = c.reduce((x, q) => x + q.n, 0);
    const label = `${dm(c[0].t)}–${dm(c.at(-1).t)}`;
    out.unshift({ t: c[0].t, d, n, label, title: `${label}: ${usd(d, 2)}, ${n} posisi ditutup` });
  }
  return out;
}

function buildPeriods(perf, now, mode) {
  const today = dayStart(now);
  const first = perf.length ? dayStart(perf[0].t) : today;
  const defs = [
    { id: "p1", label: "1 hari", hourly: true, from: now - DAY },
    { id: "p7", label: "7 hari", from: today - 6 * DAY },
    { id: "p30", label: "30 hari", from: today - 29 * DAY },
    { id: "p60", label: "60 hari", from: today - 59 * DAY, def: true },
    ...(SINCE_FIX <= now ? [{ id: "psince", label: "Sejak 30 Sep", from: dayStart(SINCE_FIX) }] : []),
    { id: "pall", label: "Semua", from: first },
  ];
  return defs.map((def) => {
    const closes = perf.filter((c) => c.t >= def.from && c.t <= now);
    const a = aggregateCloses(closes);
    const buckets = bucketize(closes, def.from, now, !!def.hourly);
    let y = 0;
    const pts = buckets.map((b) => ({ ...b, y: (y += b.d) }));
    const gran = def.hourly ? "jam" : buckets.length <= 31 ? "hari" : "minggu";
    const bars = def.hourly
      ? buckets.map((b) => ({ ...b, label: `${hm(b.t)}–${hm(b.t + HOUR)}`, tl: hm(b.t), title: `${hm(b.t)}–${hm(b.t + HOUR)}: ${usd(b.d, 2)}, ${b.n} posisi ditutup` }))
      : gran === "hari"
        ? buckets.map((b) => ({ ...b, label: dm(b.t), title: `${dm(b.t)}: ${usd(b.d, 2)}, ${b.n} posisi ditutup` }))
        : weeklyBars(buckets);
    const sub = def.hourly
      ? `${dm(def.from)} ${hm(def.from)} – ${dm(now)} ${hm(now)} WIB · ${mode === "viz" ? "24 jam terakhir" : "24 jam, sama dengan teks briefing"}`
      : `${dm(def.from)} – ${dm(now)} · ${buckets.length} hari`;
    const annotAt = def.hourly ? -1 : pts.findIndex((p) => p.t === dayStart(SINCE_FIX));
    return { id: def.id, label: def.label, def: !!def.def, hourly: !!def.hourly, sub, empty: closes.length === 0, agg: a, pts, bars, gran, annotI: annotAt > 0 ? annotAt : -1 };
  });
}

// ─── data: decisions and lessons ─────────────────────────────────────────────────────────────────
function buildDecisions(decisions, trackedBy, from) {
  const list = Array.isArray(decisions) ? decisions : []; // newest first
  const oldest = list.length ? Date.parse(list.at(-1).ts) : null;
  const coverFrom = list.length >= DECISION_LOG_CAP && oldest != null && oldest > from ? oldest : null;
  const out = [];
  for (const d of list) {
    const t = Date.parse(d.ts);
    if (!Number.isFinite(t) || t < from) continue;
    const m = d.metrics || {};
    if (d.type === "skip") {
      const last = out.at(-1);
      if (last?.kind === "skip" && last.reason === d.reason) { last.count++; last.from = t; continue; }
      out.push({ kind: "skip", t, from: t, count: 1, reason: d.reason ?? d.summary });
    } else if (d.type === "deploy") {
      const sn = trackedBy.get(d.position)?.signal_snapshot || {};
      out.push({ kind: "deploy", t, pool: d.pool_name, strat: m.strategy ?? null, sol: m.amount_sol ?? null, rank: num(sn.candidate_rank), of: num(sn.candidate_count), risks: Array.isArray(d.risks) ? d.risks : [] });
    } else if (d.type === "close") {
      out.push({ kind: "close", t, pool: d.pool_name, usd: num(m.pnl_usd), pct: num(m.pnl_pct), held: num(m.minutes_held), reason: d.reason ?? d.summary });
    } else if (d.type === "no_deploy") {
      out.push({ kind: "nodeploy", t, title: d.summary, reason: d.reason, rejected: Array.isArray(d.rejected) ? d.rejected : [] });
    } else if (d.type === "emergency_exit" || d.type === "tactical_exit") {
      out.push({ kind: "exit", t, label: d.type === "tactical_exit" ? "Exit taktis" : "Exit darurat", pool: d.pool_name, reason: d.reason ?? d.summary });
    } else if (d.type === "partial_exit") {
      out.push({ kind: "partial", t, pool: d.pool_name, reason: d.summary });
    } else {
      out.push({ kind: "note", t, label: d.type, pool: d.pool_name, reason: d.summary ?? d.reason });
    }
  }
  return { items: out, coverFrom };
}

function parseAggregate(l) {
  const rule = String(l.rule ?? "");
  const m = /^AGGREGATE:\s*(\S+)\s*\+\s*bin_step\s*(\S+)\s*→\s*(\d+)%\s*win,\s*([+-]?[\d.]+)%\s*avg PnL.*?\(n=(\d+)/.exec(rule);
  return m ? { strat: m[1], range: m[2], win: Number(m[3]), avg: Number(m[4]), n: Number(m[5]) } : { raw: rule };
}

function buildLessons(lessons, from) {
  const all = Array.isArray(lessons) ? lessons : [];
  const items = all
    .filter((l) => !isAggregateLesson(l) && Date.parse(l.created_at) > from)
    .map((l) => {
      const rule = String(l.rule ?? "");
      const tone = l.outcome === "good" || /^(WORKED|PREFER)\b/.test(rule) ? "good" : l.outcome === "bad" || /^(WARN|AVOID|FAILED)\b/.test(rule) ? "bad" : "neutral";
      return { type: lessonType(l), tone, t: Date.parse(l.created_at), pct: num(l.pnl_pct), rule };
    })
    .sort((a, b) => b.t - a.t);
  return { items, aggregates: all.filter(isAggregateLesson).map(parseAggregate) };
}

// ─── build everything the renderer needs ──────────────────────────────────────────────────────────
/**
 * @param {{perf:Array, lessons:Array, decisions:Array, tracked:Array, stats:Object}} inputs
 * @param {{now?:number, mode?:"briefing"|"viz", positions?:Array|null, regime?:string|null, mgmt?:Object}} opts
 *   positions: live list from getMyPositions().positions, or null when unavailable.
 */
export function buildReportData(inputs, { now = Date.now(), mode = "briefing", positions = null, regime, mgmt = config.management } = {}) {
  const reg = regime === undefined ? (config.marketRegime?._activeRegime ?? null) : regime;
  const tracked = inputs.tracked || [];
  const trackedBy = new Map(tracked.map((p) => [p.position, p]));
  const perf = normalizePerf(inputs.perf);
  const pos = buildPositions({ tracked, live: positions, mgmt, regime: reg ?? "healthy", now });
  const periods = buildPeriods(perf, now, mode);
  const since = periods.find((p) => p.id === "psince");
  return {
    mode, now, regime: reg, liveOk: positions != null,
    stats: inputs.stats,
    since: since && since.agg.n > 0 ? { n: since.agg.n, avg: since.agg.avg, slShare: (since.agg.slN / since.agg.n) * 100, trailing: since.agg.trailing } : null,
    positions: pos,
    attention: buildAttention(pos),
    decisions: buildDecisions(inputs.decisions, trackedBy, now - DAY),
    lessons: buildLessons(inputs.lessons, now - DAY),
    periods,
  };
}

// ─── rendering ──────────────────────────────────────────────────────────────────────────────────
const WORDS = {
  briefing: { eyebrow: "Meridian · briefing pagi", check: "Perlu dicek pagi ini", dec: "Keputusan agent semalam", les: "Lessons baru semalam", noles: "Tidak ada lesson baru semalam." },
  viz: { eyebrow: "Meridian · snapshot", check: "Perlu dicek sekarang", dec: "Keputusan agent 24 jam terakhir", les: "Lessons 24 jam terakhir", noles: "Tidak ada lesson baru dalam 24 jam terakhir." },
};

const ICON = {
  check: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M4.5 8.3l2.3 2.2 4.7-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  tri: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7.2 13.2H.8z" fill="currentColor"/><path d="M8 6v4M8 12v.2" stroke="#101820" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  excl: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M8 4.2v4.6M8 11.4v.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  info: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M8 7.2v4.4M8 4.6v.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};
const pill = (cls, ic, label) => `<span class="pill ${cls}">${ICON[ic]}${esc(label)}</span>`;

function niceTicks(min, max, count = 4) {
  const span = max - min || 1, rs = span / count, p = 10 ** Math.floor(Math.log10(rs)), f = rs / p;
  const st = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
  for (let v = Math.floor(min / st) * st; v <= Math.ceil(max / st) * st + st / 2; v += st) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
const fmtK = (v) => `${v < 0 ? MINUS : ""}$${Math.abs(v)}`;

function lineSvg(pts, { annotI, label, tfmt = dm, unit = "hari", xt }) {
  const W = 360, H = 200, m = { l: 44, r: 62, t: 12, b: 26 }, li = pts.length - 1;
  const ys = pts.map((p) => p.y), tk = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys), 4), y0 = tk[0], y1 = tk.at(-1);
  const X = (i) => m.l + (li ? (i * (W - m.l - m.r)) / li : 0);
  const Y = (v) => m.t + ((y1 - v) * (H - m.t - m.b)) / (y1 - y0);
  const step = li ? (W - m.l - m.r) / li : 20;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
  for (const v of tk) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 0 ? "axis0" : "grid"}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="tick">${fmtK(v)}</text>`;
  for (const i of xt || new Set([0, Math.round(li / 3), Math.round((2 * li) / 3), li])) s += `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === li ? "end" : "middle"}" class="tick">${tfmt(pts[i].t)}</text>`;
  if (annotI > 0 && annotI < li) {
    const ax = X(annotI), left = ax < W * 0.45;
    s += `<line x1="${ax}" x2="${ax}" y1="${m.t}" y2="${H - m.b}" class="annot"/><text x="${left ? ax + 5 : ax - 5}" y="${H - m.b - 7}" text-anchor="${left ? "start" : "end"}" class="annot-t">perbaikan exit 30 Sep</text>`;
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  s += `<path d="${d}L${X(li).toFixed(1)},${Y(0)}L${X(0)},${Y(0)}Z" class="area"/><path d="${d}" class="line"/>`;
  s += `<circle cx="${X(li)}" cy="${Y(pts[li].y)}" r="4.5" class="dot"/><text x="${X(li) + 9}" y="${Y(pts[li].y) + 4}" class="endlabel">${usd(pts[li].y)}</text>`;
  const g = Math.ceil(pts.length / 75);
  for (let i = 0; i < pts.length; i += g) {
    const p = pts[i];
    s += `<rect x="${Math.max(m.l, X(i) - (step * g) / 2).toFixed(1)}" y="${m.t}" width="${(step * g).toFixed(1)}" height="${H - m.t - m.b}" class="hit"><title>${esc(`${tfmt(p.t)}: kumulatif ${usd(p.y)}, ${unit} itu ${usd(p.d, 2)}, ${p.n} posisi ditutup`)}</title></rect>`;
  }
  return `${s}</svg>`;
}

function barPath(x, w, yb, ye, r) {
  r = Math.min(r, w / 2, Math.abs(yb - ye));
  return ye <= yb
    ? `M${x},${yb}V${ye + r}Q${x},${ye} ${x + r},${ye}H${x + w - r}Q${x + w},${ye} ${x + w},${ye + r}V${yb}Z`
    : `M${x},${yb}V${ye - r}Q${x},${ye} ${x + r},${ye}H${x + w - r}Q${x + w},${ye} ${x + w},${ye - r}V${yb}Z`;
}

function colSvg(bars, { label, tick }) {
  const W = 360, H = 176, m = { l: 44, r: 10, t: 18, b: 26 }, n = bars.length;
  const vs = bars.map((p) => p.d), tk = niceTicks(Math.min(0, ...vs), Math.max(0, ...vs), 4), y0 = tk[0], y1 = tk.at(-1);
  const Y = (v) => m.t + ((y1 - v) * (H - m.t - m.b)) / (y1 - y0);
  const band = (W - m.l - m.r) / n, bw = Math.min(24, band * 0.62), every = Math.max(1, Math.ceil(n / 5));
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
  for (const v of tk) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 0 ? "axis0" : "grid"}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="tick">${fmtK(v)}</text>`;
  const iMax = vs.indexOf(Math.max(...vs)), iMin = vs.indexOf(Math.min(...vs));
  bars.forEach((p, i) => {
    const x = m.l + i * band + (band - bw) / 2;
    s += `<g><path d="${barPath(x, bw, Y(0), Y(p.d), 4)}" class="bar ${p.d >= 0 ? "pos" : "neg"}"/><rect x="${m.l + i * band}" y="${m.t}" width="${band}" height="${H - m.t - m.b}" class="hit"><title>${esc(p.title)}</title></rect></g>`;
    if ((i === iMax || i === iMin) && p.d !== 0) s += `<text x="${i === 0 ? x : x + bw / 2}" y="${p.d >= 0 ? Y(p.d) - 5 : Y(p.d) + 13}" text-anchor="${i === 0 ? "start" : "middle"}" class="vlabel">${usd(p.d)}</text>`;
    if (tick ? tick(p) : (n - 1 - i) % every === 0) s += `<text x="${i === n - 1 ? x + bw : x + bw / 2}" y="${H - 6}" text-anchor="${i === n - 1 ? "end" : "middle"}" class="tick">${esc(p.tl ?? dm(p.t))}</text>`;
  });
  return `${s}</svg>`;
}

function divBars(rows) {
  const maxP = Math.max(0, ...rows.map((r) => Math.max(0, r.usd))), maxN = Math.max(0, ...rows.map((r) => Math.max(0, -r.usd)));
  const span = maxP + maxN || 1, z = (maxN / span) * 100;
  return `<div class="divbars">${rows.map((r) => {
    const w = (Math.abs(r.usd) / span) * 100, positive = r.usd >= 0;
    return `<div class="db" title="${esc(`${r.k}: ${usd(r.usd)}, ${r.n} posisi, rata-rata ${pct(r.avg)}`)}"><span class="l">${esc(r.k)}<span>· ${r.n}</span></span><span class="t"><span class="z" style="left:${z}%"></span><span class="b ${positive ? "pos" : "neg"}" style="${positive ? `left:${z}%;width:${w}%` : `left:${z - w}%;width:${w}%`}"></span></span><span class="v">${usd(r.usd)}</span></div>`;
  }).join("")}</div>`;
}

function meter(p) {
  const marks = [p.sl, p.pnl, p.peak ?? 0, 0, p.trail?.trigger ?? 0, p.trail?.floor ?? 0];
  const lo = Math.min(...marks) - 1, hi = Math.max(...marks) + 1.5, X = (v) => ((v - lo) / (hi - lo)) * 100;
  const tk = (cls, v) => `<span class="tk ${cls}" style="left:${X(v)}%"></span>`;
  return `<div class="meter" role="img" aria-label="${esc(`PnL ${pct(p.pnl)}, stop loss ${pct(p.sl)}${p.trail ? `, trailing mulai di ${pct(p.trail.trigger)}, lantai ${pct(p.trail.floor)}` : ""}${p.peak != null ? `, peak ${pct(p.peak)}` : ""}`)}">` +
    `<span class="zone l" style="left:${X(p.sl)}%;width:${X(0) - X(p.sl)}%"></span><span class="zone p" style="left:${X(0)}%;width:${100 - X(0)}%"></span>` +
    tk("sl", p.sl) + tk(p.beOn ? "be" : "zero", 0) + (p.trail ? tk("trail", p.trail.trigger) + tk("floor", p.trail.floor) : "") +
    (p.peak != null ? tk("peak", p.peak) : "") + `<span class="now" style="left:${X(p.pnl)}%"></span></div>`;
}

function posCard(p) {
  const row = (k, lab, val, d) => `<li><i class="k ${k}"></i><span>${lab} <b>${val}</b></span><span class="d">${d || ""}</span></li>`;
  const meta = [p.strat, p.ageMin != null ? `umur ${dur(p.ageMin)}` : null, p.usdVal != null ? `$${p.usdVal.toFixed(2)}` : null].filter(Boolean).join(" · ");
  let body = `<div class="pos-top"><div><div class="pos-name">${esc(p.pair)}</div><div class="pos-meta">${esc(meta)}</div></div>${pill(p.status.cls, p.status.icon, p.status.label)}</div>`;
  if (p.pnl == null) return `<article class="poscard">${body}<p class="note">PnL saat ini tidak tersedia. Stop loss ${pct(p.sl)}${p.peak != null ? `, peak ${pct(p.peak)}` : ""}.</p></article>`;
  body += `<div class="pos-pnl"><span class="big">${pct(p.pnl)}</span>${p.peak != null ? `<span class="peak">peak ${pct(p.peak)}</span>` : ""}</div>${meter(p)}`;
  body += `<ul class="mkey">${row("now", "Sekarang", pct(p.pnl))}` +
    (p.trail ? row("trail", "Trailing", `≤ ${pct(p.trail.trigger)}`, `jarak ${Math.max(0, p.toTrail).toFixed(2)}`) + row("floor", "Lantai give-back", `≤ ${pct(p.trail.floor)}`, `jarak ${Math.max(0, p.toFloor).toFixed(2)}`) : "") +
    row(p.beOn ? "be" : "zero", "Break-even", p.beOn ? "≤ 0%" : "belum aktif", p.beOn ? `jarak ${p.pnl.toFixed(2)}` : "") +
    row("sl", "Stop loss", pct(p.sl), `jarak ${p.toSl.toFixed(2)}`) + `</ul>`;
  if (p.depth != null) body += `<div><div class="rng" role="img" aria-label="${p.depth}% range terpakai"><span class="fill" style="width:${p.depth}%"></span></div><div class="rng-lab"><span>range terpakai <b>${p.depth}%</b></span><span>${p.maxAge != null && p.ageMin != null ? `umur ${Math.round(p.ageMin)}/${p.maxAge}m` : ""}</span></div></div>`;
  return `<article class="poscard">${body}</article>`;
}

function evItem(e) {
  const when = `<time>${hm(e.t)}</time>`;
  const li = (chip, inner) => `<li class="ev">${when}${chip}<div class="ev-body">${inner}</div></li>`;
  if (e.kind === "skip") return li(`<span class="chip skip">Skip ×${e.count}</span>`, `<p class="ev-reason">${esc(e.reason)} · ${hm(e.from)}–${hm(e.t)}</p>`);
  if (e.kind === "deploy") {
    const bits = [e.strat, e.sol != null ? `${e.sol} SOL` : null, e.rank != null && e.of != null ? `rank #${e.rank} dari ${e.of}` : null, ...e.risks].filter(Boolean).join(" · ");
    return li(`<span class="chip deploy">Deploy</span>`, `<div class="ev-title">${esc(e.pool)}</div><p class="ev-reason">${esc(bits)}</p>`);
  }
  if (e.kind === "nodeploy") {
    return li(`<span class="chip nodeploy">No deploy</span>`, `<div class="ev-title">${esc(e.title)}</div><p class="ev-reason">${esc(e.reason)}</p>${e.rejected.length ? `<ul class="ev-rej">${e.rejected.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}`);
  }
  if (e.kind === "close") {
    const sl = /stop.?loss/i.test(String(e.reason ?? ""));
    const res = e.usd != null ? ` <span class="ev-res">${usd(e.usd, 2)}${e.pct != null ? ` (${pct(e.pct)})` : ""}</span>` : "";
    return li(`<span class="chip ${sl ? "sl" : "close"}">${sl ? "Stop loss" : "Close"}</span>`, `<div class="ev-title">${esc(e.pool)}${res}${e.held != null ? ` <span class="muted">dipegang ${dur(e.held)}</span>` : ""}</div><p class="ev-reason">${esc(e.reason)}</p>`);
  }
  if (e.kind === "exit") return li(`<span class="chip sl">${esc(e.label)}</span>`, `<div class="ev-title">${esc(e.pool)}</div><p class="ev-reason">${esc(e.reason)}</p>`);
  if (e.kind === "partial") return li(`<span class="chip close">Partial</span>`, `<div class="ev-title">${esc(e.pool)}</div><p class="ev-reason">${esc(e.reason)}</p>`);
  return li(`<span class="chip skip">${esc(e.label)}</span>`, `<div class="ev-title">${esc(e.pool ?? "")}</div><p class="ev-reason">${esc(e.reason)}</p>`);
}

function timeline(events) {
  let day = null;
  const emit = (list) => list.map((e) => { const d = dm(e.t); let h = ""; if (d !== day) { day = d; h = `<li class="day">${dowName(e.t)}, ${d}</li>`; } return h + evItem(e); }).join("");
  const head = events.slice(0, TIMELINE_VISIBLE), rest = events.slice(TIMELINE_VISIBLE);
  return `<ol class="tl">${emit(head)}</ol>` + (rest.length ? `<details class="more"><summary>Tampilkan ${rest.length} entri lainnya</summary><ol class="tl">${emit(rest)}</ol></details>` : "");
}

function periodPanel(per, mode) {
  if (per.empty) return `<p class="sub">${esc(per.sub)}</p><p class="note">Belum ada posisi ditutup pada periode ini.</p>`;
  const a = per.agg, n = a.n.toLocaleString("en-US");
  const kpi = (lab, val, sub) => `<div class="kpi"><span class="lab">${lab}</span><span class="val">${val}</span><span class="sub">${sub}</span></div>`;
  const xt = per.hourly ? hourTicks(per.pts) : [];
  const ex = per.hourly ? { tfmt: hm, unit: "jam", annotI: -1, xt: xt.length ? xt : undefined } : { annotI: per.annotI };
  const bx = per.hourly ? { tick: (q) => Number(q.tl.slice(0, 2)) % 6 === 0 } : {};
  return `<p class="sub">${esc(per.sub)}</p>
<div class="kpis">${kpi("Net PnL", usd(a.net, per.hourly ? 2 : 0), `${n} posisi ditutup`)}${kpi("Win rate", `${Math.round((a.wins / a.n) * 100)}%`, `${a.wins.toLocaleString("en-US")} dari ${n}`)}${kpi("Rata-rata", pct(a.avg), "per posisi")}${kpi("Stop loss", `${((a.slN / a.n) * 100).toFixed(1)}%`, `${a.slN} close · ${usd(a.slUsd)}`)}</div>
<h3>PnL kumulatif sejak awal periode</h3>${lineSvg(per.pts, { ...ex, label: `PnL kumulatif ${per.label}, akhir ${usd(per.pts.at(-1).y)}` })}
<h3>PnL per ${per.gran}</h3><div class="legend"><span><i class="pos"></i>untung</span><span><i class="neg"></i>rugi</span></div>${colSvg(per.bars, { ...bx, label: `PnL per ${per.gran}, ${per.label}` })}
<h3>PnL per alasan close</h3>${divBars(a.rows)}
<details class="more"><summary>Tabel PnL per ${per.gran} (${per.bars.length} baris)</summary><div class="scroll-x"><table class="data"><thead><tr><th>${per.hourly ? "Jam" : per.gran === "hari" ? "Tanggal" : "Minggu"}</th><th class="n">PnL</th><th class="n">Posisi</th></tr></thead><tbody>${per.bars.slice().reverse().map((q) => `<tr><td>${esc(q.label)}</td><td class="n">${usd(q.d, 2)}</td><td class="n">${q.n}</td></tr>`).join("")}</tbody></table></div></details>`;
}
// x-axis labels of the hourly line chart: the same clock hours as the bar chart (every 6th hour).
const hourTicks = (pts) => pts.map((p, i) => (Number(hm(p.t).slice(0, 2)) % 6 === 0 && i > 0 ? i : -1)).filter((i) => i >= 0);

function lessonsSection(d, w) {
  const item = (l) => `<li><span class="chip ${l.tone === "good" ? "lg" : l.tone === "bad" ? "lb" : "ln"}">${esc(l.type)}</span><span class="lt">${hm(l.t)}${l.pct != null ? ` · ${pct(l.pct)}` : ""}</span><p>${esc(l.rule)}</p></li>`;
  const its = d.lessons.items;
  const list = its.length
    ? `<ul class="lsn">${its.slice(0, LESSONS_VISIBLE).map(item).join("")}</ul>` + (its.length > LESSONS_VISIBLE ? `<details class="more"><summary>Tampilkan ${its.length - LESSONS_VISIBLE} lesson lainnya</summary><ul class="lsn">${its.slice(LESSONS_VISIBLE).map(item).join("")}</ul></details>` : "")
    : `<p class="note">${esc(w.noles)}</p>`;
  const ag = d.lessons.aggregates;
  const parsed = ag.filter((r) => !r.raw), raw = ag.filter((r) => r.raw);
  const tb = parsed.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>Strategi</th><th>bin_step</th><th class="n">Win</th><th class="n">Rata-rata</th><th class="n">n</th></tr></thead><tbody>${parsed.map((r) => `<tr><td>${esc(r.strat)}</td><td>${esc(r.range)}</td><td class="n">${r.win}%</td><td class="n">${pct(r.avg, 1)}</td><td class="n">${r.n}</td></tr>`).join("")}</tbody></table></div>` : "";
  const rawList = raw.length ? `<ul class="lsn">${raw.map((r) => `<li><p>${esc(r.raw)}</p></li>`).join("")}</ul>` : "";
  const aggBlock = ag.length ? `<details class="more"><summary>Statistik agregat (${ag.length} baris)</summary><p class="note">Dihitung ulang tiap 20 close dari data beberapa hari terakhir. Ini angka yang diperbarui, bukan pelajaran baru, jadi tidak dihitung di teks briefing.</p>${tb}${rawList}</details>` : "";
  return `<section class="sec"><div class="sec-head"><h2>${esc(w.les)}</h2><p class="sub">${its.length} dari ${d.stats.closed} close</p></div>${list}${aggBlock}</section>`;
}

function perfSection(d) {
  const radios = d.periods.map((p) => `<input type="radio" name="per" id="per-${p.id}"${p.def ? " checked" : ""}>`).join("");
  const seg = `<div class="seg">${d.periods.map((p) => `<label for="per-${p.id}">${esc(p.label)}</label>`).join("")}</div>`;
  const panels = `<div class="panels">${d.periods.map((p) => `<div class="panel" id="pan-${p.id}">${periodPanel(p, d.mode)}</div>`).join("")}</div>`;
  return `<section class="sec"><div class="sec-head"><h2>Performa</h2><p class="sub">Pilih periode</p></div><div class="perf">${radios}${seg}${panels}</div></section>`;
}

function reportCss(periods) {
  const perCss = periods.map((p) => `.rpt #per-${p.id}:checked~.seg label[for=per-${p.id}]{background:var(--ink);color:var(--bg);border-color:var(--ink)}.rpt #per-${p.id}:checked~.panels #pan-${p.id}{display:grid}.rpt #per-${p.id}:focus-visible~.seg label[for=per-${p.id}]{outline:2px solid var(--pos);outline-offset:2px}`).join("\n");
  return `.rpt{--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px 16px 36px;display:grid;gap:30px;font-family:var(--sans);font-size:15px;line-height:1.5;color:var(--ink)}
.rpt *{box-sizing:border-box}.rpt h1,.rpt h2,.rpt h3,.rpt p,.rpt ul,.rpt ol,.rpt dl,.rpt dd{margin:0}.rpt ul,.rpt ol{padding:0;list-style:none}
.rpt h1{font-size:27px;line-height:1.15;font-weight:700;letter-spacing:-.01em;text-wrap:balance}.rpt h2{font-size:18px;font-weight:700;letter-spacing:-.005em}.rpt h3{font-size:14px;font-weight:600;margin-top:6px}
.rpt .eyebrow{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;color:var(--ink2)}.rpt .sub,.rpt .muted{color:var(--muted)}.rpt .sub{font-size:13px}
.rpt .head{display:grid;gap:6px}.rpt .head-pills{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px}
.rpt .sec{display:grid;gap:12px;min-width:0}.rpt .sec-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 12px}
.rpt .pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;border-radius:999px;font-size:12.5px;font-weight:600;color:var(--ink);white-space:nowrap;width:fit-content}.rpt .pill svg{width:13px;height:13px;flex:none}
.rpt .pill.good{background:color-mix(in srgb,var(--good) 16%,transparent)}.rpt .pill.good svg{color:var(--good)}.rpt .pill.warn{background:color-mix(in srgb,var(--warn) 24%,transparent)}.rpt .pill.warn svg{color:var(--warn)}
.rpt .pill.serious{background:color-mix(in srgb,var(--serious) 22%,transparent)}.rpt .pill.serious svg{color:var(--serious)}.rpt .pill.neutral{background:var(--surface2);color:var(--ink2)}.rpt .pill.neutral svg{color:var(--muted)}
.rpt .kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.rpt .kpi{background:var(--surface);padding:12px 14px;display:grid;gap:1px;align-content:start}.rpt .kpi .lab{font-size:13px;color:var(--ink2)}.rpt .kpi .val{font-size:26px;font-weight:600;line-height:1.2;letter-spacing:-.01em}.rpt .kpi .sub{font-size:12.5px;color:var(--muted)}
.rpt .strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;font-size:13px}.rpt .strip dt{font-size:11.5px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}.rpt .strip dd{font-weight:600;font-variant-numeric:tabular-nums}
.rpt .attn{display:grid;gap:12px}.rpt .attn li{display:grid;gap:4px}.rpt .attn p{font-size:14px;color:var(--ink2)}
.rpt .poscards{display:grid;gap:12px}.rpt .poscard{border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:14px;display:grid;gap:12px;min-width:0}
.rpt .pos-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:6px 8px}.rpt .pos-name{font-weight:600;font-size:16px;overflow-wrap:anywhere}.rpt .pos-meta{font-size:12.5px;color:var(--muted)}
.rpt .pos-pnl{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.rpt .pos-pnl .big{font-size:28px;font-weight:600;letter-spacing:-.01em;line-height:1.1}.rpt .pos-pnl .peak{font-size:13px;color:var(--ink2)}
.rpt .meter{position:relative;height:22px}.rpt .meter .zone{position:absolute;top:8px;height:6px}.rpt .meter .zone.l{background:var(--neg-wash);border-radius:3px 0 0 3px}.rpt .meter .zone.p{background:var(--pos-wash);border-radius:0 3px 3px 0}
.rpt .meter .tk{position:absolute;top:3px;width:2px;height:16px;margin-left:-1px;border-radius:1px}.rpt .tk.sl,.rpt .k.sl{background:var(--crit)}.rpt .tk.zero,.rpt .k.zero{background:var(--axis)}.rpt .tk.trail,.rpt .k.trail{background:var(--warn)}.rpt .tk.floor,.rpt .k.floor{background:var(--serious)}.rpt .tk.be,.rpt .k.be{background:var(--ink2)}.rpt .tk.peak{background:var(--muted)}
.rpt .meter .now{position:absolute;top:4px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 2px var(--surface)}
.rpt .mkey{display:grid;gap:4px;font-size:13px}.rpt .mkey li{display:grid;grid-template-columns:10px 1fr auto;gap:8px;align-items:baseline}.rpt .mkey .k{width:10px;height:10px;border-radius:2px;transform:translateY(1px);display:block}.rpt .mkey .k.now{border-radius:50%;background:var(--ink)}
.rpt .mkey b{font-weight:600}.rpt .mkey .d{color:var(--muted);font-size:12.5px}
.rpt .rng{height:10px;border-radius:5px;background:var(--surface2);overflow:hidden;position:relative}.rpt .rng .fill{position:absolute;inset:0 auto 0 0;background:var(--depth)}.rpt .rng-lab{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted);margin-top:4px}.rpt .rng-lab b{color:var(--ink2);font-weight:600}
.rpt .note{font-size:13px;color:var(--ink2);border-left:2px solid var(--axis);padding-left:10px}
.rpt .tl{display:grid}.rpt .day{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:12px 0 4px}.rpt .day:first-child{padding-top:0}
.rpt .ev{display:grid;grid-template-columns:44px 84px minmax(0,1fr);gap:2px 10px;padding:10px 0;border-top:1px solid var(--line);align-items:start}.rpt .day+.ev{border-top:0}
.rpt .ev time{font-size:13px;color:var(--ink2);font-variant-numeric:tabular-nums;padding-top:2px}.rpt .ev-body{display:grid;gap:3px;min-width:0}.rpt .ev-title{font-weight:600;overflow-wrap:anywhere}.rpt .ev-title .muted{font-weight:400;font-size:13px}
.rpt .ev-res{font-variant-numeric:tabular-nums}.rpt .ev-reason{font-size:13.5px;color:var(--ink2);overflow-wrap:anywhere}.rpt .ev-rej{font-size:13px;color:var(--muted);padding-left:14px!important;list-style:disc!important}.rpt .ev-rej li{display:list-item}
.rpt .chip{display:inline-block;font-size:10.5px;font-weight:600;letter-spacing:.05em;padding:3px 6px;border-radius:4px;text-transform:uppercase;width:fit-content;white-space:nowrap}
.rpt .chip.deploy,.rpt .chip.lg{background:var(--pos-wash);color:var(--ink);box-shadow:inset 3px 0 0 var(--pos)}.rpt .chip.close,.rpt .chip.ln{background:var(--surface2);color:var(--ink);box-shadow:inset 3px 0 0 var(--ink2)}.rpt .chip.sl,.rpt .chip.lb{background:var(--neg-wash);color:var(--ink);box-shadow:inset 3px 0 0 var(--crit)}
.rpt .chip.nodeploy{color:var(--ink2);border:1px solid var(--axis)}.rpt .chip.skip{color:var(--muted);border:1px dashed var(--axis)}
@media (max-width:420px){.rpt .ev{grid-template-columns:40px minmax(0,1fr)}.rpt .ev .ev-body{grid-column:1/-1}}
.rpt details.more>summary{cursor:pointer;font-size:13.5px;color:var(--ink2);width:fit-content;padding:4px 0}.rpt details.more[open]>summary{margin-bottom:6px}
.rpt svg.chart{display:block;width:100%;max-width:480px;height:auto;overflow:visible}.rpt svg .grid{stroke:var(--line);stroke-width:1}.rpt svg .axis0{stroke:var(--axis);stroke-width:1}
.rpt svg .tick{fill:var(--muted);font-size:11px;font-family:var(--sans);font-variant-numeric:tabular-nums}.rpt svg .line{fill:none;stroke:var(--pos);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.rpt svg .area{fill:var(--pos);fill-opacity:.10}
.rpt svg .dot{fill:var(--pos);stroke:var(--surface);stroke-width:2}.rpt svg .endlabel,.rpt svg .vlabel{fill:var(--ink);font-size:11.5px;font-weight:600;font-family:var(--sans);font-variant-numeric:tabular-nums}
.rpt svg .annot{stroke:var(--ink2);stroke-width:1}.rpt svg .annot-t{fill:var(--ink2);font-size:10.5px;font-family:var(--sans)}.rpt svg .bar.pos{fill:var(--pos)}.rpt svg .bar.neg{fill:var(--neg)}.rpt svg .hit{fill:transparent}.rpt svg g:hover .bar{opacity:.8}
.rpt .legend{display:flex;gap:14px;font-size:12.5px;color:var(--ink2)}.rpt .legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;transform:translateY(1px)}.rpt .legend i.pos{background:var(--pos)}.rpt .legend i.neg{background:var(--neg)}
.rpt .divbars{display:grid;gap:8px}.rpt .db{display:grid;grid-template-columns:minmax(84px,112px) minmax(0,1fr) 68px;gap:10px;align-items:center;font-size:13.5px}.rpt .db .l span{color:var(--muted);font-size:12px;margin-left:4px}
.rpt .db .t{position:relative;height:14px}.rpt .db .z{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--axis)}.rpt .db .b{position:absolute;top:0;height:14px}.rpt .db .b.pos{background:var(--pos);border-radius:0 4px 4px 0}.rpt .db .b.neg{background:var(--neg);border-radius:4px 0 0 4px}.rpt .db .v{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.rpt table.data{border-collapse:collapse;width:100%;font-size:13.5px}.rpt table.data th{text-align:left;font-weight:600;color:var(--ink2);font-size:11.5px;letter-spacing:.03em;text-transform:uppercase;padding:6px 8px 6px 0;border-bottom:1px solid var(--line);white-space:nowrap}
.rpt table.data td{padding:7px 8px 7px 0;border-bottom:1px solid var(--line)}.rpt table.data .n{text-align:right;font-variant-numeric:tabular-nums}.rpt .scroll-x{overflow-x:auto}
.rpt .perf{position:relative;display:grid;gap:14px}.rpt .perf>input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.rpt .seg{display:flex;flex-wrap:wrap;gap:6px}.rpt .seg label{padding:6px 12px;border:1px solid var(--axis);border-radius:999px;font-size:13px;font-weight:500;color:var(--ink2);cursor:pointer;background:var(--surface);user-select:none}.rpt .seg label:hover{background:var(--surface2)}
.rpt .panel{display:none;gap:12px;min-width:0;align-content:start}.rpt .panels .panel>*{min-width:0}
${perCss}
.rpt .lsn{display:grid;gap:12px}.rpt .lsn li{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;align-items:center}.rpt .lsn .lt{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}.rpt .lsn p{grid-column:1/-1;font-size:13.5px;color:var(--ink2);overflow-wrap:anywhere}
.rpt .foot{font-size:12.5px;color:var(--muted)}`;
}

const LIGHT = { bg: "#f3f5f7", surface: "#fcfcfd", surface2: "#eef1f4", ink: "#101820", ink2: "#4a5562", muted: "#66717d", line: "#dde2e8", axis: "#c3cad2", pos: "#2a78d6", neg: "#e34948", "pos-wash": "rgba(42,120,214,0.10)", "neg-wash": "rgba(227,73,72,0.10)", depth: "#c9d2dc", good: "#0ca30c", warn: "#fab219", serious: "#ec835a", crit: "#d03b3b" };
const DARK = { bg: "#0d1014", surface: "#151a20", surface2: "#1c222a", ink: "#edf1f5", ink2: "#b4bec9", muted: "#8b96a1", line: "#272e37", axis: "#3a434e", pos: "#3987e5", neg: "#e66767", "pos-wash": "rgba(57,135,229,0.16)", "neg-wash": "rgba(230,103,103,0.14)", depth: "#3a4552", good: "#0ca30c", warn: "#fab219", serious: "#ec835a", crit: "#d03b3b" };
const decl = (o) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(";");
const TOKENS_CSS = `:root{${decl(LIGHT)}}@media (prefers-color-scheme: dark){:root{${decl(DARK)};color-scheme:dark}}`;

/** Render the full standalone document. Every dynamic string goes through esc(). */
export function renderReportHtml(d) {
  const w = WORDS[d.mode] || WORDS.briefing;
  const s = d.stats;
  const kpi = (lab, val, sub) => `<div class="kpi"><span class="lab">${lab}</span><span class="val">${val}</span><span class="sub">${sub}</span></div>`;
  const h1 = d.mode === "viz" ? `${dowName(d.now)}, ${dm(d.now)} · ${hm(d.now)} WIB` : `${dowName(d.now)}, ${dm(d.now)} ${wib(d.now).getUTCFullYear()}`;
  const regimePill = d.regime ? pill(d.regime === "healthy" ? "good" : "warn", d.regime === "healthy" ? "check" : "tri", `Regime ${d.regime}`) : "";
  const livePill = d.liveOk ? "" : pill("neutral", "info", "Data posisi live tidak tersedia");
  const attn = d.attention.length
    ? `<ul class="attn">${d.attention.map((i) => `<li>${pill(i.cls, i.ic, i.head)}<p>${esc(i.body)}</p></li>`).join("")}</ul>`
    : `<p>${pill("good", "check", "Tidak ada yang perlu dicek")}</p>`;
  const cards = d.positions.length ? `<div class="poscards">${d.positions.map(posCard).join("")}</div>` : `<p class="note">Tidak ada posisi terbuka.</p>`;
  const cover = d.decisions.coverFrom != null
    ? `<p class="note">Log keputusan menyimpan 100 entri terakhir, jadi daftar ini mulai ${dm(d.decisions.coverFrom)} ${hm(d.decisions.coverFrom)}. Angka di atas tetap mencakup 24 jam penuh.</p>` : "";
  const events = d.decisions.items.length ? timeline(d.decisions.items) : `<p class="note">Tidak ada keputusan tercatat dalam 24 jam terakhir.</p>`;
  const sinceStrip = d.since
    ? `<dl class="strip"><div><dt>Sejak 30 Sep</dt><dd>${d.since.n.toLocaleString("en-US")} close</dd></div><div><dt>Rata-rata</dt><dd>${pct(d.since.avg)}</dd></div><div><dt>Stop loss</dt><dd>${d.since.slShare.toFixed(1)}%</dd></div><div><dt>Trailing</dt><dd>${d.since.trailing}</dd></div></dl>` : "";
  const body = `<main class="rpt">
<header class="head"><div class="eyebrow">${esc(w.eyebrow)}</div><h1>${esc(h1)}</h1>
<p class="sub">Jendela 24 jam: ${dm(d.now - DAY)} ${hm(d.now - DAY)} – ${dm(d.now)} ${hm(d.now)} WIB</p>
<div class="head-pills">${regimePill}${livePill}</div></header>

<section class="sec"><h2>24 jam terakhir</h2>
<div class="kpis">${kpi("Net PnL", usd(s.net, 2), `${s.perfCount} posisi ditutup`)}${kpi("Fee diterima", `$${s.fees.toFixed(2)}`, "dari posisi yang ditutup")}${kpi("Win rate", s.winRatePct != null ? `${s.winRatePct}%` : "N/A", s.perfCount ? `${s.wins} dari ${s.perfCount} close` : "belum ada close")}${kpi("Dibuka / ditutup", `${s.opened} / ${s.closed}`, `${s.openCount} posisi terbuka sekarang`)}</div>
${sinceStrip}</section>

<section class="sec"><h2>${esc(w.check)}</h2>${attn}</section>

<section class="sec"><div class="sec-head"><h2>Posisi terbuka</h2><p class="sub">Titik = PnL sekarang. Garis = ambang exit.</p></div>${cards}</section>

<section class="sec"><div class="sec-head"><h2>${esc(w.dec)}</h2></div>
${cover}${events}</section>

${lessonsSection(d, w)}

${perfSection(d)}
<footer class="foot">Dibuat bot pada ${dm(d.now)} ${hm(d.now)} WIB dari state.json, lessons.json dan decision-log.json.</footer>
</main>`;
  const title = d.mode === "viz" ? `Meridian Viz ${dm(d.now)} ${hm(d.now)}` : `Meridian Briefing ${dm(d.now)} ${wib(d.now).getUTCFullYear()}`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${TOKENS_CSS}\nbody{margin:0;background:var(--bg)}${reportCss(d.periods)}</style></head><body>${body}</body></html>`;
}

// ─── file name, Telegram caption, and the one-call entry point ─────────────────────────────────────
export function reportFileName(mode, now = Date.now()) {
  return mode === "viz" ? `meridian-viz-${ymd(now)}_${hm(now).replace(":", "")}.html` : `meridian-briefing-${ymd(now)}.html`;
}

/** Short Telegram caption (parse_mode HTML). Only numbers and the regime name, so nothing needs escaping. */
export function reportCaption(d) {
  if (d.mode !== "viz") return "Laporan lengkap: posisi, keputusan semalam, lessons, performa";
  const s = d.stats;
  const net = `${s.net >= 0 ? "+" : "-"}$${Math.abs(s.net).toFixed(2)}`;
  return [
    `📊 <b>Meridian</b> · ${dm(d.now)} ${hm(d.now)} WIB`,
    `Posisi ${s.openCount}${d.regime ? ` · Regime ${esc(d.regime)}` : ""}`,
    `24 jam: ${net} · ${s.perfCount} close${s.winRatePct != null ? ` · win ${s.winRatePct}%` : ""}`,
  ].join("\n");
}

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch (e) {
    log("report_warn", `Failed to read ${file}: ${e.message}`);
    return fallback;
  }
}

/** Read the three data files once; the briefing text stats are computed from the same objects. */
export function loadReportInputs(now = Date.now()) {
  const state = readJson(STATE_FILE, { positions: {} });
  const lessonsData = readJson(LESSONS_FILE, { lessons: [], performance: [] });
  const decisions = readJson(DECISION_LOG_FILE, { decisions: [] });
  return {
    perf: lessonsData.performance || [],
    lessons: lessonsData.lessons || [],
    decisions: decisions.decisions || [],
    tracked: Object.values(state.positions || {}),
    stats: collectBriefingStats(now, { state, lessonsData }),
  };
}

/**
 * Build the report for Telegram.
 * @param {{mode?:"briefing"|"viz", positions?:Array|null, now?:number}} opts
 *   positions: getMyPositions().positions (cached is fine), or null when the fetch failed.
 */
export function generateReport({ mode = "briefing", positions = null, now = Date.now() } = {}) {
  const data = buildReportData(loadReportInputs(now), { now, mode, positions });
  return { html: renderReportHtml(data), fileName: reportFileName(mode, now), caption: reportCaption(data) };
}
