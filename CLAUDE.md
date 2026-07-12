# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, partial_close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minFeePerBinStep | screening | 0.0007 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| maxPump1hPct | screening | 80 |
| lastPoolStandingGuard | screening | true |
| lastPoolStandingMinBearish | screening | 3 |
| entryFlowFilterEnabled | screening | true |
| entryFlowBlockRegimes | screening | ["DISTRIBUTION"] |
| entryFlowFilterSmartMoneyOverride | screening | true |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| maxPositionAgeMinutes | management | 2880 |
| feeGrowthLookbackMinutes | management | 20 |
| feeGrowthMinSol | management | 0.01 |
| ageExtensionMinutes | management | 45 |
| maxAgeExtensions | management | 3 |
| breakEvenInRangeDeferMin | management | 60 |
| trailingInRangeDeferMin | management | 90 |
| trailingGivebackDivisor | management | 3 |
| stopLossTightestPct | management | -8 |
| earlyDumpOverridePct | management | -10 |
| autoSlEnabled | management | true |
| autoSlLowVolMax | management | 2 |
| autoSlLowVolPct | management | -8 |
| autoSlMidVolMax | management | 4 |
| autoSlMidVolPct | management | -12 |
| autoSlHighVolPct | management | -15 |
| inRangeDumpCooldownEnabled | management | true |
| inRangeDumpCooldownHours | management | 12 |
| inRangeDumpCooldownLossPct | management | -5 |
| inRangeDumpCooldownRangeEff | management | 70 |
| inRangeDumpCooldownBidAskMult | management | 2 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| screeningIntervalNoPositionMin | schedule | 10 |
| screeningNoDeployBackoffCount | schedule | 2 |
| marketRegime.enabled | marketRegime | false |
| marketRegime.cautionMaxPositions | marketRegime | 3 |
| marketRegime.cautionScreeningMult | marketRegime | 2 |
| marketRegime.cautionPositionSizeMult | marketRegime | 0.75 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol, { openPositionsValueSol })`** — Equity Fair-Share + Regime Modulation. Each position targets an equal slice of **total equity** (wallet + open-position value), so size is independent of deploy order (no front-loading) and idle capital converges to ~0 as slots fill:

```
equitySol  = walletSol + openPositionsValueSol
baseShare  = equitySol / risk.maxPositions          # fixed divisor, NOT cautionMaxPositions
regimeMult = (_activeRegime === "caution") ? cautionPositionSizeMult (0.75) : 1.0
deployable = max(0, walletSol - gasReserve)
deploy     = clamp(baseShare × regimeMult, floor=deployAmountSol, ceil=min(maxDeployAmount, deployable))
```

- Pembagi **tetap** `maxPositions` (bukan `cautionMaxPositions`) — kalau caution memakai pembagi lebih kecil, posisi malah membesar (salah arah). `regimeMult` yang menangani pengecilan saat caution.
- Regime dibaca dari runtime `config.marketRegime._activeRegime` (di-set di `index.js` screening cycle setelah `assessMarketRegime`). Guard di `executor.js` membaca nilai yang sama → konsisten dengan prompt.
- Nilai posisi dikonversi via `position.total_value_true_usd ÷ sol_price` (hindari ambiguitas `solMode`). Pemanggil tanpa opts → equity degrade ke `walletSol` saja (konservatif).
- `positionSizePct` (config lama) tidak lagi dipakai untuk sizing utama; tetap ada agar `user-config.json` lama tidak pecah.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Partial** (optional): on a TP_PROPOSAL the MANAGER may `partial_close_position` → SDK `removeLiquidity(bps<10000, shouldClaimAndClose=false)` → `markPartialExit()` tightens remainder trailing stop, resets veto budget → auto-swap scaled-out token to SOL. Relay path is NOT used for partials (zap-out is full-close only).
4. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify. Closed PnL uses `allTimeWithdrawals` which already accumulates partial withdrawals (PnL is blended, no manual adjustment).
5. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates
- **Auto-SL injection**: if `sl_pct` is not provided by LLM and `autoSlEnabled=true`, executor auto-injects based on volatility tier (see Auto Stop-Loss section)

## Screener Hard Filters (index.js + screening.js — before LLM sees candidates)

Applied in order during `passing = allCandidates.filter(...)` (index.js) and `getRawPoolScreeningRejectReason()` (screening.js):
- **`maxPump1hPct`** (default 80%): drops any pool whose 1h price change exceeds threshold. Primary source: DexScreener `price_change_1h`; fallback: Jupiter `stats_1h.price_change`. Directly prevents FOMO deploys into parabolic pumps (ANSEM +172% 1h would have been blocked). Set `null` to disable.
- **`maxDump1hPct`** (default -35%): drops falling-knife tokens unless smart wallets are present.
- **`minFeePerBinStep`** (default 0.0007): `fee_active_tvl_ratio / bin_step` — normalises fee productivity against range width. A pool with bin_step=125 barely clearing the fee_tvl gate (0.05%) scores 0.0004 and is rejected; a pool with bin_step=80 and fee_tvl=0.08% scores 0.001 and passes. Prevents low-fee-density wide-bin pools that empirically produce poor bid_ask results (17-day data: bid_ask+bin_step≥100 averaged -0.7% PnL, 0.8% fee-yield). Applied in `screening.js:getRawPoolScreeningRejectReason` after the `minFeeActiveTvlRatio` check.
- **`entryFlowFilterEnabled`** (default true): drops candidates whose multi-timeframe flow consensus (`computeCandidateFlow` — DexScreener price_change + volume ratio over 5m/1h/6h) is in `entryFlowBlockRegimes` (default `["DISTRIBUTION"]` — active selling into bids, the precursor to in-range dumps like NEIL −16%). Smart-wallet presence overrides (`entryFlowFilterSmartMoneyOverride`, accumulation can absorb selling). Missing market data → NEUTRAL → not blocked (fail-safe). Hardens the soft guidance in `prompt.js` (DISTRIBUTION/CAPITULATION = skip). Shares `computeCandidateFlow` with the Last Pool Standing guard. Conservative default (DISTRIBUTION only, not CAPITULATION) to avoid over-restriction on top of auto-evolved `minFeeActiveTvlRatio`.
- `minPoolAgeHours`, `maxTop10Pct`, `minTokenFeesSol`, `maxBundlersPct`, `maxBotHoldersPct`, `blockedLaunchpads`, rugpull/PVP flags — all applied before LLM prompt is built.

## Last Pool Standing Guard (index.js — after hard filters, before LLM)

Runs after `passing` is finalized (and after single-candidate `getLoneCandidateSkipReason` check).

Trigger (all must hold, gated by `lastPoolStandingGuard=true`):
- `passing.length > 1` — multiple pools survived hard filters
- Exactly **1** pool has MARKUP flow consensus
- At least `lastPoolStandingMinBearish` (default 3) pools have CAPITULATION or DISTRIBUTION flow consensus

On trigger: cycle is skipped with `⛔ NO DEPLOY`, logging which pool was the lone MARKUP and which pools were bearish-flow. Prevents the "last pool standing" anti-pattern — deploying the only token still pumping while the market broadly sells off (the pattern that produced ANSEM -24.97%).

Flow consensus uses the same `tfFlowRegime`/`flowConsensus` functions as the screener prompt, computed from DexScreener `price_change_*` and volume ratios for each pool in `passing`.

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## PnL Poll Cooldown (index.js — 30s poller)

The 30s PnL poller can trigger an off-cycle management run when a position hits a stop-loss /
emergency-close condition before the next scheduled cycle. The trigger cooldown is **per-position**
(`_pollTriggeredAt` is a `Map<position_address, epochMs>`, not a global scalar):

- A dump on position A no longer blocks faster exits on position B. The `managementIntervalMin`
  (default 10m) cooldown applies only to re-triggering on the **same** position.
- When a position is exit-eligible but still in cooldown, the poll `continue`s to scan the
  remaining positions instead of `break`ing the whole tick (the old global-scalar bug let a
  persistently-dumping A, evaluated first each tick, starve B from ever being checked).
- When a position actually triggers, the poll `break`s — one management cycle evaluates all
  positions anyway. The 30s poll interval naturally caps triggers to ≤1 per 30s (no stampede).
- Entries for closed positions are pruned at the top of each poll tick.

This was added to cut left-tail in-range-dump overshoot: multiple positions dumping in the same
10-minute window previously had only the first one exit promptly.

---

## Capacity-Aware Screening Cadence (index.js)

Screening runs faster while the wallet has **free capacity** (`positions < maxPositions`), not just when empty. `effectiveScreeningIntervalMs()` returns `screeningIntervalNoPositionMin` (fast, default 10m) normally. After `screeningNoDeployBackoffCount` (default 2) consecutive screening cycles end with **no deploy** (LLM "⛔ NO DEPLOY" or no successful `deploy_position`), it backs off to `screeningIntervalMin` (default 30m). `_noDeployStreak` increments on each no-deploy cycle and resets to 0 on a successful deploy (`isScreeningBackedOff()` gates the cadence). Applied in both the 0-position branch and the post-management trigger of `runManagementCycle`.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- `evolveThresholds()` evolves `minFeeActiveTvlRatio` and `minOrganic` based on winner/loser fee_tvl_ratio and organic_score distributions

**Lesson types:**
- `AVOID` — screener should avoid similar pools
- `PREFER` — screener should seek similar pools
- `WARN` — in-range dump: high range-efficiency (>70%) position that still hit SL/sell-pressure. Indicates token quality failure, not position design failure. Uses higher `loserEvidenceWeight` (+0.20).

**`loserEvidenceWeight` scaling:**
- `range_efficiency >= 70` (in-range dump): +0.20 — meaningful token-quality signal
- `range_efficiency <= 30` (OOR): +0.20 — position design signal
- `range_efficiency <= 50`: +0.10
- Otherwise: +0.05 (ambiguous)

---

## Auto Stop-Loss (executor.js)

Volatility-adaptive SL enforced at deploy time when `autoSlEnabled=true`:

```
vol <= autoSlLowVolMax (2)  → autoSlLowVolPct  (-8%)   [tier: low]
vol <= autoSlMidVolMax (4)  → autoSlMidVolPct  (-12%)  [tier: mid]
vol >  autoSlMidVolMax      → autoSlHighVolPct (-15%)  [tier: high]
```

`autoSl` is clamped to `[stopLossFloorPct, stopLossTightestPct]` = `[-50%, -8%]`, then:
- **`sl_pct` absent** → inject `autoSl`
- **LLM `sl_pct` WIDER than `autoSl`** (more negative) → **cap to `autoSl`**. Prevents the WOC pattern (LLM self-set -25% stop bled to -22.9%; auto-SL -12% would have cut it).
- **LLM `sl_pct` TIGHTER than `autoSl`** → kept (high-conviction override allowed).

High tier uses dedicated `autoSlHighVolPct` (-15%), **not** `stopLossPct` (which is the -50% emergency floor — reusing it gave high-vol deploys a -50% auto-SL bug). Logged as `Auto-SL: ...` / `Auto-SL cap: ...`.

---

## In-Range Deferral (state.js)

Break-even and trailing TP are **not** suppressed indefinitely while `in_range=true`. Instead, a bounded grace timer gates the close:

**Break-even (`breakEvenInRangeDeferMin`, default 60m):**
- Timer starts (`break_even_in_range_since`) on first in-range detection with PnL ≤ 0
- If position goes OOR before timer expires → timer resets, fires immediately
- If PnL recovers above 0 → timer resets (position improving, no close needed)
- After grace expires → BREAK_EVEN fires normally

**Trailing TP (`trailingInRangeDeferMin`, default 90m):**
- Mirror logic with `trailing_in_range_since` timestamp
- Timer only runs while `dropFromPeak >= effectiveDrop` and `in_range=true`
- Resets if drop recovers or position goes OOR

**Trailing giveback divisor (`trailingGivebackDivisor`, default 3):**
```js
effectiveDrop = max(effTrailingDropFloor, peak_pnl_pct / trailingGivebackDivisor)
```
Higher divisor = tighter stop relative to peak.

---

## Early-Dump SL Override (state.js)

Normally `minAgeBeforeStopLoss` (default 15m) suppresses SL in the first 15 minutes to avoid noise. The early-dump override bypasses this gate when the position is clearly dying:

```js
earlyDumpOverride = age < minAgeBeforeStopLoss && currentPnlPct <= earlyDumpOverridePct (-10%)
```

If override fires, the STOP_LOSS reason is tagged `[early-dump override]`.

---

## Market Regime Deployment Throttle (index.js)

When `marketRegime.enabled=true`, the screener checks regime before each cycle. Regime is scored 0–4.5 across three signals (price breadth 5m+1h, volume momentum, flow ratio):

- **healthy** (score < 1.5): normal operation
- **caution** (1.5 ≤ score < 3.0): position cap at `cautionMaxPositions` (default 3); screening interval multiplied by `cautionScreeningMult` (default 2×); quality thresholds raised for the cycle and restored after; **deploy size scaled by `cautionPositionSizeMult` (default 0.75)** via `computeDeployAmount`
- **bearish** (score ≥ 3.0): screening skipped entirely

Caution threshold elevation is stored in `_cautionOrigFeeRatio`/`_cautionOrigOrganic` before modification and restored in the `finally` block to prevent compounding across cycles.

The assessed regime is also written to runtime `config.marketRegime._activeRegime` (set right after `assessMarketRegime`, or forced to `"healthy"` when `marketRegime.enabled=false`). This is the **only** channel `computeDeployAmount` (config.js) and the deploy guard (executor.js) use to apply caution size modulation — they don't import `_lastRegime`. `deployAmount` is computed **after** the regime block in `runScreeningCycle` so the current cycle's regime modulates size; the executor guard reads the same value, keeping prompt and guard consistent (15% tolerance absorbs position-value drift).

**Live message safety:** the screener wraps its execution in a `try/finally` that calls `liveMessage.finalize()`. All early-returns inside the `try` block must assign `screenReport` before returning — a bare `return "string"` bypasses `finalize()` and leaves `_liveMessageDepth > 0`, which permanently suppresses all Telegram notifications (`notifyClose`, `notifyDeploy`, etc.) until process restart.

---

## In-Range Dump Cooldown (pool-memory.js)

`recordPoolDeploy()` already cools pools/tokens for low-yield, emergency-exit ("rapid dump"/"volume collapse"), repeated-OOR, and repeat-fee-generating closes. The **in-range dump** trigger covers the token-quality failure pattern those miss: a token that fell *within* our bin range and closed via stop-loss/sell-pressure.

Trigger (all must hold, gated by `inRangeDumpCooldownEnabled`):
- `range_efficiency > inRangeDumpCooldownRangeEff` (default 70) — token died in-range, not OOR
- `pnl_pct <= inRangeDumpCooldownLossPct` (default -5%) — meaningful loss, not a small dip
- `close_reason` matches `/stop.?loss|sell.?pressure/`

On trigger, the **base mint** is cooled for `inRangeDumpCooldownHours` (default 12h base), scaled by loss severity and strategy:

```
severityMult = |pnl_pct| >= 20 ? 4 : |pnl_pct| >= 12 ? 2 : 1   // rug-grade / large / normal
strategyMult = bid_ask ? inRangeDumpCooldownBidAskMult (2) : 1
hours        = min(72, baseHours * severityMult * strategyMult)  // capped at 72h
```

Examples: -7% curve → 12h; -14% bid_ask → 48h; -22.9% curve (WOC) → 48h; -22.9% bid_ask → 72h (cap). Enforced via `isBaseMintOnCooldown()` in `screening.js` — cooled tokens are filtered out before the LLM sees candidates. Prevents repeat-deploying the same dying token (e.g. SPCX losing twice, or WOC returning as a candidate after one night on a flat 12h cooldown).

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.js`. It uses built-in Agent Meridian defaults unless overridden by config or env.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

