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
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| screeningIntervalNoPositionMin | schedule | 10 |
| screeningNoDeployBackoffCount | schedule | 2 |
| marketRegime.enabled | marketRegime | false |
| marketRegime.cautionMaxPositions | marketRegime | 3 |
| marketRegime.cautionScreeningMult | marketRegime | 2 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

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

Volatility-adaptive SL injected at deploy time when `sl_pct` is absent and `autoSlEnabled=true`:

```
vol <= autoSlLowVolMax (2)  → autoSlLowVolPct (-8%)   [tier: low]
vol <= autoSlMidVolMax (4)  → autoSlMidVolPct (-12%)  [tier: mid]
vol >  autoSlMidVolMax      → stopLossPct (-15%)      [tier: high]
```

Result is clamped to `[stopLossFloorPct, stopLossTightestPct]` = `[-50%, -8%]`. Logged as `Auto-SL: vol=X (tier) → sl_pct=Y%`.

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
- **caution** (1.5 ≤ score < 3.0): position cap at `cautionMaxPositions` (default 3); screening interval multiplied by `cautionScreeningMult` (default 2×); quality thresholds raised for the cycle and restored after
- **bearish** (score ≥ 3.0): screening skipped entirely

Caution threshold elevation is stored in `_cautionOrigFeeRatio`/`_cautionOrigOrganic` before modification and restored in the `finally` block to prevent compounding across cycles.

**Live message safety:** the screener wraps its execution in a `try/finally` that calls `liveMessage.finalize()`. All early-returns inside the `try` block must assign `screenReport` before returning — a bare `return "string"` bypasses `finalize()` and leaves `_liveMessageDepth > 0`, which permanently suppresses all Telegram notifications (`notifyClose`, `notifyDeploy`, etc.) until process restart.

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
- Rule 9 (sell pressure): `streakCount` threshold is 3 cycles — may be too slow for fast bleeds. Candidate improvement: reduce to 2.
- `curveMaxVolatility` (strategy block): default shifted from 3 → 3.5 to avoid premature maxBinsBelow on mid-volatility tokens.
