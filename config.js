import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
    // Ceiling for USDC-quoted deploys (USD). null → derived from maxDeployAmount × live SOL price,
    // so USDC sizing works out-of-the-box but can be set explicitly to decouple it from SOL price.
    maxDeployAmountUsd: u.maxDeployAmountUsd ?? null,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minFeePerBinStep: u.minFeePerBinStep ?? 0.0007, // fee_active_tvl_ratio / bin_step — normalises fee density against range width. Prevents low-fee-density wide-bin pools from passing screening.
    // Adaptive evolution (lessons.js evolveThresholds)
    evolveWindowDays:          numericConfig(u.evolveWindowDays)          ?? 14,   // only evaluate closed positions within this window (0/null = all history)
    minFeeActiveTvlRatioFloor: numericConfig(u.minFeeActiveTvlRatioFloor) ?? 0.04, // relax can never lower minFeeActiveTvlRatio below this
    minOrganicFloor:           numericConfig(u.minOrganicFloor)           ?? 55,   // relax can never lower minOrganic below this
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    // Allowed quote tokens (pool token_y) the bot may screen + deploy into. SOL pools are funded
    // by the wallet's SOL balance, USDC pools by the USDC balance. Each cycle picks ONE target
    // quote (the one with the largest idle-deployable balance in USD). Set to ["SOL"] to revert
    // to SOL-only behaviour. USDT is recognised by the quote registry but off by default.
    quoteTokens:       u.quoteTokens        ?? ["SOL", "USDC"],
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 55,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    maxPump1hPct:       u.maxPump1hPct       ?? 80,   // block extreme 1h pumps (anti-FOMO). Set null to disable.
    maxDump1hPct:       u.maxDump1hPct       ?? -35, // default -35. Drop candidates whose 1h price change is below this. Smart-money escape hatch. Set null to disable.
    minPoolAgeHours:    u.minPoolAgeHours    ?? null, // null = disabled. Measures token age (not LP pool age). Set to 1-2 to block very new tokens without conflicting with category="trending".
    lastPoolStandingGuard:      u.lastPoolStandingGuard      ?? true, // skip cycle when 1 MARKUP candidate survives among ≥ minBearish CAPITULATION/DISTRIBUTION pools
    lastPoolStandingMinBearish: u.lastPoolStandingMinBearish ?? 3,    // min bearish-flow pools required to trigger last-pool-standing guard
    // Volume TA entry signals (soft hints to LLM, not hard filters)
    volumeTrendDeclineThreshold: u.volumeTrendDeclineThreshold ?? 0.6,  // trend_ratio < 0.6 → DECLINING
    volumeTrendExpandThreshold:  u.volumeTrendExpandThreshold  ?? 1.4,  // trend_ratio > 1.4 → EXPANDING
    entryBuySellRatio:           u.entryBuySellRatio           ?? 1.5,  // sells/buys > 1.5 → BEARISH signal
    // Declining-volume HARD filter (rejects candidate before LLM). Uses volume_change_pct
    // at the volatility timeframe (>=30m), not the noisy 5m window. Smart money overrides.
    filterDecliningVolume:        u.filterDecliningVolume        ?? true, // toggle the hard filter
    volumeCollapseRejectThreshold: u.volumeCollapseRejectThreshold ?? -50,  // reject if vol_change < -50% over the volatility timeframe
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    outOfRangeWaitMinutesAbove: u.outOfRangeWaitMinutesAbove ?? u.outOfRangeWaitMinutes ?? 30, // override OOR timeout when active_bin > upper_bin (bid_ask: position still SOL, never activated)
    oorAboveGraceMin:    u.oorAboveGraceMin    ?? 15, // grace window (min) after OOR ABOVE — Rule 8/9 skip during this period (entry phase protection)
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    emergencyExitCooldownHours: u.emergencyExitCooldownHours ?? 4,
    // In-range dump cooldown: token died WITHIN our bin range (high range-eff + meaningful
    // loss + SL/sell-pressure close) — a token-quality failure, not position design. Cool the
    // base mint so the screener does not immediately redeploy the same dying token. bid_ask
    // losses get a longer cooldown (they produce the worst left-tail dumps).
    inRangeDumpCooldownEnabled: u.inRangeDumpCooldownEnabled ?? true,
    inRangeDumpCooldownHours: u.inRangeDumpCooldownHours ?? 12,
    inRangeDumpCooldownLossPct: u.inRangeDumpCooldownLossPct ?? -5,
    inRangeDumpCooldownRangeEff: u.inRangeDumpCooldownRangeEff ?? 70,
    inRangeDumpCooldownBidAskMult: u.inRangeDumpCooldownBidAskMult ?? 2,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minAgeBeforeStopLoss:  u.minAgeBeforeStopLoss  ?? 15, // minutes before stop loss can fire
    earlyDumpOverridePct:  u.earlyDumpOverridePct  ?? -10, // bypass age gate when loss already this deep (early dump guard)
    // Rule 6 max-age: soft cap rather than a hard close. Once a position is older than
    // maxPositionAgeMinutes it is closed ONLY if it has stopped earning. While PnL is still
    // drifting up (or unclaimed fees are still accruing >= feeGrowthMinSol over the lookback
    // window) the close is deferred, up to maxAgeExtensions grace blocks of ageExtensionMinutes
    // each (hard ceiling = maxPositionAgeMinutes + maxAgeExtensions * ageExtensionMinutes).
    maxPositionAgeMinutes:    u.maxPositionAgeMinutes    ?? 2880, // soft cap (48h default)
    feeGrowthLookbackMinutes: u.feeGrowthLookbackMinutes ?? 20,   // window to measure "still earning"
    feeGrowthMinSol:          u.feeGrowthMinSol          ?? 0.01, // min fee accrual over window to count as earning
    ageExtensionMinutes:      u.ageExtensionMinutes      ?? 45,   // length of one grace block
    maxAgeExtensions:         u.maxAgeExtensions          ?? 3,    // max grace blocks before hard close
    // Entry-grace zone: Rule 9 is suppressed while price is still in the SOL-rich part of range.
    // curveEntryGraceDepthPct: grace while depth < 35% (curve SOL mostly near top, still buying)
    // bidAskEntryGraceDepthPct: grace while depth < 80% (bid_ask SOL heavy at bottom, accumulating)
    // entryGraceConfirmMinutes: sustained breach required before Rule 9 activates (wick filter)
    curveEntryGraceDepthPct:   numericConfig(u.curveEntryGraceDepthPct)   ?? 50,
    bidAskEntryGraceDepthPct:  numericConfig(u.bidAskEntryGraceDepthPct)  ?? 80,
    entryGraceConfirmMinutes:  numericConfig(u.entryGraceConfirmMinutes)  ?? 15,
    breakEvenTriggerPct:   u.breakEvenTriggerPct   ?? 1,  // once peak PnL >= this, protect against going below 0%
    breakEvenInRangeDeferMin: u.breakEvenInRangeDeferMin ?? 60, // max minutes to defer break-even while in-range (0 = no deferral)
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // ── USDC-quote sizing (used when a cycle targets a USDC pool) ──
    // All null by default → derived from the SOL-denominated keys × live SOL price, so USDC
    // deploys work without extra config. Set explicitly (in USDC/USD) to size USDC positions
    // independently of the SOL price.
    deployAmountUsd:       u.deployAmountUsd       ?? null,  // floor per USDC deploy (USD)
    minUsdcToOpen:         u.minUsdcToOpen         ?? null,  // min idle USDC to start a USDC cycle (USD)
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    trailingGivebackDivisor: u.trailingGivebackDivisor ?? 3, // widened drop = peak / N; lower N = more tolerant
    // Stale-peak handling: a peak set long ago no longer reflects the current price regime.
    // Once the all-time peak is older than trailingStalePeakMinutes, widen the trailing drop
    // tolerance by trailingStalePeakDropMult so a settled position is not closed against a stale high.
    trailingStalePeakMinutes:  u.trailingStalePeakMinutes  ?? 90,
    trailingStalePeakDropMult: u.trailingStalePeakDropMult ?? 1.75,
    trailingInRangeDeferMin:   u.trailingInRangeDeferMin   ?? 90, // max minutes to defer trailing TP while in-range
    // ── Layer B: LLM-set per-position risk thresholds (clamped) ──
    allowLlmRiskParams:    u.allowLlmRiskParams     ?? true, // let SCREENER set per-position sl/trailing overrides
    stopLossFloorPct:      u.stopLossFloorPct       ?? -50,  // loosest (most negative) SL the LLM may set
    stopLossTightestPct:   u.stopLossTightestPct    ?? -8,   // tightest (least negative) SL the LLM may set
    // ── Auto-SL: code-injected volatility-adaptive stop-loss ──
    // When the LLM doesn't set sl_pct, executor.js injects one based on pool volatility.
    // Low-vol curve positions don't need -15% room; a -8% SL cuts losses before bleed.
    autoSlEnabled:    u.autoSlEnabled    ?? true,
    autoSlLowVolMax:  u.autoSlLowVolMax  ?? 2,   // vol <= this → low-vol tier
    autoSlLowVolPct:  u.autoSlLowVolPct  ?? -8,  // SL for low-vol pools
    autoSlMidVolMax:  u.autoSlMidVolMax  ?? 4,   // vol <= this → mid-vol tier
    autoSlMidVolPct:  u.autoSlMidVolPct  ?? -12, // SL for mid-vol pools
    autoSlHighVolPct: u.autoSlHighVolPct ?? -15, // SL for high-vol pools (vol > autoSlMidVolMax). Dedicated key — do NOT reuse stopLossPct (that is the -50 emergency floor).
    // ── Layer A: LLM veto on trailing take-profit (soft exit only) ──
    allowTpVeto:           u.allowTpVeto            ?? true, // let MANAGER hold a triggered trailing TP
    maxTpVetos:            u.maxTpVetos             ?? 3,    // max consecutive holds before force-close
    tpVetoFloorDivisor:    u.tpVetoFloorDivisor     ?? 2,    // force-close once give-back >= peak / divisor
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // ── Partial exit (scale-out) — let MANAGER take part of a winner at the trailing-TP point ──
    partialExit: {
      enabled:               u.partialExit?.enabled               ?? false, // opt-in; off → existing binary TP behaviour
      minPeakPct:            u.partialExit?.minPeakPct            ?? 4,     // partial only offered once peak PnL >= this
      defaultPct:            u.partialExit?.defaultPct            ?? 50,    // suggested scale-out size shown to the LLM
      minPct:                u.partialExit?.minPct                ?? 25,    // clamp: smallest allowed scale-out
      maxPct:                u.partialExit?.maxPct                ?? 75,    // clamp: largest allowed scale-out (always leave a runner)
      stage2TrailingDropPct: u.partialExit?.stage2TrailingDropPct ?? 0.8,  // tighten remainder's trailing drop after a partial
      minRemainderUsd:       u.partialExit?.minRemainderUsd       ?? 15,    // skip partial if the leftover position would be dust
    },
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Emergency Exit Rules ───────────────
  emergencyExits: {
    volumeCollapse: {
      enabled:           u.emergencyExits?.volumeCollapse?.enabled           ?? true,
      dropThresholdPct:  u.emergencyExits?.volumeCollapse?.dropThresholdPct  ?? 30,
      minPositionAgeMin: u.emergencyExits?.volumeCollapse?.minPositionAgeMin ?? 10,
      minPeakVolumeUsd:  u.emergencyExits?.volumeCollapse?.minPeakVolumeUsd  ?? 2000,
      sellPressureRatio:  u.emergencyExits?.volumeCollapse?.sellPressureRatio  ?? 2,
      minSellConfirmTxns: u.emergencyExits?.volumeCollapse?.minSellConfirmTxns ?? 5,   // min total txns before sell/buy ratio is trusted
    },
    rapidPriceDrop: {
      enabled:               u.emergencyExits?.rapidPriceDrop?.enabled               ?? true,
      dropPct5m:             u.emergencyExits?.rapidPriceDrop?.dropPct5m             ?? -8,
      requireNegativePnl:    u.emergencyExits?.rapidPriceDrop?.requireNegativePnl    ?? true,
      minPositionAgeMin:     u.emergencyExits?.rapidPriceDrop?.minPositionAgeMin     ?? 10,
      requireSellConfirm:    u.emergencyExits?.rapidPriceDrop?.requireSellConfirm    ?? false,
      minSellBuyRatio:       u.emergencyExits?.rapidPriceDrop?.minSellBuyRatio       ?? 1.5,
      minSellConfirmTxns:    u.emergencyExits?.rapidPriceDrop?.minSellConfirmTxns    ?? 5,   // min total txns (sells+buys) before sell/buy ratio is trusted
    },
    // Rule 9: persistent sell-pressure streak — slow bleed exit before stop loss fires
    sellPressureStreak: {
      enabled:           u.emergencyExits?.sellPressureStreak?.enabled           ?? true,
      streakCount:       u.emergencyExits?.sellPressureStreak?.streakCount       ?? 3,    // consecutive 5m windows
      ratio:             u.emergencyExits?.sellPressureStreak?.ratio             ?? 1.2,  // sells > buys × ratio
      safetyPnlPct:      u.emergencyExits?.sellPressureStreak?.safetyPnlPct     ?? 5,    // skip if PnL > +5%
      windowMin:         u.emergencyExits?.sellPressureStreak?.windowMin         ?? 30,   // lookback window (min)
      snapshotMaxAgeMin: u.emergencyExits?.sellPressureStreak?.snapshotMaxAgeMin ?? 120,  // max snapshot retention (min)
      minPositionAgeMin: u.emergencyExits?.sellPressureStreak?.minPositionAgeMin ?? 0,    // skip if position younger than N minutes (avoid early-window noise)
    },
  },

  // ─── Market Regime Detection ─────────────
  marketRegime: {
    enabled:       u.marketRegime?.enabled       ?? true,
    skipOnBearish: u.marketRegime?.skipOnBearish ?? true,
    notifyOnSkip:  u.marketRegime?.notifyOnSkip  ?? true,
    // Caution-regime deployment throttle: reduce correlated exposure on soft-market days.
    // When caution, cap concurrent positions below maxPositions and slow screening cadence.
    cautionMaxPositions:  u.marketRegime?.cautionMaxPositions  ?? 3,  // max concurrent positions while caution (vs risk.maxPositions)
    cautionScreeningMult: u.marketRegime?.cautionScreeningMult ?? 2,  // multiply screening interval while caution (slower cadence)
    cautionPositionSizeMult: u.marketRegime?.cautionPositionSizeMult ?? 0.75, // scale fair-share deploy size while caution (limits nominal exposure)
    _activeRegime: "healthy",  // runtime-only: latest assessed regime, shared with computeDeployAmount (set by index.js screening cycle)
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    bidAskMinVolatility: numericConfig(u.bidAskMinVolatility) ?? null, // deprecated: kept so old configs don't break
    curveMaxVolatility: numericConfig(u.curveMaxVolatility) ?? numericConfig(u.bidAskMinVolatility) ?? 3.5, // vol <= this → curve (concentrated fee); above → bid_ask (dip accumulation)
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:            u.managementIntervalMin            ?? 10,
    screeningIntervalMin:             u.screeningIntervalMin             ?? 30,
    screeningIntervalNoPositionMin:   u.screeningIntervalNoPositionMin   ?? 10, // faster screening cadence while below maxPositions (capacity free)
    screeningNoDeployBackoffCount:    u.screeningNoDeployBackoffCount    ?? 2,  // consecutive no-deploy screens before backing off to screeningIntervalMin
    healthCheckIntervalMin:           u.healthCheckIntervalMin           ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "rsi_reversal",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
    // TA-based exit (independent of entry indicator gate)
    taExitEnabled:         indicatorUserConfig.taExitEnabled         ?? false,
    taExitMinPnlPct:       indicatorUserConfig.taExitMinPnlPct       ?? 2,    // min PnL % before TA exit can trigger
    taExitRsiLength:       indicatorUserConfig.taExitRsiLength       ?? 14,   // RSI length for exit (longer = smoother than entry default 2)
    taExitNearAbovePct:    indicatorUserConfig.taExitNearAbovePct    ?? 80,   // depth% at which position is "near above" (0% = OOR above, 100% = deep in range)
    taExitModulatorDropPct: indicatorUserConfig.taExitModulatorDropPct ?? 0.5, // tightened trailing drop % when RSI overbought
  },
};

