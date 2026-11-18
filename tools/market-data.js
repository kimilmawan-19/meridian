import { log } from "../logger.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex/pairs/solana";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

/** @type {Map<string, {data: object, ts: number}>} */
const _cache = new Map();

const _stats = { hits: 0, misses: 0, errors: 0, totalLatencyMs: 0, fetchCount: 0 };

/**
 * Fetch 5m/1h/6h market data for a Solana pair from DexScreener.
 * Results are cached for 60 seconds per pair address.
 * Returns null on any failure — never throws.
 *
 * @param {string} pairAddress  Meteora pool address (= DexScreener pairAddress for Solana)
 * @returns {Promise<{
 *   volume_5m: number|null, volume_1h: number|null, volume_6h: number|null, volume_24h: number|null,
 *   price_change_5m: number|null, price_change_1h: number|null, price_change_6h: number|null,
 *   txn_buys_5m: number|null, txn_sells_5m: number|null,
 *   liquidity_usd: number|null, fetched_at: string
 * }|null>}
 */
export async function fetchPoolMarketData(pairAddress) {
  if (!pairAddress) return null;

  const cached = _cache.get(pairAddress);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    _stats.hits++;
    return cached.data;
  }

  _stats.misses++;
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${DEXSCREENER_BASE}/${pairAddress}`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - t0;
    _stats.totalLatencyMs += latencyMs;
    _stats.fetchCount++;

    if (!res.ok) {
      _stats.errors++;
      log("market_data", `DexScreener HTTP ${res.status} for ${pairAddress.slice(0, 8)} (${latencyMs}ms)`);
      return null;
    }

    const json = await res.json();
    // DexScreener returns { pairs: [...] } for /pairs/solana/:address
    const pair = Array.isArray(json?.pairs) ? json.pairs[0] : (json?.pair ?? null);
    if (!pair) {
      _stats.errors++;
      log("market_data", `DexScreener: pair not found for ${pairAddress.slice(0, 8)} (${latencyMs}ms)`);
      return null;
    }

    const data = {
      volume_5m:        pair.volume?.m5       ?? null,
      volume_1h:        pair.volume?.h1       ?? null,
      volume_6h:        pair.volume?.h6       ?? null,
      volume_24h:       pair.volume?.h24      ?? null,
      price_change_5m:  pair.priceChange?.m5  ?? null,
      price_change_1h:  pair.priceChange?.h1  ?? null,
      price_change_6h:  pair.priceChange?.h6  ?? null,
      txn_buys_5m:      pair.txns?.m5?.buys   ?? null,
      txn_sells_5m:     pair.txns?.m5?.sells  ?? null,
      liquidity_usd:    pair.liquidity?.usd   ?? null,
      fetched_at:       new Date().toISOString(),
    };

    log("market_data", `DexScreener OK ${pairAddress.slice(0, 8)} — vol5m=$${data.volume_5m ?? "?"} price5m=${data.price_change_5m ?? "?"}% (${latencyMs}ms)`);
    _cache.set(pairAddress, { data, ts: Date.now() });
    return data;
  } catch (err) {
    _stats.errors++;
    const latencyMs = Date.now() - t0;
    if (err.name === "AbortError") {
      log("market_data", `DexScreener timeout for ${pairAddress.slice(0, 8)} (${latencyMs}ms)`);
    } else {
      log("market_data", `DexScreener fetch failed for ${pairAddress.slice(0, 8)}: ${err.message} (${latencyMs}ms)`);
    }
    return null;
  }
}

/**
 * Returns cache hit/miss/error counts and average fetch latency.
 * @returns {{ hits: number, misses: number, errors: number, fetchCount: number, avgLatencyMs: number, hitRatePct: number|null }}
 */
export function getMarketDataStats() {
  const total = _stats.hits + _stats.misses;
  return {
    hits:         _stats.hits,
    misses:       _stats.misses,
    errors:       _stats.errors,
    fetchCount:   _stats.fetchCount,
    avgLatencyMs: _stats.fetchCount > 0 ? Math.round(_stats.totalLatencyMs / _stats.fetchCount) : 0,
    hitRatePct:   total > 0 ? Math.round((_stats.hits / total) * 100) : null,
  };
}

/** Clear the in-process cache (useful for testing). */
export function clearMarketDataCache() {
  _cache.clear();
}