- `lessons.js evolveThresholds()` evolves `minFeeActiveTvlRatio` and `minOrganic`. Fixed: `maxVolatility` block removed (key never existed), `minFeeTvlRatio` renamed to `minFeeActiveTvlRatio`.
- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
- Rule 6 (max age, `index.js`) is a **soft cap with earning-grace**: past `maxPositionAgeMinutes` the position closes only if it has stopped earning. While PnL still drifts up (or unclaimed fees accrue ≥ `feeGrowthMinSol` over `feeGrowthLookbackMinutes`), the close is deferred up to `maxAgeExtensions` blocks of `ageExtensionMinutes` (hard ceiling = `maxPositionAgeMinutes + maxAgeExtensions * ageExtensionMinutes`). Earning is judged from pool-memory position snapshots via `getSnapshotWindow()`. Fixed: `maxPositionAgeMinutes` is now mapped in `config.js` management block (previously absent → writes to user-config.json silently had no effect; only the hardcoded `?? 2880` fallback applied).
- Rule 9 (sell pressure): `streakCount` default lowered 3 → 2 (fixed). 4 days of data showed Rule 9 confirming AFTER positions already overshot their auto-SL tier by 1-6% (e.g. yep -18.12% vs -12% tier, ok-SOL -14.37% vs -12% tier) — the 3-window confirm was too slow for fast bleeds. Cadence validation in `startCronJobs` (`maxSnapshots = windowMin/managementIntervalMin`) still holds at defaults (30/10=3 ≥ 2).
- `curveMaxVolatility` (strategy block): default shifted from 3 → 3.5 to avoid premature maxBinsBelow on mid-volatility tokens.