/**
 * Compute the optimal deploy amount using Equity Fair-Share + Regime Modulation.
 *
 * Each position targets an equal slice of TOTAL equity (wallet + open-position value),
 * independent of deploy order — this removes the front-loading of the old
 * `deployable × positionSizePct` formula (where the first deploy was always largest and
 * idle capital piled up in the tail). When the market regime is "caution", the target is
 * scaled down by `cautionPositionSizeMult` to limit nominal exposure on soft-market days.
 *
 * Formula:
 *   equitySol  = walletSol + openPositionsValueSol
 *   baseShare  = equitySol / risk.maxPositions          (fixed divisor — NOT cautionMaxPositions)
 *   regimeMult = (_activeRegime === "caution") ? cautionPositionSizeMult : 1.0
 *   deployable = max(0, walletSol - gasReserve)
 *   deploy     = clamp(baseShare × regimeMult, floor=deployAmountSol, ceil=min(maxDeployAmount, deployable))
 *
 * @param {number} walletSol            Native SOL balance available in wallet.
 * @param {object} [opts]
 * @param {number} [opts.openPositionsValueSol=0]  Total value of open positions, in SOL.
 *                 When omitted (fallback callers), equity degrades to walletSol — conservative, never errors.
 *
 * Examples (defaults: gasReserve=0.2, maxPositions=5, floor=0.5; healthy regime):
 *   wallet 3.41 SOL + positions 4.07 SOL → equity 7.48 / 5 = 1.50 SOL deploy
 *   same, caution regime (×0.75)                              → 1.12 SOL deploy
 */
