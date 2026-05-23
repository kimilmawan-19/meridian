import { fetchTrendingBreadth } from "./tools/screening.js";
import { fetchPoolMarketData } from "./tools/market-data.js";
import { log } from "./logger.js";

/**
 * Assess market regime using a 3-layer hybrid approach:
 *
 * Layer 1 + 2: Meteora unfiltered trending pools (50 pools × 2 timeframes)
 *   — Price breadth: % of 50 trending DLMM pools with positive price change
 *   — Volume trend: avg volume_change_pct across the broad market
 *   — Multi-TF confirmation: 5m bearish + 1h bearish = genuine downtrend
 *                            5m bearish + 1h bullish = pullback (good for bid_ask, don't skip!)
 *
 * Layer 3: DexScreener for top 5 filtered candidates
 *   — Flow ratio: txn_buys_5m / txn_sells_5m (sell pressure)
 *   — Volume acceleration: volume_5m vs volume_1h/12 (market dying vs active)
 *
 * Score thresholds:
 *   >= 3.0 → bearish  → skip screening
 *   >= 1.5 → caution  → raise quality bar for this cycle
 *   <  1.5 → healthy  → proceed normally
 */
export async function assessMarketRegime(candidates = []) {
  try {
    // Layer 1 + 2: fetch both timeframes from Meteora (unfiltered trending)
    const [res5m, res1h] = await Promise.allSettled([
      fetchTrendingBreadth({ timeframe: "5m" }),
      fetchTrendingBreadth({ timeframe: "1h" }),
    ]);

    const pools5m = res5m.status === "fulfilled" ? res5m.value : [];
    const pools1h = res1h.status === "fulfilled" ? res1h.value : [];

    // Layer 3: DexScreener for top 5 candidates (flow + vol acceleration)
    const top5 = candidates.slice(0, 5);
    const dexResults = await Promise.allSettled(
      top5.map(c => fetchPoolMarketData(c.pool))
    );
    const dexData = dexResults
      .map(r => r.status === "fulfilled" ? r.value : null)
      .filter(Boolean);

    // ── Signal 1: Price Breadth (multi-TF) ──────────────────────────────
    let breadthScore = 0;
    let breadth5m = null;
    let breadth1h = null;

    if (pools5m.length >= 10) {
      const pos = pools5m.filter(p => (p.pool_price_change_pct ?? 0) > 0).length;
      breadth5m = pos / pools5m.length;
    }
    if (pools1h.length >= 10) {
      const pos = pools1h.filter(p => (p.pool_price_change_pct ?? 0) > 0).length;
      breadth1h = pos / pools1h.length;
    }

    if (breadth5m !== null) {
      if (breadth5m < 0.30) {
        // 5m is clearly bearish — check 1h for confirmation vs pullback
        if (breadth1h !== null && breadth1h < 0.40) {
          breadthScore = 2.0; // both TF bearish → genuine downtrend
        } else if (breadth1h !== null && breadth1h >= 0.55) {
          breadthScore = 0.2; // 1h still strong → pullback, good for bid_ask entry
        } else {
          breadthScore = 1.0; // 1h unknown or mixed
        }
      } else if (breadth5m < 0.45) {
        if (breadth1h !== null && breadth1h < 0.35) {
          breadthScore = 1.2; // recovering 5m but 1h trend still weak
        } else {
          breadthScore = 0.4; // slightly soft, mixed signals
        }
      }
      // breadth5m >= 0.45 → score 0 (healthy breadth)
    }

    // ── Signal 2: Volume Momentum (5m trend + acceleration) ─────────────
    let volumeScore = 0;

    // 2a: Volume change trend from Meteora 5m broad market
    const volChanges = pools5m
      .map(p => p.volume_change_pct)
      .filter(v => v != null && Number.isFinite(Number(v)))
      .map(Number);
    const avgVolChangePct = volChanges.length >= 5
      ? volChanges.reduce((a, b) => a + b, 0) / volChanges.length
      : null;

    // 2b: Volume acceleration from DexScreener (volume_5m vs expected 1h/12 baseline)
    const accels = dexData
      .map(m => {
        if (!m?.volume_1h || m.volume_1h === 0) return null;
        return (m.volume_5m ?? 0) / (m.volume_1h / 12);
      })
      .filter(v => v !== null);
    const avgAccel = accels.length > 0
      ? accels.reduce((a, b) => a + b, 0) / accels.length
      : null;

    // Combine: both signals needed for full weight; each alone gives partial weight
    if (avgVolChangePct !== null && avgAccel !== null) {
      if (avgVolChangePct < -25 && avgAccel < 0.60) volumeScore = 1.5; // market collapsing
      else if (avgVolChangePct < -25 || avgAccel < 0.60) volumeScore = 0.8;
      else if (avgVolChangePct < -15 || avgAccel < 0.75) volumeScore = 0.4;
    } else if (avgVolChangePct !== null) {
      if (avgVolChangePct < -25) volumeScore = 1.0;
      else if (avgVolChangePct < -15) volumeScore = 0.4;
    } else if (avgAccel !== null) {
      if (avgAccel < 0.50) volumeScore = 1.0;
      else if (avgAccel < 0.70) volumeScore = 0.5;
    }

    // ── Signal 3: Flow Ratio (DexScreener txn buys/sells, 5m) ───────────
    let flowScore = 0;
    const flows = dexData
      .map(m => {
        const b = m?.txn_buys_5m ?? 0;
        const s = m?.txn_sells_5m ?? 0;
        return s > 0 ? b / s : null;
      })
      .filter(v => v !== null);

    if (flows.length >= 3) {
      const avgFlow = flows.reduce((a, b) => a + b, 0) / flows.length;
      if (avgFlow < 0.75) flowScore = 1.0; // heavy sell dominance
      else if (avgFlow < 0.90) flowScore = 0.5;
    }

    // ── Final scoring ────────────────────────────────────────────────────
    const totalScore = breadthScore + volumeScore + flowScore;
    const regime = totalScore >= 3.0 ? "bearish"
      : totalScore >= 1.5 ? "caution"
      : "healthy";

    const signals = {
      breadth5m:       breadth5m !== null ? +(breadth5m * 100).toFixed(1) : null,
      breadth1h:       breadth1h !== null ? +(breadth1h * 100).toFixed(1) : null,
      avgVolChangePct: avgVolChangePct !== null ? +avgVolChangePct.toFixed(1) : null,
      avgAccel:        avgAccel !== null ? +avgAccel.toFixed(2) : null,
      poolsSampled5m:  pools5m.length,
      poolsSampled1h:  pools1h.length,
      breadthScore:    +breadthScore.toFixed(2),
      volumeScore:     +volumeScore.toFixed(2),
      flowScore:       +flowScore.toFixed(2),
    };

    log(
      "market_regime",
      `${regime.toUpperCase()} score=${totalScore.toFixed(2)}/4.5 | ` +
      `breadth 5m=${signals.breadth5m ?? "?"}% 1h=${signals.breadth1h ?? "?"}% (${pools5m.length}/${pools1h.length} pools) | ` +
      `volChange=${signals.avgVolChangePct ?? "?"}% accel=${signals.avgAccel ?? "?"}x | ` +
      `scores: breadth=${breadthScore.toFixed(2)} vol=${volumeScore.toFixed(2)} flow=${flowScore.toFixed(2)}`
    );

    return { regime, score: +totalScore.toFixed(2), signals };
  } catch (err) {
    log("market_regime", `assessMarketRegime error: ${err.message} — defaulting to healthy`);
    return { regime: "unknown", score: 0, signals: {} };
  }
}
