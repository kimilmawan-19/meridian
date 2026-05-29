/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  top_cluster_trend = null,
  sl_pct_override = null,
  trailing_trigger_override = null,
  trailing_drop_override = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    peak_pnl_at: null,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
    break_even_active: false,
    top_cluster_trend: top_cluster_trend ?? null,
    // Layer B: per-position risk overrides (raw; clamped at read time)
    sl_pct_override: sl_pct_override ?? null,
    trailing_trigger_override: trailing_trigger_override ?? null,
    trailing_drop_override: trailing_drop_override ?? null,
    // Layer A: trailing-TP veto budget tracking
    tp_veto_count: 0,
    tp_veto_peak: null,
    peak_volume_5m_usd: null,
    last_market_data_at: null,
    volume_history: [],
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Detect OOR direction relative to position range.
 * Returns "ABOVE" if price moved above upper_bin, "BELOW" if below lower_bin, null otherwise.
 * For bid_ask single-sided SOL: ABOVE = position never activated (still SOL),
 * BELOW = position fully traversed (now token).
 */
export function getOorDirection(p) {
  if (!p || p.in_range !== false) return null;
  if (p.active_bin == null || p.upper_bin == null || p.lower_bin == null) return null;
  if (p.active_bin > p.upper_bin) return "ABOVE";
  if (p.active_bin < p.lower_bin) return "BELOW";
  return null;
}

/**
 * Returns true if position was observed OOR ABOVE within the given window.
 * Used by Rule 8 (rapid dump) and Rule 9 (sell streak) to skip emergency exits
 * while a bid_ask position is still in its entry phase after a recent OOR ABOVE state.
 */
export function wasRecentlyOorAbove(position_address, windowMs) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.last_oor_above_at) return false;
  return (Date.now() - new Date(pos.last_oor_above_at).getTime()) < windowMs;
}

/**
 * Track when a position's active bin first exits the entry-grace zone (depth >= graceDepth).
 * Clears the timestamp when price returns to the grace zone (wick recovery).
 * Used by Rule 9 to require a sustained confirmation before firing — prevents premature
 * closes on brief wicks that cross the grace boundary and immediately recover.
 */
export function updateR9GraceZone(position_address, depth_pct, graceDepth) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  let changed = false;
  if (depth_pct < graceDepth) {
    // Still within (or returned to) grace zone — clear timer so a future breach restarts fresh
    if (pos.r9_grace_exited_at != null) {
      pos.r9_grace_exited_at = null;
      changed = true;
    }
  } else {
    // Breached grace zone — start timer only if not already running
    if (pos.r9_grace_exited_at == null) {
      pos.r9_grace_exited_at = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) save(state);
}

/**
 * Layer B: resolve the effective stop-loss % for a position, honoring an LLM-set
 * override but clamping it between the loosest (floor) and tightest bounds so a bad
 * override can neither remove the safety net nor make it fire on normal oscillation.
 */
export function effectiveStopLossPct(tracked, mgmtConfig) {
  const floor = mgmtConfig.stopLossFloorPct ?? -50;     // most negative allowed
  const tightest = mgmtConfig.stopLossTightestPct ?? -10; // least negative allowed
  const raw = (mgmtConfig.allowLlmRiskParams && tracked?.sl_pct_override != null)
    ? tracked.sl_pct_override
    : mgmtConfig.stopLossPct;
  if (raw == null) return mgmtConfig.stopLossPct;
  // clamp into [floor, tightest], e.g. [-50, -10]
  return Math.min(tightest, Math.max(floor, raw));
}

/**
 * Layer A: record that the MANAGER LLM chose to HOLD a triggered trailing take-profit.
 * Stores the peak at veto time so a later new high can refund the veto budget.
 * Returns the new veto count.
 */
export function recordTpVeto(position_address, peakPnlPct) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return 0;
  pos.tp_veto_count = (pos.tp_veto_count ?? 0) + 1;
  pos.tp_veto_peak = peakPnlPct ?? pos.peak_pnl_pct ?? null;
  save(state);
  return pos.tp_veto_count;
}

/**
 * Layer A: reset the trailing-TP veto budget (e.g. after a new peak made the hold pay off).
 */
export function resetTpVeto(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || (pos.tp_veto_count ?? 0) === 0) return;
  pos.tp_veto_count = 0;
  pos.tp_veto_peak = null;
  save(state);
}

/**
 * Update market data fields for multiple positions in a single disk write.
 * Migrates existing positions that predate these fields.
 *
 * @param {Map<string, {volume_5m: number|null, fetched_at: string}>} updates
 *   Map of position_address → market data object from fetchPoolMarketData
 */