export const configMeta = {
  lastEvolved:          u._lastEvolved          ?? null,
  positionsAtEvolution: u._positionsAtEvolution ?? null,
};

// Decimals for supported quote tokens (single source of truth for lamport conversion + sizing).
const QUOTE_DECIMALS = { SOL: 9, USDC: 6, USDT: 6 };

/**
 * Resolve a quote token (given as a symbol like "SOL"/"USDC" OR a mint address) to its
 * canonical { symbol, mint, decimals }. Returns null for unknown/unsupported quotes so callers
 * can fall back to SOL or reject. Used by screening, deploy validation, sizing, and auto-swap.
 */
export function getQuoteMeta(quote) {
  if (!quote) return null;
  const t = config.tokens;
  let symbol = null;
  if (quote === "SOL" || quote === "native" || quote === t.SOL) symbol = "SOL";
  else if (quote === "USDC" || quote === t.USDC) symbol = "USDC";
  else if (quote === "USDT" || quote === t.USDT) symbol = "USDT";
  if (!symbol) return null;
  return { symbol, mint: t[symbol], decimals: QUOTE_DECIMALS[symbol] };
}

/**
 * Compute the optimal deploy amount in the units of the target quote, using Equity Fair-Share
 * + Regime Modulation. The SOL path is byte-identical to the original (regression-safe); the
 * USDC path mirrors the same fair-share math in USD and returns a USDC amount.
 *
 * @param {number} walletSol  Native SOL balance (used for the SOL path + SOL deployable).
 * @param {object} [opts]
 * @param {number}  [opts.openPositionsValueSol=0]  SOL-path equity contribution from open positions (SOL).
 * @param {string}  [opts.quote="SOL"]              Target quote: "SOL" or "USDC".
 * @param {number}  [opts.usdcBalance=0]            Idle USDC balance (USDC path).
 * @param {number}  [opts.solPrice=0]               Live SOL/USD price (to derive USDC floor/ceil when not set explicitly).
 * @param {number}  [opts.openPositionsValueUsd=0]  USDC-path equity contribution from open USDC positions (USD).
 * @returns {number} Deploy amount in the quote's own units (SOL or USDC).
 */