export function batchUpdateMarketData(updates) {
  if (!updates || updates.size === 0) return;
  const state = load();
  const now = new Date().toISOString();
  for (const [position_address, md] of updates) {
    const pos = state.positions[position_address];
    if (!pos) continue;
    // Migrate fields if missing (existing positions pre-patch)
    if (pos.peak_volume_5m_usd === undefined) pos.peak_volume_5m_usd = null;
    if (!Array.isArray(pos.volume_history)) pos.volume_history = [];

    const vol5m = md.volume_5m ?? null;
    // Update peak
    if (vol5m != null && (pos.peak_volume_5m_usd == null || vol5m > pos.peak_volume_5m_usd)) {
      pos.peak_volume_5m_usd = vol5m;
    }
    // Append to rolling history (max 5 entries)
    if (vol5m != null) {
      pos.volume_history.push({ ts: md.fetched_at ?? now, volume_5m: vol5m });
      if (pos.volume_history.length > 5) pos.volume_history.shift();
    }
    pos.last_market_data_at = md.fetched_at ?? now;
  }
  save(state);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct, options = {}) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  if (options.immediate) {
    pos.peak_pnl_pct = candidatePnlPct;
    pos.peak_pnl_at = new Date().toISOString();
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from relay poll`);
    return true;
  }

  const changed =
    pos.pending_peak_pnl_pct == null ||
    candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
  return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    const prevPeak = pos.peak_pnl_pct ?? 0;
    const newPeak = Math.max(prevPeak, pendingPeak, currentPnlPct);
    // Stamp the time only when the peak actually advances, so peak_pnl_at marks
    // when the all-time high was set (used by trailing TP to detect stale peaks).
    if (newPeak > prevPeak || pos.peak_pnl_at == null) pos.peak_pnl_at = new Date().toISOString();
    pos.peak_pnl_pct = newPeak;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  save(state);
  log("state", `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
  const dropFromPeak = peakPnlPct - currentPnlPct;
  if (dropFromPeak < trailingDropPct) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_current_pnl_pct == null ||
    currentPnlPct < pos.pending_trailing_current_pnl_pct ||
    dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = dropFromPeak;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`);
  return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? (pendingPeak - pendingCurrent);
  // Use effective drop at queue time (same proportional formula as the trigger).
  const effectiveDrop = Math.max(trailingDropPct, pendingPeak / 3);

  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = currentPnlPct != null && (pendingPeak - currentPnlPct) >= effectiveDrop;

  if (stillNearCrash && stillDroppedEnough) {
    const reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${effectiveDrop.toFixed(2)}%)`;
    pos.confirmed_trailing_exit_reason = reason;
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
    return { confirmed: true, reason };
  }

  save(state);
  log("state", `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const {
    pnl_pct: currentPnlPct,
    pnl_pct_suspicious,
    in_range,
    fee_per_tvl_24h,
    unclaimed_fees_usd,
    collected_fees_usd,
    total_value_usd,
  } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  if (pos.confirmed_trailing_exit_until) {
    if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
      // If position is back in range since confirmation was queued, cancel the exit —
      // fee collection is still active and the trailing signal is no longer valid.
      if (in_range === true) {
        log("state", `Trailing TP confirmed exit cancelled for ${position_address} — back in range`);
        pos.confirmed_trailing_exit_reason = null;
        pos.confirmed_trailing_exit_until = null;
        save(state);
        return null;
      }
      const reason = pos.confirmed_trailing_exit_reason;
      pos.confirmed_trailing_exit_reason = null;
      pos.confirmed_trailing_exit_until = null;
      save(state);
      return { action: "TRAILING_TP", reason, confirmed_recheck: true };
    }
    pos.confirmed_trailing_exit_reason = null;
    pos.confirmed_trailing_exit_until = null;
  }

  let changed = false;

  // Layer B: per-position trailing overrides (clamped to sane minimums)
  const effTrailingTrigger = (mgmtConfig.allowLlmRiskParams && pos.trailing_trigger_override != null)
    ? Math.max(1, pos.trailing_trigger_override)
    : mgmtConfig.trailingTriggerPct;
  const effTrailingDropFloor = (mgmtConfig.allowLlmRiskParams && pos.trailing_drop_override != null)
    ? Math.max(0.5, pos.trailing_drop_override)
    : mgmtConfig.trailingDropPct;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= effTrailingTrigger) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Activate break-even stop once peak reaches breakEvenTriggerPct.
  // Skip when OOR ABOVE (position is idle SOL, never entered range) — break-even has no meaning
  // while the position hasn't activated yet and a natural dip would immediately close it.
  const oorDirForBreakEven = getOorDirection(positionData);
  if (!pos.break_even_active && (pos.peak_pnl_pct ?? 0) >= (mgmtConfig.breakEvenTriggerPct ?? 1) && oorDirForBreakEven !== "ABOVE") {
    pos.break_even_active = true;
    changed = true;
    log("state", `Position ${position_address} break-even stop activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  // Track most recent OOR ABOVE moment — used by Rule 8/9 to grant a grace period
  // after a bid_ask position transitions from OOR ABOVE back to in-range. The dump
  // that brings price into our range IS the intended entry signal; continued dumping
  // right after entry should not immediately trigger emergency exits.
  if (in_range === false && getOorDirection(positionData) === "ABOVE") {
    pos.last_oor_above_at = new Date().toISOString();
    changed = true;
  }

  if (changed) save(state);

  // ── Break-even stop ───────────────────────────────────────────
  // Once peak was profitable enough, never let PnL fall back to 0% or below.
  // Skip when in range: price oscillation while actively earning fees is expected —
  // exiting on a temporary dip kills fee collection while the position is still healthy.
  if (!pnl_pct_suspicious && pos.break_even_active && currentPnlPct != null && currentPnlPct <= 0) {
    if (in_range === true) {
      log("state", `Break-even deferred for ${position_address}: in-range, pnl=${currentPnlPct.toFixed(2)}% — fee collection active`);
    } else {
      return {
        action: "BREAK_EVEN",
        reason: `Break-even stop: peak was ${(pos.peak_pnl_pct ?? 0).toFixed(2)}%, now ${currentPnlPct.toFixed(2)}%`,
      };
    }
  }

  // ── Stop loss ──────────────────────────────────────────────────
  const { age_minutes: slAgeMin } = positionData;
  const minAgeForStopLoss = mgmtConfig.minAgeBeforeStopLoss ?? 15;
  const effSL = effectiveStopLossPct(pos, mgmtConfig);
  if (
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    effSL != null &&
    currentPnlPct <= effSL &&
    (slAgeMin == null || slAgeMin >= minAgeForStopLoss)
  ) {
    const slTag = pos.sl_pct_override != null && mgmtConfig.allowLlmRiskParams ? " [per-position]" : "";
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${effSL}%${slTag} (age: ${slAgeMin ?? "?"}m)`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  // Skip when in range: a PnL dip from peak while actively earning fees is normal price
  // oscillation, not a signal to exit. Let the position continue accumulating fees.
  if (!pnl_pct_suspicious && pos.trailing_active && in_range !== true) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    // Widen drop tolerance proportionally at higher peaks: give back at most 1/3 of gains.
    // trailingDropPct (or per-position override) acts as floor so low-peak positions keep their tight stop.
    let effectiveDrop = Math.max(effTrailingDropFloor, pos.peak_pnl_pct / 3);
    // Stale-peak widening: if the all-time peak was set long ago and price has since settled
    // lower, the trailing stop is measuring against a high that no longer reflects reality.
    // Widen tolerance so a stabilized position is not force-exited against an outdated peak.
    let stalePeak = false;
    const stalePeakMin = mgmtConfig.trailingStalePeakMinutes;
    if (stalePeakMin != null && pos.peak_pnl_at) {
      const peakAgeMin = (Date.now() - new Date(pos.peak_pnl_at).getTime()) / 60_000;
      if (peakAgeMin >= stalePeakMin) {
        effectiveDrop *= (mgmtConfig.trailingStalePeakDropMult ?? 1.75);
        stalePeak = true;
      }
    }
    if (dropFromPeak >= effectiveDrop) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${effectiveDrop.toFixed(2)}%${stalePeak ? ", stale-peak widened" : ""})`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
        effective_drop_pct: effectiveDrop,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  // Note: OOR timeout decision is handled in getDeterministicCloseRule (index.js Rule 4)
  // where market data (buy/sell pressure) is available for the recovery-signal guard.
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  const minAgeForPositionMetric = 30; // minutes before position-level rate is reliable
  if (mgmtConfig.minFeePerTvl24h != null && (slAgeMin == null || slAgeMin >= minAgeForYieldCheck)) {
    // Position-level fee rate: actual fees earned (claimed + unclaimed) extrapolated to 24h.
    // More accurate than the pool's 24h rolling average which is dominated by pre-deploy history.
    // Only trusted after minAgeForPositionMetric minutes; falls back to pool metric while too young.
    let effectiveFeeRate = fee_per_tvl_24h; // fallback: pool 24h metric
    let metricSource = "pool_24h";
    if (
      slAgeMin >= minAgeForPositionMetric &&
      total_value_usd > 0
    ) {
      const totalFeesEarned = (collected_fees_usd ?? 0) + (unclaimed_fees_usd ?? 0);
      const positionFeeRate24h = (totalFeesEarned / total_value_usd) * (1440 / slAgeMin) * 100;
      if (Number.isFinite(positionFeeRate24h)) {
        effectiveFeeRate = positionFeeRate24h;
        metricSource = "position_actual";
      }
    }
    if (effectiveFeeRate != null && effectiveFeeRate < mgmtConfig.minFeePerTvl24h) {
      return {
        action: "LOW_YIELD",
        reason: `Low yield: fee/TVL ${effectiveFeeRate.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% [${metricSource}] (age: ${slAgeMin ?? "?"}m)`,
      };
    }
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