export function computeDeployAmount(walletSol, opts = {}) {
  const {
    openPositionsValueSol = 0,
    quote = "SOL",
    usdcBalance = 0,
    solPrice = 0,
    openPositionsValueUsd = 0,
  } = opts;

  const maxPositions = config.risk.maxPositions || 1;
  const regime     = config.marketRegime?._activeRegime ?? "healthy";
  const regimeMult = regime === "caution"
    ? (config.marketRegime?.cautionPositionSizeMult ?? 0.75)
    : 1.0;

  // ── USDC path: equity fair-share in USD, returned as a USDC amount ──
  if ((quote || "SOL").toUpperCase() === "USDC") {
    const price    = Number(solPrice) > 0 ? Number(solPrice) : 0;
    const floorUsd = config.management.deployAmountUsd ?? (price > 0 ? config.management.deployAmountSol * price : 0);
    const ceilUsd  = config.risk.maxDeployAmountUsd   ?? (price > 0 ? config.risk.maxDeployAmount   * price : Infinity);
    const usdc     = Math.max(0, Number(usdcBalance) || 0);
    const posUsd   = Number.isFinite(openPositionsValueUsd) ? Math.max(0, openPositionsValueUsd) : 0;
    const equityUsd    = usdc + posUsd;
    const baseShareUsd = equityUsd / maxPositions;
    const targetUsd    = baseShareUsd * regimeMult;
    // deployable = idle USDC (gas reserve is SOL, validated separately in the executor)
    const result = Math.min(ceilUsd, usdc, Math.max(floorUsd, targetUsd));
    return parseFloat(Math.max(0, result).toFixed(2));
  }

  // ── SOL path (unchanged) ──
  const reserve = config.management.gasReserve ?? 0.2;
  const floor   = config.management.deployAmountSol;
  const ceil    = config.risk.maxDeployAmount;

  const posValueSol = Number.isFinite(openPositionsValueSol) ? Math.max(0, openPositionsValueSol) : 0;
  const equitySol   = Math.max(0, walletSol) + posValueSol;
  const baseShare   = equitySol / maxPositions;

  const deployable = Math.max(0, walletSol - reserve);
  const target     = baseShare * regimeMult;
  const result     = Math.min(ceil, deployable, Math.max(floor, target));
  return parseFloat(Math.max(0, result).toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minFeePerBinStep     != null) s.minFeePerBinStep     = fresh.minFeePerBinStep;
    if (fresh.evolveWindowDays          != null) s.evolveWindowDays          = numericConfig(fresh.evolveWindowDays);
    if (fresh.minFeeActiveTvlRatioFloor != null) s.minFeeActiveTvlRatioFloor = numericConfig(fresh.minFeeActiveTvlRatioFloor);
    if (fresh.minOrganicFloor           != null) s.minOrganicFloor           = numericConfig(fresh.minOrganicFloor);
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.filterDecliningVolume        !== undefined) s.filterDecliningVolume        = fresh.filterDecliningVolume;
    if (fresh.volumeCollapseRejectThreshold != null)      s.volumeCollapseRejectThreshold = fresh.volumeCollapseRejectThreshold;
    if (fresh.maxDump1hPct               !== undefined) s.maxDump1hPct               = fresh.maxDump1hPct;
    if (fresh.maxPump1hPct              !== undefined) s.maxPump1hPct              = fresh.maxPump1hPct;
    if (fresh.lastPoolStandingGuard     !== undefined) s.lastPoolStandingGuard     = fresh.lastPoolStandingGuard;
    if (fresh.lastPoolStandingMinBearish != null)      s.lastPoolStandingMinBearish = fresh.lastPoolStandingMinBearish;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
