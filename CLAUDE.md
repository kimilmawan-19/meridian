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
| maxSwapAmount | risk | 50 |
| swapSlippageBps | risk | 500 |
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
| marketRegime.enabled | marketRegime | true |
| marketRegime.cautionMaxPositions | marketRegime | 3 |
| marketRegime.cautionScreeningMult | marketRegime | 2 |
| marketRegime.cautionPositionSizeMult | marketRegime | 0.75 |
| marketRegime.bearishScoreThreshold | marketRegime | 3.7 |
| marketRegime.cautionScoreThreshold | marketRegime | 1.8 |
| marketRegimeCautionSlMult | management | 0.85 |
| marketRegimeBearishSlMult | management | 0.7 |
| marketRegimeCautionTrailMult | management | 0.8 |
| marketRegimeBearishTrailMult | management | 0.6 |
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

## Candidate Ranking & Over-fetch (tools/screening.js `getTopCandidates`)

- **Ranking** (`scoreCandidate`): `fee_active_tvl_ratio × (organic_score / 100)`. Fee yield drives the order; organic is a mild multiplier (already hard-gated by `minOrganic`). The old additive formula (`feeTvl×1000 + organic×10 + volume/100 + holders/100`) let ~20 organic points cancel a 3× fee-yield gap at 5m magnitudes. The multiplicative form is also timeframe-invariant.
- **The LLM follows this order (since 2026-10-02).** `CANDIDATE ORDER` in the SCREENER prompt (`prompt.js`) tells it to take the first candidate with no skip signal. A lower-ranked one is allowed only when every higher one has a skip signal, or when its fee_tvl is within about 20% and it has smart wallets or a clearly better narrative. Narrative, flow MARKUP, the strategy-block PREFER lines and the Darwin weights are tie-breaks. It decides which candidate, not whether to deploy: NO DEPLOY stays valid. Each candidate block starts `POOL #k of n`. Details and data under Known Issues ("Fee/TVL-first selection").
- **Over-fetch**: after the cheap filters (occupied pool/mint, cooldowns) the list is cut to `limit × 2`, not `limit`, before the enrichment filters (PVP, wash, bundle, rugpull, ATH, volume collapse, dev blocklist, indicators). The final `limit` is taken **after** those filters, so dropped pools are backfilled by the next-best candidates instead of shrinking the list the LLM sees. Capped at 2× because each pool costs ~4 OKX calls.

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
| `/closeall confirm` | Close all positions (bare `/closeall` only asks for confirmation) |
| `/set <n> <note>` | Set note on position by list index |
| `/check <n>` | Simulate exit checks for position n (aliases: `/test-pnl-poll`, `/test-emergency-exit`) |
| `/pause` / `/resume` | Stop / resume **new deploys** only |

Full list: `formatHelpText()` in index.js.

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

**Behavior rules:**
- `/close` and `/closeall` go through `executeTool("close_position", { reason: "manual close (Telegram …)" })`, the same path as the agent. They used to call `closePosition()` directly, which skipped the auto-swap to SOL, the close notification and `logAction`, and recorded the close reason as "agent decision".
- `/pause` sets `_entriesPaused`, which makes `runScreeningCycle` return immediately. Management, the 30s PnL poll and manual `/deploy` keep running. It used to call `stopCronJobs()`, which also stopped the poll and left open positions with no SL/trailing/emergency exits. The flag is in-memory, so a restart resumes deploys.
- An unmatched `/…` command replies "Unknown command" instead of falling through to the LLM agent loop. This includes `/stop`: shutdown is server-side only.
- **Event-only cycle reports.** The management report is sent only when a cycle had a non-STAY action; the live message is created lazily right before execution. The screening report is sent only when a deploy was attempted. Both are also sent when the cycle failed. Idle cycles are silent; they used to post roughly 150–300 messages a day. A position with a `/set` note is an INSTRUCTION every cycle, so it still reports each cycle. During a reporting screening cycle, `notifyDeploy` is muted (`setDeployNotifyMuted`, cleared in `finally`), so a screening deploy sends only the full screening report, not a second `✅ Deployed`. Manual `/deploy` and chat deploys still send `notifyDeploy`.
- **Notification delivery** (`telegram.js`):
  - Every dynamic field in the `notify*` HTML helpers goes through `escapeHtml`. Close reasons are raw rule text (`Stop loss: PnL -11.2% <= -10.2%`), and an unescaped `<` made Telegram reject the message with 400 "can't parse entities". Live logs showed 3 close notifications dropped this way in 3 days, including a −68% stop loss.
  - `sendHTML` resends a failed chunk once as plain text.
  - `postTelegram` retries network failures (`fetch` threw) after 1s and then 3s. `sendChatAction` is not retried, and neither are HTTP errors. The server's route to Telegram drops often: 23 `sendMessage failed` in 3 days.
  - `notifyClose` is muted only while the management cycle's own live message is open (`setCloseNotifyMuted`), since that report lists the closes. A chat or `/learn` live message no longer swallows close notifications.
- **OOR alerts fire once per out-of-range episode** (`collectOorAlerts`, `_oorNotified`). A position is re-armed when it returns in range. Positions closed in the same cycle are skipped.
- **Auto-swap after close or partial close.** `swapToken` returns `{ success:false, error }` instead of throwing, so the executor now checks the result. A failure sends `notifyAutoSwapFailed`, which is never suppressed by a live message. Previously a failed swap was marked `auto_swapped: true`, and the failure branch never ran.

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

The poll is **not** paused while screening runs (only while management or a previous poll tick
is busy). Screening is a multi-minute LLM loop; pausing for it left open positions unwatched.

## Direct Deterministic Closes (index.js `runManagementCycle`)

Every `CLOSE` action in `actionMap` (Rules 1–11, state.js exits, forced trailing TP) is executed
directly via `executeTool("close_position", { position_address, reason })` — the same path the
LLM used, so notifications, auto-swap and `recordPerformance` still run. `CLAIM` (unclaimed ≥
`minClaimAmount`) is also executed directly via `executeTool("claim_fees")`; through the LLM it
cost about 59 calls/day (2026-09-29). The LLM is called only for judgment calls: `TP_PROPOSAL`
(0 occurrences in 92 days of logs) and `INSTRUCTION` (`/set` notes). On a failed close the position's
`_pollTriggeredAt` entry is cleared so the 30s poll retries immediately.

**Close-reason matching:** anything that parses `close_reason` must use a case-insensitive pattern, never string equality.
- Since direct closes, reasons are the rule's own text, for example `Low yield: fee/TVL … < min …`, `Rule 5: low yield (…)` or `Rule 11: liquidity collapse (…)`, not the LLM's old bare `low yield`.
- `pool-memory.js` had `close_reason === "low yield"`, so the 4h low-yield pool cooldown silently stopped firing. It now uses `/low.?yield/i`.
- The emergency cooldown list also lacked Rule 11 (liquidity collapse / rug). Such a close matched neither it nor the in-range-dump regex (`stop.?loss|sell.?pressure`), so a rugged pool got no cooldown at all. It is now `/rapid dump|volume collapse|liquidity collapse/i`.
- Test: `test:pool-cooldown`.

Why: live data (last 30d) had 45 stop-loss closes on positions that had peaked ≥1% (break-even
armed). 13 of them had break-even close decisions in the logs (one was flagged 11 times) and
still ended at −10.7% on average — the decision was made, but execution waited on the LLM loop
(5m timeout + fallback retry, then a 10m poll cooldown). Close reasons are now the rule's own
text (e.g. `Rule 1: break-even stop`) instead of LLM free text, which also fixes mislabeled
closes (7 of those 45 "stop loss" closes actually ended in profit).

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
- Provider errors returned as a 200 body with no choices (`isTransientProviderError`, agent.js):
  - 502/503/529 are retried up to 3 attempts.
  - `Provider timed out` (or code 408/504) is retried once. Each timeout already costs about 140–175s.
  - Live logs (3 days, 2026-09-29) had 12 timeouts, none retried, which failed 4 management and 2 screening cycles. Direct closes run before the LLM, so only TP_PROPOSAL/CLAIM/INSTRUCTION decisions were lost. Test: `test:llm-retry`.
- **The "fallback model" is not a different model.** It is `screeningModel` / `managementModel`, which is already the model passed in. The old `stepfun` fallback no longer exists.
- **Empty responses:** 180 of 637 LLM calls (28%) came back with no content and no tool call. Each costs one extra call. The log line now includes `finish_reason`, `completion_tokens` and reasoning length. Almost all of them are in screening (see below), so the cause is not the management token cap. Check `finish_reason` in the logs before changing anything.
- **The hourly LLM health check (`healthTask`) was removed on 2026-09-30.** It never ran: management is scheduled `*/10`, fires at minute :00 too and sets `_managementBusy` first. Had it run, it would have blocked management and the 30s poll while the LLM worked, and its output was discarded.
- **Screening-cycle tool list** (`SCREENING_CYCLE_TOOLS`, index.js): `deploy_position` and the three token tools (holders, narrative, info). The call passes `allowedTools` and `requireToolUse: false` to `agentLoop`.
  - Why: the candidate blocks already carry pool memory, smart wallets, active bin and balance. Live logs (3 days) showed `get_pool_memory` called 93× and `check_smart_wallets_on_pool` 21×. Every tool call is another full-conversation LLM round-trip.
  - The goal contains "deploy", so `tool_choice=required` used to be forced on step 1. That made a `NO DEPLOY` answer cost at least 2 calls, and it was sometimes rejected outright.
  - Chat and REPL deploys (also the SCREENER role) keep the full role tools, because they need `get_top_candidates` and `get_active_bin`. Test: `test:llm-calls`.
- **Deploy strategy consistency (2026-09-29):**
  - `deploy_position.strategy` enum is `["curve", "bid_ask"]`. It used to be `["bid_ask", "spot"]`: no `curve`, and the executor always rejects `spot`.
  - The screening goal no longer injects the `strategy-library.json` active entry. That entry is "Custom Ratio Spot", which says LP spot, dual-sided and fixed `bins_above`, all of which contradict the executor and the DEPLOY RULES.
  - Live logs had 836 `SAFETY_BLOCK`s in 30 days (mostly "volatility ≤ curveMaxVolatility → use curve") and 86 repaired-JSON deploys, each one an extra LLM round-trip.
  - The strategy library is still used by the `/strategy` tools in GENERAL chat.
- **Removed the per-candidate TA entry fetch** (`confirmIndicatorPreset` with `skipEnabledCheck: true`) and its `ta_entry` prompt line.
  - It ran for every candidate even with `indicators.enabled=false`, and was advisory prompt text only, never validated.
  - It shared the Jupiter rate limit with auto-swap: 662 indicator 429s in 30 days.
  - The TA exit (`taExitEnabled`, off by default) is unchanged.
- **LPAgent stops after a rejected key** (`tools/dlmm.js` `fetchLpAgentOpenPositions`). A 401/403 disables it until restart.
  - Live: 92,696 `HTTP 401` in 30 days (about 3,000 a day). `.env` has no `LPAGENT_API_KEY`, so the process still carries a stale key, probably from the pm2 environment.
  - Test: `test:llm-calls`.
- **LLM call volume before these changes** (3 days, 2026-09-27..29):
  - Management: 78 runs, 178 steps. Screening: 87 runs, 464 steps (median 4, 16 runs at 8+).
  - System prompt size is not the cost driver: about 3k tokens for SCREENER and 1.3k for MANAGER. Call count is.
  - 179 of the 180 empty responses were in screening (39% of screening steps). So the 2048-token management cap is not the cause.
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

**Live audit (2026-09-29): no bug that affects trading. Most of this system is inert or advisory. Do not re-audit without new data.**
- **`evolveThresholds` has been frozen since 2026-07-05** (position 1275; live `minFeeActiveTvlRatio` 0.09, `minOrganic` 55).
  - With about 250 winners in a 14-day window, the minimum winner fee/TVL sits at the floor, so the raise never fires.
  - Relax requires fewer than 10 positions in the window, so it never fires either.
  - The raise logic is weak anyway: it raises because winners had high fee/TVL, not because low-fee pools lost. The 60-day data shows no fee/TVL bucket underperforming.
  - Left as is on purpose.
- **Manual lessons are never pruned and are prioritized in the SCREENER role slots.**
  - Two May study lessons ("avg hold time of top LPers", "fee_pct_of_capital") headed every screening prompt.
  - `sanitizeLessonText` had stripped their `<`/`>` characters, so "≥10%" read as "= 10%".
  - The user removed them directly from `lessons.json`, with a backup.
  - Do not remove lessons through the chat `clear_lessons` tool: its `performance` mode wipes all closed-position records, which every analysis depends on.
- **Aggregate lesson bucket "100-125" is actually `bin_step > 100`**, so it includes 200+ pools. This resolves itself once pre-`maxBinStep 125` data leaves the 14-day window.
- **The MANAGER prompt receives screening lessons** (aggregates, per-pool PREFER). Low impact: since direct closes, the manager LLM only handles TP proposals, claims and notes.
- **Darwin signal weights are saturated at their caps.** fee_tvl, mcap and volatility sit at 2.5; organic and holder_count at 0.3. The multiplicative 1.05/0.95 step every 5 closes saturates quickly. The weights are prompt text for the screener only, not used in candidate ranking. Their direction matches the 60-day data (organic ≥80 was no better than 70–79).

---

## Swap Safety (tools/executor.js, tools/wallet.js)

Security-audit finding: `swap_token`'s `runSafetyChecks` case previously just returned
`{ pass: true }` with a comment claiming DRY_RUN handling in `swapToken()` itself was
"belt-and-suspenders" — it wasn't. Unlike `deploy_position`, which has hard-coded caps
independent of LLM judgement (`maxDeployAmount`, duplicate-pool/mint guard, bin-range
validation), `swap_token` had **no** cap on `amount` and Jupiter's Swap V2 `/order` request
never set `slippageBps` (full reliance on Jupiter's own default). A manipulated or buggy
tool call (e.g. from a prompt-injected token narrative — see `narrative_untrusted` in
`prompt.js`) could have swapped an unbounded amount of SOL with no slippage floor.

Fixed:
- `runSafetyChecks("swap_token")` now rejects non-positive `amount`, and when `input_mint`
  is SOL (i.e. SOL is leaving the wallet), rejects `amount > config.risk.maxSwapAmount`
  (default 50, mirrors `maxDeployAmount`). Swapping a non-SOL base token back to SOL (the
  auto-swap-after-close path) is **not** capped here — it's already bounded by the actual
  token balance in the wallet, and requiring a cap there would block legitimate full-balance
  cleanup swaps.
- `swapToken()` now sends an explicit `slippageBps` (`config.risk.swapSlippageBps`, default
  500 = 5%) on every Jupiter order request instead of relying on Jupiter's undocumented
  default. If legitimate swaps start failing during high volatility, loosen via
  `update_config swapSlippageBps=<value>`.

**Jupiter 429 retry (`tools/wallet.js` `fetchWithRateLimitRetry`):** the swap order request retries a 429 after 2s, 5s and 10s. Other statuses are not retried.
- Live logs (3 days, 2026-09-27..29): 6 of 98 swaps failed with `429 Too many requests`. All 6 were the first order request of the auto-swap right after a close (CALI $110, e/acc $125, CAKE $88, COLLECT, WORLD), so the base token stayed in the wallet while the LLM reported "auto-swapped".
- The default Jupiter key (`DEFAULT_JUPITER_API_KEY`) is shared by every install. A personal `JUPITER_API_KEY` in `.env` lowers the chance of 429s.
- Test: `test:swap-retry`.

## Secret File Permissions (setup.js, telegram.js, tools/executor.js, lessons.js)

Security-audit finding: `.env` (contains `WALLET_PRIVATE_KEY` and all API keys) and
`user-config.json` (contains `llmApiKey`) were written via plain `fs.writeFileSync` with no
explicit `mode`, landing at the OS default (`0644`, world-readable) — any other local user
on a shared host could read the wallet private key. Fixed: every write to these two files
(`setup.js` initial write ×2, `telegram.js` `saveChatId`, `tools/executor.js`
`update_config`, `lessons.js` `evolveThresholds`) is now followed by
`fs.chmodSync(path, 0o600)` (best-effort, wrapped in try/catch for non-POSIX filesystems).
This only hardens files written by code going forward — if `.env`/`user-config.json` already
exist with looser permissions from before this patch, run `chmod 600 .env user-config.json`
once manually after upgrading.

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
- **Give-back floor**: deferral stops once `dropFromPeak >= peak_pnl_pct / tpVetoFloorDivisor` (default 2 → half the peak) and TRAILING_TP fires immediately; the veto layer then force-closes it (same floor). Previously the deferral had no floor — live data showed break-even closes averaging peak +7.33% → −0.96% (30d, 33 closes, 0 vetos): positions slid from their peak all the way to break-even while deferred.

**Trailing giveback divisor (`trailingGivebackDivisor`, default 3):**
```js
effectiveDrop = max(effTrailingDropFloor, peak_pnl_pct / trailingGivebackDivisor)
```
Higher divisor = tighter stop relative to peak.

---

## Low-Yield Exit Entry Grace (state.js)

`updatePnlAndCheckExits`' `LOW_YIELD` exit (position fees extrapolated to 24h < `minFeePerTvl24h`, after `minAgeBeforeYieldCheck`) runs **before** `getDeterministicCloseRule` in the management cycle, so it used to pre-empt Rule 5 (low yield) — including Rule 5's depth-aware entry grace. A single-sided SOL position earns ~nothing until price trades down into its range, so it was being closed at 60m before its liquidity was ever active. Both now share `isInEntryAccumulation(tracked, positionData, mgmtConfig, fallbackStrategy)` (state.js): grace holds while in range and depth < `curveEntryGraceDepthPct` (50) / `bidAskEntryGraceDepthPct` (80), or until the breach has persisted `entryGraceConfirmMinutes` (15); fail-safe active when bin data is missing; no grace when out of range.

**Grace logging (index.js `logGraceTransition`):**
- A `Rule N skipped … entry grace active` line is written only when a position **enters** a rule's grace, and `Rule N entry grace ended` only when it leaves (Rules 5, 7, 8, 9, 11).
- It used to be written on every 30s poll for every rule and position: about 20–35k identical lines a day, and `logs/` reached 603 MB, enough that reading one day's log in Node ran out of memory.
- `_graceLogged` is pruned against open positions at the end of every management cycle.

**Live config note:** the live `user-config.json` has `bidAskEntryGraceDepthPct: 95` (it has been 95 since grace logging began, 2026-05-29) and a curve grace of 70.
- At 95, Rules 7/8/9/11 and the low-yield exits practically never fire for an in-range bid_ask position.
- It was left as is, because bid_ask is the best-performing strategy at this setting (60d: n=742, 65% win, +514).
- Watch whether bid_ask capital now idles longer, since the low-yield exit shares this grace (commit 0ae1788).

## Early-Dump SL Override (state.js)

Normally `minAgeBeforeStopLoss` (default 15m) suppresses SL in the first 15 minutes to avoid noise. The early-dump override bypasses this gate when the position is clearly dying:

```js
earlyDumpOverride = age < minAgeBeforeStopLoss && currentPnlPct <= earlyDumpOverridePct (-10%)
```

If override fires, the STOP_LOSS reason is tagged `[early-dump override]`.

---

## Market Regime Deployment Throttle (index.js)

When `marketRegime.enabled=true` (default), the screener checks regime before each cycle. Regime is scored 0–5.5 across four signals (price breadth 5m+1h, volume momentum, flow ratio, SOL/USD price momentum):

- **healthy** (score < `cautionScoreThreshold`, default 1.8): normal operation
- **caution** (1.8 ≤ score < `bearishScoreThreshold`, default 3.7): position cap at `cautionMaxPositions` (default 3); screening interval multiplied by `cautionScreeningMult` (default 2×); the fee/TVL floor is raised ×1.4 for the cycle and restored after (applied to the candidate list as well as at deploy); **deploy size scaled by `cautionPositionSizeMult` (default 0.75)** via `computeDeployAmount`
- **bearish** (score ≥ 3.7): screening skipped entirely

The raised fee/TVL floor is stored in `_cautionOrigFeeRatio` before modification and restored in the `finally` block to prevent compounding across cycles. `dropBelowFeeFloor` (tools/screening.js) applies the floor to the candidate list before recon, because the executor enforces it at deploy anyway; missing fee data stays in (fail-open). Test: `test:caution-bar`.

**Maturity bias removed (2026-10-02).** Caution used to also raise `minOrganic` (+10), `minMcap` (×2) and `minTokenAgeHours` (72h; keys `marketRegime.cautionMinTokenAgeHours` / `cautionMinMcapMult`). They never acted: `getTopCandidates` runs at the top of `runScreeningCycle`, before the regime block, and nothing re-applied them to the candidate list. Only fee/TVL ×1.4 worked, and only at deploy (the LLM could be offered a pool the executor then blocked). Not made real, because the data does not support it (`diag-filters.mjs` B, 60 days, 1491 positions, 152 opened in caution): the bar would have removed 25 positions that made +1.10% (+$8, stop loss 4%, 90% interval −$21..+$33, negative in 30% of resamples), the 127 that stay made +1.19%, and positions opened in healthy made +0.45% (n=1337). So caution deploys were not worse, and the removed ones were not losers. Token age is not recorded per position, so the 72h part could not be tested. The code, the two config keys and their `update_config` mapping were removed. The fee/TVL ×1.4 floor stays.

The assessed regime is also written to runtime `config.marketRegime._activeRegime` (set right after `assessMarketRegime`, or forced to `"healthy"` when `marketRegime.enabled=false`). This is the **only** channel `computeDeployAmount` (config.js) and the deploy guard (executor.js) use to apply caution size modulation — they don't import `_lastRegime`. `deployAmount` is computed **after** the regime block in `runScreeningCycle` so the current cycle's regime modulates size; the executor guard reads the same value, keeping prompt and guard consistent (15% tolerance absorbs position-value drift).

**Live message safety:** the screener no longer opens a live message; its report is a plain `sendMessage` sent only when a deploy was attempted or the cycle failed. The management cycle still opens one, but only once it has actions to execute, and always finalizes it in `finally`. Any new live message must be finalized on every path. An unfinalized one leaves `_liveMessageDepth > 0`, which permanently suppresses all Telegram notifications (`notifyClose`, `notifyDeploy`, etc.) until process restart. All early returns inside the screener `try` block should still assign `screenReport` before returning.

**Regime protection on EXISTING positions (not just new deploys):** previously regime only gated entry (skip screening on bearish, shrink new deploy size on caution) — a position opened during a healthy market kept its original SL/trailing tolerance even if the market turned caution/bearish while it was still open. Four things now also react to `config.marketRegime._activeRegime`:
- **SL tightening** (`state.js` `effectiveStopLossPct`): the per-position `sl_pct_override` **and** the `stopLossTightestPct` clamp are both scaled by `marketRegimeCautionSlMult` (0.85) / `marketRegimeBearishSlMult` (0.7) — a mid-vol-tier `-12%` SL becomes `-10.2%` in caution, `-8.4%` in bearish. Scaling the clamp too matters for the low-vol tier (`-8%`, equal to the default tightest bound): scaling `raw` alone would have no effect there (`-8×0.7=-5.6` is less negative than the unscaled `-8` clamp and would get pulled straight back to it) — this was the most common overshoot tier in observed data (CATWIF, reptilecoin, febu).
- **Faster profit-taking** (`state.js` `updatePnlAndCheckExits`, trailing TP give-back): `effectiveDrop` is scaled by `marketRegimeCautionTrailMult` (0.8) / `marketRegimeBearishTrailMult` (0.6) before stale-peak widening, locking in gains sooner.
- **SOL momentum signal** (`market-regime.js` Signal 4): self-samples `solPriceUsd` (already fetched each cycle, no extra API call) into a small in-memory ring buffer and scores a SOL-denominated dump (≥30m/60m windows) — almost every LP here is SOL-quoted, so a broad SOL move is systemic risk the token-breadth signals don't directly see. Raised the bearish/caution thresholds from the pre-signal 3.0/1.5 to 3.7/1.8 to absorb this signal's +1.0 max headroom (max score now 5.5).
- **Rule 10 — trim-to-cap** (`index.js` `runManagementCycle`): when caution/bearish and open positions exceed `cautionMaxPositions` after other rules run, the single weakest-PnL still-open position is closed this cycle (rate-limited to 1/cycle to avoid dumping several at once — re-evaluated next cycle if still over cap). **Only on a confirmed regime** (since 2026-09-30).
  - Confirmed means this assessment AND the previous one are caution/bearish (`isRegimeConfirmed` in market-regime.js, stored as runtime `config.marketRegime._regimeConfirmed` in the screening cycle).
  - "unknown" (assessment error) never confirms. Before this, it counted as non-healthy.
  - SL/trailing tightening, the caution deploy cap, size and the bearish skip still use the raw regime.
  - Test: `test:regime-risk` [6].

Both `effectiveStopLossPct` and `updatePnlAndCheckExits` take `regime` as an optional trailing parameter (default `"healthy"`) so any caller that doesn't pass it is unaffected — the three real call sites in `index.js` (management cycle, 30s PnL poll, `/simulate` debug command) all pass `config.marketRegime?._activeRegime ?? "healthy"`.

---

## Rule 11 — Liquidity Collapse (index.js `getDeterministicCloseRule`)

Sibling of Rule 7 (volume collapse), gated by `config.emergencyExits.liquidityCollapse.enabled` (default true). Targets a different failure mode: a token whose price-based signals (auto-SL, Rule 9) can't react fast enough because the dump is a genuine rug — liquidity pulled directly from the pool, sometimes with almost no swap activity at all (e.g. e/acc-SOL closed at -26.95% via Rule 1, ~19 points past its auto-SL tier — a violent dump no threshold recalibration alone would have caught).

Unlike Rule 7, Rule 11 does **not** require sell-pressure confirmation (`sells > buys × ratio`): a direct LP removal doesn't need to show up as swap activity, so requiring buys/sells would blind the rule to exactly the fastest, most dangerous rugs. A sharp drop in `liquidity_usd` from its recent peak is sufficient on its own.

- Tracks `peak_liquidity_usd` and a 5-entry `liquidity_history` per position (`state.js` `batchUpdateMarketData`, mirroring the existing `peak_volume_5m_usd`/`volume_history` — same rolling-window-over-all-time-peak preference to avoid pinning to a stale early spike).
- Fires when `liquidity_usd < minPeakLiquidityUsd`-qualified peak `× dropThresholdPct/100` (default 40%), position age ≥ `minPositionAgeMin` (default 5 — shorter than `volumeCollapse`'s 10, since LP pulls can happen fast), and peak liquidity was ≥ `minPeakLiquidityUsd` (default $1000, avoids noise on dust pools).
- Same skip conditions as Rule 7/8/9: OOR ABOVE (idle SOL, no capital at risk), in-range AND PnL ≥ 0 (still earning), and the depth-aware entry-accumulation grace zone.
- Only updated by the management cycle's `batchUpdateMarketData` (every `managementIntervalMin`, default 10m) — the 30s poll path doesn't call it, so `peak_liquidity_usd` can be up to one management cycle stale there. Same existing staleness as Rule 7's volume peak in the poll path, not a regression.
- Not added to `update_config`'s `CONFIG_MAP` — consistent with its siblings `volumeCollapse`/`rapidPriceDrop`/`sellPressureStreak`, which are also tuned via `user-config.json` + restart, not runtime `update_config`.

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

**Shared lessons are not injected into the LLM prompt by default.**
- `getSharedLessonsForPrompt` returns null unless `user-config.json` has `hiveMindLessonsInPrompt: true`.
- Registration, heartbeat, the lesson/preset pull into `hivemind-cache.json`, and performance push still run.
- Why: the live cache (2026-09-29) held 12 lessons that were all test data (`TEST-SOL … Reason: test close`, `Tok3-SOL`, `undefined` fields). They appeared in the prompt next to the bot's own lessons with no untrusted label, and the text is unvetted input from an external server (prompt-injection surface).
- The key is deliberately not in `update_config`'s `CONFIG_MAP`, so the LLM cannot re-enable it. Test: `test:hivemind-prompt`.

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
- **Keep `maxBinStep` at 125; do not raise it back to 200 without new data.** Live `user-config.json` had `maxBinStep: 200`, and on 2026-09-29 the user set it back to 125 with `/setcfg maxBinStep 125`.
  - 60-day data (1456 positions): the bin_step ≥ 200 group (n=63) was the only net-negative bin_step group. Rug rate (PnL ≤ −25%) was 3.2%, versus 0–0.2% in every other group, and sum PnL was −57. Excluding its rugs it made only +42.
  - AMERICA-SOL (bid_ask, bin_step 200) fell more than 59% through its whole range in under 15s and realized −63% (1.77 → 0.65 SOL).
  - Its entry metrics looked clean: age 90h, mcap $1.6M, top10 15%, no rugpull/wash flag. No exit rule could react inside one 30s poll.
  - The executor deploy guard enforces the cap on every deploy, and `evolveThresholds` never changes it. Re-check by grouping `lessons.json` performance by bin_step after about 4 weeks.
- **Live `maxPositionAgeMinutes` raised from 240 to 600 on 2026-09-29** (user edited `user-config.json`; backup at `user-config.json.bak-maxage`). With the default 3 × 45m grace, the hard ceiling moves from 375m (about 6.25h) to 735m (about 12.25h). The key is not in `CONFIG_MAP`, so change it by editing the file and restarting.
  - Evidence, 60 days, 1456 positions. Median hold of max-age closes was 6.3h, meaning nearly all of them hit the hard ceiling while still earning. Only 4 of 246 closed as "no longer earning". The rest earned a median 0.67–0.75% of capital per hour at close, with an 85–87% win rate.
  - By hold time: positions closed within 6h made −$623 in total, mostly stop losses. Positions held 6–12h made +$1064, with only 4 stop losses. Closing a proven position to open a new one trades it for the loss-prone first 6h.
  - Risk: there was no data past about 6.3h before this change.
  - Re-check on 2026-10-16 with `diag-explore2.mjs`. Look at PnL/fee in the 6–12h and 12h+ buckets, any stop losses past 6h, and whether "no longer earning" closes appear.
  - Revert: `cp user-config.json.bak-maxage user-config.json` and restart.
- **Other checks from the same exploration (2026-09-29), no action taken:**
  - "Insufficient SOL" screening skips were 50% of cycles over 92 days, but only 17 in the last 14 days. The historical count predates fair-share sizing.
  - The binding slot limit is now the caution cap, about 15 skips a day. Performance records don't store the regime at deploy, so the cap's value is unproven.
  - Repeat deploys into the same pool did fine, including after a loss. A 6th+ deploy was the best group.
  - Positions in the largest size quartile were weakest even within the same week. This is mostly driven by AMERICA; watch it.
  - Low-yield closes at 1–3h (n=437) were small net positives.
  - `TP_PROPOSAL` appeared 0 times in 92 days of logs, so the manager LLM makes almost no decisions.
  - Deploy hour and weekday showed no consistent loss pattern. The only `!!` block, 20–21 WIB, is explained by a single position, AMERICA (deployed 20:41 WIB). Don't add time-based rules without new evidence.
- **In-range trailing TP never closed a position. Fixed 2026-09-30.**
  - What was wrong:
    - `updatePnlAndCheckExits` returns `TRAILING_TP` for an in-range position when the give-back floor (half the peak) is hit or the 90m in-range grace expires.
    - Every trailing exit goes through the 30s recheck (`scheduleTrailingDropConfirmation`).
    - The confirmed exit was then cancelled by the `confirmed_trailing_exit_until` block because the position was in range, which is exactly the condition that triggered it.
    - Live logs showed 85 "Trailing TP confirmed exit cancelled … back in range" lines. This is also why `TP_PROPOSAL` never fired.
  - Fix: exits from the in-range branches carry `in_range_exit: true`.
    - The tag goes through `queueTrailingDropConfirmation` (5th arg, `pending_trailing_in_range`) and `resolvePendingTrailingDrop` (`confirmed_trailing_exit_in_range`).
    - The "back in range" cancellation now applies only to OOR-triggered exits.
    - The 5m-price-recovering cancel in the recheck is unchanged.
  - What happens next: a confirmed in-range exit enters the TP veto layer as before. A floor hit is force-closed. A grace expiry below the floor becomes a `TP_PROPOSAL` for the manager LLM, with the veto budget.
  - Expected (60-day backtest, positions with peak ≥5%):
    - 64 break-even closes: peak 7.3% → −0.90% (−$50).
    - 17 stop losses: peak 7.1% → −0.48%.
    - The floor would have closed them around +3.5%, roughly +$250–300 over 60 days.
  - Risk: in-range dips that later recover (max-age closes: peak 10.1% → 8.7%) may now be cut earlier.
  - Test: `test:trailing-floor` [5].
  - Re-check at the 2026-10-16 evaluation:
    - count closes with "give-back floor" / "in-range grace expired";
    - check that "confirmed exit cancelled … back in range" now only follows OOR exits;
    - compare break-even and max-age PnL.
- **Partial close is live since the in-range trailing fix. Observed 2026-10-01, not changed.**
  - The first partial ever: JACK-SOL, 50% at peak 5.6%. The live `user-config.json` must have `partialExit.enabled: true`, since the code default is false.
  - Flow: a `TRAILING_TP` above the half-peak floor with veto budget left becomes a `TP_PROPOSAL`. The manager LLM is offered `partial_close_position` when peak ≥ `minPeakPct` (4) and the remainder stays ≥ `minRemainderUsd` ($15). The prompt nudges toward a ~50% partial when the signal is mixed. The pct is clamped to 25–75%. `markPartialExit` resets the veto budget and sets `trailing_drop_override` to `stage2TrailingDropPct` (0.8).
  - The "locked $X" in the notification is the pre-partial value × pct at the current price, not at peak.
  - **The tightened trailing stop is mostly a no-op.** `effectiveDrop = max(dropFloor, peak/3)`, so 0.8 only bites when peak < 4.5%, and partials require peak ≥ 4%. JACK: 1.87% before and after. The real protection for the runner is the half-peak floor (force close).
  - **The trailing trigger likely re-fires next cycle.** Peak and drop are unchanged by the partial and the veto budget was reset, so another `TP_PROPOSAL` follows. The LLM can scale out again (50% of the remainder) until the remainder is under $15, so a partial may turn into a 50% → 25% → … ladder instead of one scale-out plus a runner. Not yet seen in logs.
  - Check at the 2026-10-16 evaluation:
    - follow JACK in the logs (`Trailing TP`, `partial exit #`, its final close);
    - count repeated partials per position;
    - compare final PnL of partially closed positions (`partial_taken_count` > 0 in `lessons.json`) with full trailing closes at similar peaks.
  - Possible fixes, only if the data shows harm: allow one partial per position, or measure the runner's trailing from a fresh peak after the partial.
- **Price path vs strategy, impulse entries and OOR-below exits: explored 2026-10-02, no change.**
  - Tools: `diag-ohlcv.mjs` (GeckoTerminal 5m candles in SOL, cached per position in `ohlcv-cache/`), `diag-impulse.mjs`, `diag-oor.mjs`, `diag-oor2.mjs`. 30 days, 657 curve/bid_ask positions with full candles, total about +$282.
  - A price path chained from the logged DexScreener `price5m` does not work: positions whose price fell more than 20% still had a median PnL near 0%. Use the real candles.
  - **Where the money goes.** Positions earn when price falls into the range and lose when it falls through the bottom.
    - Curve is best at 25–50% of the range used (+2.71%). Bid_ask is best at 50–100% (+3.4% to +3.8%).
    - Falling through the whole range (≥100%): curve −6.60% (n=28), bid_ask −2.86% (n=56), together −$424. Curve at 75–100%: −2.58% (n=32). Everything else nets about +$790.
  - **Entry grace is not too loose.** Curve at 50–75% depth still earns +1.08%, so lowering the 70% curve grace would cut winners. Bid_ask at 75–100% earns +3.4%, which fits the 95 grace. Don't lower either.
  - **Impulse filter rejected.**
    - After a 1h rise ≥10.6% the 6h path is "keeps falling" in 48% of entries vs 35–39% (weak, about 2 SE), but PnL is not worse. Bid_ask after a 15m rise ≥20% made +3.66% (n=28).
    - No filter bucket reached the 95% bar. The closest, 1h ≥40%, is n=30, −$44, 80% of resamples negative, one of about 35 buckets tested. Best case +$44 per 30 days.
    - `maxPump1hPct` stays 80. Re-check with more data at the 2026-10-16 evaluation only if wanted.
  - **OOR-below exit: no change.**
    - 84 positions (13%) crossed the range bottom. All of their net loss is stop loss (n=30, −$473, closed a median 6 minutes after crossing). The other 54 net +$48, and 62% of all 84 closed back above the bottom.
    - Simulation of the real Rule 4 shape, "close after X continuous minutes below the bottom": X=10 +$19, X=15 +$11, X=30 −$2 (75% / 64% / 28% positive). Only 7 of 84 stay below for 15 minutes or more, and X=5 would hurt (−$564).
    - Zero Rule 4 OOR-below closes and zero `Rule 4 OOR below deferred` log lines in the window, so Rule 4 below practically never matters. Don't touch `outOfRangeWaitMinutes` or the buy-pressure deferral.
    - An earlier simulation ("exit X minutes after first touching the bottom", +$324 to +$426 at 98–99% positive) was biased. It did not require price to still be below the bottom. Keep that condition in any exit simulation.
  - **Hypothesis only, not acted on.** After a falling coin, curve does worse than bid_ask: 6h price <0 gives −0.36% (n=137) vs +1.19% (n=142), and more than 40% below the 24h high gives −0.28% vs +1.33%. About 2 SE, and confounded because `curveMaxVolatility` picks the strategy.
  - **SI-SOL (2026-10-01, −12.99%, stop loss −14.14% vs −12%) is not a bug.** The first poll after the dump already read −14.14%. A 5m candle with a low ≤ −10% below the previous close occurs in 34% of curve and 66% of bid_ask positions (partly wicks), so a jump of 2 points or more between two 30s polls is normal. No rule inside a poll window can catch it.
  - Price after close (6h, no random-time baseline): after max-age and OOR exits the token kept falling (bid_ask median −10% and −14%), so no sign of exits being too early. After break-even and trailing exits bid_ask rose (+9% and +30%), but n=18 and 9.
  - **Code audit against these findings (2026-10-02): consistent.**
    - Grace: `updateR9GraceZone` runs each management cycle. Grace depth is measured from `upper_bin`, so it includes the 5 bins above; 70% ≈ 67% of the range below entry.
    - Rule 4 OOR-below is correct code; the condition (≥30 continuous minutes below the bottom) is just rare.
    - Stop loss is checked before trailing and is never deferred in range.
    - The executor forces curve at low volatility. `maxBinsBelow` stays 69.
  - **Known quirk, not fixed: trailing-recheck "Price recovering" cancel leaves the pending state set.**
    - `scheduleTrailingDropConfirmation` (index.js) returns on DexScreener `price_change_5m > 0` without clearing `pending_trailing_*`. Only `resolvePendingTrailingDrop` clears it.
    - So the next recheck is queued only when PnL makes a new low below the pending value. Meanwhile the poll skips the deterministic rules for that position (stop loss still runs).
    - Live since 09-30: 2 cancels, both on one position (peak 6.15%). It re-queued at 2.82% and closed at 2.79%, 16 minutes and 0.06 points after the first cancel.
    - Fix if it ever matters: call `resolvePendingTrailingDrop(positionAddress, null, …)` in the cancel branch. Count `Price recovering` lines at the 2026-10-16 evaluation.
  - **Prompt text not backed by this data, left as is** (advisory only; strategy is enforced by the executor's volatility guard):
    - prompt.js calls curve "lowest bag-holding risk", but curve lost more when price kept falling.
    - MARKUP is called the "ideal entry zone", but PnL after impulses was neutral.
    - The strategy characteristics block shows only the default strategy (`bid_ask`), while about 43% of deploys are curve.
- **Screener evaluation (2026-10-02, `diag-screener.mjs`, 7 days, 376 cycles) and combination analysis (`diag-combo.mjs`, 60 days, 1478 positions). One text fix, no parameter change.** Test: `test:deploy-prompt`.
  - **The `deploy_position` tool description contradicted the executor.** It said "Never use 'curve'" and "bid_ask or spot". The executor forces curve at volatility ≤ `curveMaxVolatility` and rejects spot. 61 of 85 `SAFETY_BLOCK`s in 7 days came from this (42 curve-required, 19 spot), each costing an LLM round-trip. The description now states the volatility rule, the bullish-cluster exception and "never spot". The parameter schema is unchanged.
  - **Wide deploys (>69 bins) fail far more often.** Success 73% (n=114) vs 98% (n=84) standard; 70–75 bins 83%, 76–80 bins 70%, 81–90 bins 66%. 33 failures in 7 days: 15 `block height exceeded`, 17 `Simulation failed`. Wide positions did not do worse (−0.23%, n=80, vs −0.54%, n=80), so the cost is lost deploys, not quality. The orphan cleanup (with retry) handles the leftovers. Don't narrow the range: 50–100% of the range used was the best bucket.
  - **No simulation-log change was made.** web3.js 1.98.4 already puts `Message:` and the last 10 program log lines in the `Simulation failed.` error text, so they sit on the lines after it in `agent-*.log`. Read those lines (the `DEPLOY_ERROR` entry spans about 15 lines) before adding anything.
  - **LLM load:** 316 empty responses and 37 provider errors in 376 cycles; 53 cycles (14%) took 8+ steps (median 4). The per-step empty rate was not computed. Re-run after the text fix.
  - **Hard filters are not the problem.** `Risk` dropped 300 candidates from only 5 pools and `Bot-holder` 189 from 5 pools (the same pools every cycle; log noise only). `Entry flow` dropped 53 unique pools; its effect can't be tested because dropped pools have no outcome. Skipped cycles (caution cap 120, max positions 81) cost no LLM call.
  - **7-day result:** −$132 over 160 closed positions, all from stop loss (n=16, −$353, avg −13.46%, held a median 1.6h). Without them +$221. The stop-loss share (10%) matches the 60-day baseline (9%); the average is deeper than −9.9%. That window mixes pre- and post-fix data; judge it on 2026-10-16.
  - **Combinations: nothing to act on.** 278 two-feature cells, discovered on the oldest two thirds and checked on the newest third.
    - PnL: train→test correlation r=0.17. The 20 best cells went from +1.18 to +0.27 over the baseline, the worst from −1.37 to −0.13. The best cell (`fee_tvl >0.85 & organic 74–81`) went from +2.46% to +0.73% against a +0.51% baseline. The depth-3 tree's leaf order did not hold in the test.
    - `ukuran ≤76` appeared in 5 of the 6 best cells, but it only marks the older period: fair-share sizing made later positions larger (test n=14–26).
    - Stop-loss rate: r=0.35. Curve stays above bid_ask in both periods (about 17% → 10% vs 3.5% → 5%), but curve is also the low-volatility choice and its PnL is not worse. Not a filter.
    - **Label caveat:** since direct closes (09-29) a break-even exit is labelled `Rule 1: break-even stop` instead of the LLM's free text "stop loss". The stop-loss rate fell from 10.4% to 7.3% between the two periods, partly from this relabelling. Any stop-loss comparison across 09-29 is biased.
    - Re-run `diag-combo.mjs` on 2026-10-16 with the split near 09-30. `price_vs_ath_pct`, `flow_consensus` and the buy/sell counts should be filled by then.
- **Fee/TVL-first selection (2026-10-02, `diag-feetvl.mjs`, `diag-activation.mjs`, `diag-tf.mjs`).** Tests: `test:candidate-order`, `test:deploy-prompt`.
  - **Data (60 days, 1481 positions).** The top fee_tvl quintile (median 2.52) beat the rest by +1.03 points of PnL (bootstrap 90% +0.32..+1.63, 100% of resamples positive), with a lower stop-loss rate (6% vs 9–11%). Top 10%: +1.23% vs +0.47%. The effect is a step at the top, not linear: PnL by quintile +0.22, +0.27, +0.17, +0.70, +1.37, so the lower groups still earn. Net of price movement, about 60% of the extra fee is kept (fee 2.1% → 5.1%, price+IL −1.9 → −3.7).
  - **Weak and fading, mostly bid_ask.** By thirds of time: +1.99, +0.83, +0.59 (the last two include 0). bid_ask +1.01 (n=244, 100% positive), curve +0.96 (n=53, 81%). Entry fee_tvl predicts the fee earned per active hour only weakly: Spearman 0.15 overall, 0.44 bid_ask, 0.27 curve. The value is the screening timeframe's (default 5m), so spikes count.
  - **Time to first fee is not the problem.** Of 629 positions, 94% touched the first bin below entry, median 0 minutes (p75 4m; 79% within 10 minutes). Only 6% never did and 15 took over an hour. Speed of activation did not predict PnL. What separates fee totals is how far price travels into the range: the share reaching 25% of the range rose from 49% to 68% across fee_tvl terciles. Curve earns about 4× the fee per active hour (1.09 vs 0.28) but the same total (3.4% vs 3.5%) with lower PnL (+0.16% vs +0.91%) and more stop losses (13% vs 5%). Momentum before entry showed no pattern. "Active" means a 5m candle low reached one bin step below entry, not that meaningful volume crossed it.
  - **Change: prompt only.** `prompt.js` gets `CANDIDATE ORDER`. Overlapping rules were reconciled in the same edit: "pick the highest-conviction candidate" became "choose by CANDIDATE ORDER"; narrative is "a skip signal and tie-break, not the ranking key" (the existing "no narrative + no smart wallets → skip" stays); the Darwin weights line now says tie-break only; the goal's STEP 2 ("best candidate based on narrative quality, smart wallets, and pool metrics") points at CANDIDATE ORDER and WHY THIS WON starts with the rank. STEP 1 ("is anything worth deploying") and the RISK SIGNALS are unchanged. No ranking code, filter or threshold changed.
  - **Not done on purpose.** No deterministic "take #1" and no higher `minFeeActiveTvlRatio`: the lower groups still earn, the recent effect is weak, and the LLM still catches bad tokens the numbers don't show.
  - **Recorded, not used (in `signal_snapshot` and the `lessons.json` record):** `candidate_rank`, `candidate_count`, `top_fee_tvl` (fee_tvl of #1 in that cycle), `tvl`, `fee_tvl_24h` (one extra `getPoolDetail(timeframe "24h")` per candidate, fail-open). Two log lines per screening: `Candidates (best first): #1 NAME fee_tvl=… | #2 …` and `Screener pick: NAME rank #k of n`. Not Darwin weights.
  - **Check at the 2026-10-16 evaluation.** How often the pick is #1; PnL of picks at #1 vs lower ranks; whether `fee_tvl_24h` ranks outcomes better than the 5m value (Spearman against fee earned per hour, top-quintile PnL); PnL by `tvl` bucket. If the pick is rarely #1 even without a skip signal, tighten the wording or take the pick out of the LLM's hands. If the top-quintile effect is gone, drop `CANDIDATE ORDER`.
  - **Live config differs from the defaults in this file** (seen 2026-10-02): `maxTvl` 300000, `minBinStep` 20, `minVolume` 1500, `maxMcap` 20M, `minFeeActiveTvlRatio` 0.09. With `maxTvl` 300k, raising it to 1M adds 0 pools (12 candidates both ways, highest TVL $161k), so TVL is not what limits the list. `initial_fee_tvl_24h` in state.js holds the screening-timeframe ratio, not a 24h one; the real 24h value is `fee_tvl_24h` above.
- **Screener filter relevance (2026-10-02, `diag-filters.mjs`, 60 days, 1491 curve/bid_ask positions, avg +0.51%, stop loss 9%).** Only the caution bar changed (above); everything else is unchanged. Test: `test:caution-bar`.
  - **Which filters select winners.** Only fee/TVL does: +0.34% (0.09–0.13, n=83), +0.15% (0.13–0.3, n=370), +0.35% (0.3–0.85), +0.82% (0.85–2), +1.30% (≥2, n=209, stop loss 6%; both halves positive, +1.92 / +0.91). The lowest band still earns, so there is no case for raising the floor. Exit link: the ≥2 band exits by trailing/break-even 17% and low yield 21%, the lower bands by trailing/break-even 1–5% and low yield 31–35%. High 5m fee/TVL reaches profit-taking, low fee/TVL ends in Rule 5.
  - **The rest are hard bounds or hygiene, not selectors.**
    - Organic is hump-shaped: 60–65 −0.10% (n=83), 65–70 +0.86%, 70–80 +0.84% (n=689), ≥80 +0.13% (n=545, both halves ≤0.23, stop loss 11%, OOR 25%). About 1.6 SE, no action.
    - Mcap has no monotonic relation: <400k +1.00% (n=82), 400k–1M +0.84%, 1–3M +0.06% (n=452, stop loss 12%), 3–10M +0.73%, ≥10M +0.73% (n=121, OOR 33%). Small caps are not worse.
    - Holders: ≥5000 +0.29% (n=783) vs 2000–5000 +0.88% (n=499), same sign in both halves, about 1.5 SE. Below 1000 there are only 19 positions, so `minHolders` 500 does not bind.
  - **Volatility has no filter and none is wanted.** Every band is positive (+0.24% to +0.80%). Dropping vol <2 would have cost $78 (90% −$45..+$258; the dropped group was positive in 84% of resamples) and vol <3 $173 (91%). The 30-day tercile that looked weakest (vol ≤2.55, −0.09%) did not hold over 60 days. **Exit-calibration note, not acted on:** vol 1.5–2.0 has a stop-loss rate of 23% (n=170; halves +0.77% / −0.80%) against 11% at ≤1.5 and at 2.0–2.5. That band sits at the top of the −8% low-vol auto-SL tier (the 2–4 tier is −12%). Revisit with the other stop-loss checks on 2026-10-16.
  - **bin_step and range width.** <50: +0.29% (n=88, OOR 41%); 50–80: −0.25% (n=102, stop loss 17%; curve alone −0.57%, stop loss 21%, n=82); 80–100: +1.15% (n=249); 100–126: +0.55% (n=968); >125: −0.85% (n=66, pre-`maxBinStep` 125 data, both halves negative). Range cover to the bottom: 15–30% −0.33% (n=130, stop loss 19%). Pools below 80 (live `minBinStep` is 20, the default 80) average about 0.0% against +0.67% for 80–125, a gap of about 1 SE. Not acted on; re-check on 2026-10-16.
  - **Flow at entry (59 positions since 09-30, too few).** EXHAUSTION −3.69% (n=12, stop loss 25%), CAPITULATION −2.53% (n=6), BULLISH_MIXED −1.16% (n=8), MARKUP +0.27% (n=14), BEARISH_MIXED +1.49% (n=9), MIXED +3.08% (n=8). Only DISTRIBUTION is filtered. Add EXHAUSTION/CAPITULATION to `entryFlowBlockRegimes` only if each label holds up at 40+ positions on 2026-10-16.
  - **Code-level fit with the strategy and exits (no data needed).**
    - Rug hygiene (top10, bots, bundle, token fees, rugpull, wash) is the only layer for fast rugs: no exit can react inside a 30s poll, and Rule 11 runs every 10 minutes. Their inputs are not stored per position, so they cannot be evaluated. Recording them (and token age, `active_pct`, `unique_traders`, regime at deploy) is the open option.
    - `minFeePerBinStep` 0.0007 is inert at the live config: at bin_step 125 it needs fee/TVL ≥0.0875, below the live floor of 0.09. The deploy guard (bid_ask, bin_step ≥100, fee/bin_step <0.001 → curve) only bites for fee/TVL 0.09–0.10 (bin 100) or 0.09–0.125 (bin 125).
    - Entry flow DISTRIBUTION is the busiest filter (269 events, 53 pools in 7 days) while hold-time DISTRIBUTION did no harm (bid_ask +0.85% vs −1.09%, `diag-flowhold.mjs`). The windows differ (5m/1h/6h consensus vs 5m), so this is not a direct contradiction, and dropped pools have no outcome to test. Decide with `flow_consensus` data on 2026-10-16.
    - The 5m pump guard in `runSafetyChecks` (deploy_position, >8%) reads `config.strategy.strategy` (default bid_ask), not the strategy the LLM picked, so it also applies to curve. It did not appear among the top safety blocks in 7 days.
    - Rugpull, bundle and token-age checks run twice (discovery and `passing`); harmless duplication.
- **Exit data freshness: checked 2026-09-29, no change needed.**
  - Position PnL, bins and in-range state are force-fetched on every 30s poll and again by the management cycle it triggers. DexScreener data is cached for 60s. Live volatility refreshes each cycle.
  - Decision-to-realized gap (`diag-exit-gap.mjs`, 30 days): regime trim n=9, median +0.01%, worst −0.27%. The stop losses matched their decision PnL, apart from AMERICA (−59% → −68%, a rug that crossed the whole range in about 15s).
  - Only 12 of 797 close reasons carried a decision PnL. Older ones are LLM free text, and break-even, max age, OOR and low yield don't print one.
  - Re-check with more data on 2026-10-16. Don't add pre-close refetches, on-chain PnL checks or a priority fee for freshness without new evidence.
  - The stop-loss reason now prints a rounded threshold (`Number(effSL.toFixed(2))`). Regime scaling used to produce labels like `<= -8.399999999999999%`. Test: `test:trailing-floor`.
- **Loss streaks: checked 2026-09-30, no loss-streak pause added.**
  - Tool: `diag-streak.mjs`, 60 days, 1456 positions. Each deploy is judged only by the closes the bot already knew about at deploy time.
  - Closes do cluster: P(loss | previous close lost) is 41% vs 30% after a win. But that is parallel positions hit by the same market move, not a signal for the next deploy.
  - Deploys made after ≥2 or ≥3 consecutive losses lost at the base rate (32–34% vs 34%). Shuffle-test p = 0.93 and 0.69.
  - The regime-controlled split showed nothing either (healthy: 2+ streak −$0.03 per position vs +$0.34, n=163, not significant).
  - Simulated "pause H hours after K losses": the best case was +$7 over 60 days (K=2, 2h). K=3 would have thrown away $48–55 of profit.
  - The longest run was 14 losses on 2026-08-30 (−$45 over 10h).
  - Lever for correlated losses: exposure while positions are open, which is already covered (regime-tightened SL/trailing, caution size and cap), not a deploy pause. Re-run `diag-streak.mjs` at the 2026-10-16 evaluation.
- **Regime check audit (2026-09-30, `diag-regime.mjs` / `diag-regime2.mjs`, 60 days, 2981 assessments). Scoring and thresholds were NOT changed.**
  - Distribution: healthy 69%, caution 30%, bearish 1%. Median gap between assessments 15m.
  - **Reactive, not predictive.**
    - Caution was already on in the 2h before the first loss of a loss cluster in only 13/29 clusters, against a 29% base rate. It was on during the cluster in 25/29.
    - The regime score at deploy did not predict outcomes. Caution deploys did as well as or better than healthy ones.
    - SOL30m during clusters was only −0.2% to −1.9%, so the losses were memecoin-specific. The SOL signal fired in 1% of assessments.
  - **Stale.**
    - With positions open, the regime was more than 30m old 31% of the time and more than 60m old 15% of the time.
    - It is only assessed in screening, after the max-positions and SOL-short early returns (1241 skips).
    - 12/29 clusters started with a regime more than 60m old. Refreshing in management was not done: it would add blips, and the regime doesn't lead.
  - **Blips.**
    - 527 of 1161 regime changes lasted a single assessment. 363 were a caution blip inside healthy (median score 2.0), 162 a healthy blip inside caution.
    - Global smoothing was rejected on simulation:
      - "Exit caution after 2 healthy" raised caution time from 31% to 47% for 26/29 vs 24/29 clusters.
      - "Switch after 2 equal assessments, ≥2.5 immediate" dropped cluster coverage to 14/29.
  - **Rule 10 fired on blips.** 67 of 104 trims happened during a one-assessment caution blip (55 matched: avg −0.65%, −$33). All trims were 4 open > cap 3. Hence the confirmed-regime gate above. Expected effect: about one needless close fewer per day. PnL at stake is small.
  - Re-check at the 2026-10-16 evaluation. Count Rule 10 trims (should drop about 60%) and re-run both scripts.
- **Flow re-check on held positions: tested 2026-09-30, rejected. Don't add a hold-time flow exit without new evidence.**
  - Tool: `diag-flowhold.mjs`, 30 days, 777 positions, 89k DexScreener 5m samples from the `DexScreener OK` log lines. The log has only 5m price/volume, so 1h was approximated and 6h was unavailable.
  - A confirmed 5m DISTRIBUTION (price5m < −0.5%, vol5m > 1.1× the prior-hour median, twice within 15m) fired in 624 of 777 positions (80%). It is normal memecoin noise.
  - Positions with the signal did no worse. For bid_ask they did better: +0.85% vs −1.09%, since a dump into the range is where bid_ask earns.
  - After the signal, the token rose again in 280 of 608 cases. Exiting at the signal would have cut max-age (+$509) and OOR (+$252) winners.
  - Adding the 1h-down filter (S2) changed nothing.
- **Distance to ATH and entry flow/transactions are recorded, not filtered (since 2026-09-30).**
  - What it is: `price_vs_ath_pct` (OKX price as % of ATH, `tools/okx.js`), staged with the other screening signals (`stageSignals`, index.js). It lands in each position's `signal_snapshot` and in the `lessons.json` performance record at close.
  - Record-only. It is not a Darwin weight (not in `SIGNAL_NAMES`), and `athFilterPct` stays off (default null).
  - Staging runs only while `darwin.enabled` (default true), like every other snapshot field. Null when OKX had no data. Test: `test:signal-snapshot`.
  - Evaluate after about 2–3 weeks (300+ closes): group PnL by `signal_snapshot.price_vs_ath_pct` bucket and strategy. Turn on `athFilterPct` only if a bucket is clearly net-negative.
  - Also recorded: `flow_consensus` (the 5m/1h/6h flow label the screener shows), `txn_buys_5m`/`txn_sells_5m` (DexScreener) and `net_buyers_1h` (Jupiter).
  - Use them the same way: keep or drop a flow/transaction filter or prompt line only if its buckets actually separate winners from losers. The aim is to simplify, not to add rules.
- **Win rate / avg audit (2026-09-30, `diag-edge.mjs` + `diag-breakeven.mjs`, 60 days, 1465 positions). No change made.**
  - Totals: win 65.7%, avg +0.56% (SE ±0.15%), median +0.39%, p10 −4.37%, p5 −9.82%, total +$452. Avg win $2.33 vs avg loss −$3.57.
  - The leak is exits, not entries. Stop-loss closes are −$1219 (n=135, avg −9.9%). Losers that had peaked 0.5–5% are −$1111.
  - **Entry features don't separate.** Every quartile of fee/TVL, organic, volatility, bin_step, mcap, holders and size is within about 2 SE of the mean. With 32 buckets that is noise. Don't add entry filters from this data.
  - **Break-even in-range deferral is not the cause.**
    - Only 81 positions were ever deferred, with a median lowest PnL of −0.92% while deferred. Shortening it (−0.5% to −4% depth caps) was negative in every variant (bootstrap positive in 8–42% of resamples). No deferral lasted 10m or more.
    - The 80 stop losses on break-even-armed positions (−$659) went down without a deferral. They mostly predate direct closes (2026-09-29), when the break-even close waited on the LLM loop.
  - Levers already deployed, to be measured at the 2026-10-16 evaluation: direct closes (09-29), the in-range trailing fix (09-30) and max age 600. Re-check stop-loss $ on armed positions (peak ≥1%) closed after 09-30.
- **Projection for the 2026-10-16 evaluation (written 2026-09-30).**
  - These are estimates from the backtests above, not a joint simulation. Baseline (60 days, before the fixes): total +$452, avg +0.56%, median +0.39%, win 65.7%, p10 −4.37%, p5 −9.82%, avg win $2.33 vs avg loss −$3.57. Average position is about $92.
  - Expected change per 60 days, by fix:

    | Fix | Basis | Expected | Confidence |
    |---|---|---|---|
    | In-range trailing TP (09-30) | 39 losers with peak ≥5% ended −3.2% (−$120); the floor closes near half the peak (about +3.5%). Discounted for in-range dips that recover. | +$150 to +$300 | Medium |
    | Direct closes (09-29) | 13 break-even decisions in 30 days waited on the LLM and ended −10.7% avg; a prompt close would realize about −1 to −2%. Upper bound: 80 armed stop losses, −$659 per 60 days. Range-crossing rugs are not helped. | +$100 to +$240 | Medium |
    | Max age 600 (09-29) | Max-age closes still earned about 0.7% of capital per hour; fewer slots refilled into the loss-prone first 6h. No data beyond about 6.3h. | $0 to +$300 | Low |

  - The fixes overlap: trailing and direct closes both target positions that were up and then fell. Combined estimate: +$300 to +$600 per 60 days.
    - Avg per position about +0.8% to +1.0%.
    - Win rate about 67–68%. Only the trailing fix turns losers into winners.
    - p5 and the avg-loss $ should improve most. Median should barely move.
    - Position count per day may fall (max age 600), so judge total $ and avg, not trade count.
  - What to check on 2026-10-16 (about 2 weeks, about 350 closes; avg SE about ±0.3%, so avg alone won't be conclusive):
    1. Trailing fix: count of "give-back floor" / "in-range grace expired" closes and their avg PnL.
    2. Direct closes: stop-loss $ on positions with peak ≥1%, against a baseline of about −$150 per 2 weeks (−$659 per 60 days).
    3. Max age: PnL in the 6–12h and 12h+ hold buckets, and stop losses after 6h.
    4. Overall: re-run `diag-breakeven.mjs` (avg, median, p10/p5, avg win vs avg loss) and `diag-edge.mjs` for the post-09-30 window, and compare against the baseline above.
  - Could be off because:
    - the market may differ (the second half of the baseline was already weaker, avg 0.39% vs 0.75%);
    - max age has no reference data;
    - real fills during dumps are worse than logged PnL.
  - If a fix's own metric (items 1–3) looks worse than its baseline, look at that fix alone before changing anything else.
- **Housekeeping (2026-09-30).** Test: `test:housekeeping`.
  - `state.json` drops closed positions older than 7 days on every save (`pruneClosedPositions`, state.js).
    - Before, it kept every closed position (8.7 MB), and it is re-read and re-written many times per 30s poll.
    - The daily briefing only reads the last 24h of closes. `lessons.json` keeps the full performance record, which every analysis uses.
    - After the first save, `getStateSummary`'s closed count and all-time claimed fees cover only the last 7 days.
  - Daily `logs/agent-*.log` and `actions-*.jsonl` files older than `LOG_RETENTION_DAYS` (env, default 90) are deleted, checked once per day by `logger.js` (`pruneOldLogs`).
    - Before, nothing was ever deleted: 463 MB.
    - The pm2 copies in `~/.pm2/logs` are separate. Use `pm2 install pm2-logrotate` for those.
  - Removed `backups/20260517/` (old copies of config.js, index.js and setup.js, about 2,800 lines; nothing imported them) and the hourly health check.
  - Not done: trimming routine success log lines. That needs a per-category size count first.
- **Orphan positions from failed wide-range deploys. Fixed 2026-10-01.** Test: `test:orphan-cleanup`.
  - A deploy with more than 69 bins (`bins_below` > 64 plus the minimum 5 `bins_above`) is two steps: create an empty position, then add liquidity. If the add failed, the empty position stayed on-chain, untracked (it shows as `TOKEN/SOL` with $0 value), holding a position slot and its rent.
  - Live logs: about 129 such failures since July, about 3 a day in September. About 55% were `Simulation failed` and 45% `block height exceeded` on the add-liquidity tx.
  - Older orphans were apparently closed by the manager LLM seeing a $0 position. Since direct closes (09-29) nothing closed them; bukangi/SOL sat there for 8.5h.
  - Fix: the deploy `catch` calls `cleanupOrphanPosition` (tools/dlmm.js) once the create txs have landed. It closes the empty account, or removes a partial add first. A failed cleanup logs `Orphan position … left open … close it manually with /close` and never throws. The next screening cycle retries the deploy as usual.
  - **Follow-up 2026-10-02:** OP/SOL stayed at $0 because the cleanup's own close tx expired once (`Signature … has expired: block height exceeded`, 02:46) and there was no retry. `cleanupOrphanPosition` now makes up to 4 attempts, 3s apart, re-reading the position and rebuilding the tx each time. If a late-landing earlier attempt makes the account disappear, it counts as closed. Live logs that day: 4 cleanups, 3 closed first try, 1 left open.
  - Not done (user's choice): retrying the add-liquidity tx after an expiry. Revisit if failed wide-range deploys keep costing deploys.
  - Check at the 2026-10-16 evaluation: count `Orphan position … closed` vs `left open` lines.
- **Close tx expiry (observed 2026-09-29, not changed).** 6 of about 75 close attempts in 3 days failed with `block height exceeded`, 6–30s after the tx was built. The retry landed within 3–60s every time. The bot sets no priority fee, and neither does the DLMM SDK. e/acc-SOL (a rug) expired twice and took about 90s to close. Revisit (priority fee or a resend loop) only if expiries grow or start costing measurable PnL.
- **Security audit findings not yet patched** (surfaced 2026-09-28, deferred by user choice — swap-cap and secret-file-permission fixes were prioritized instead):
  - `envcrypt.js` "encryption" is a repeating-key XOR cipher, not real encryption. **Left as is (re-checked 2026-09-29):** the key (`.envrypt` / `ENVRYPT_KEY`) lives on the same host as `.env`, so authenticated encryption would add little. The real protection is `chmod 600` on `.env` / `user-config.json` (see Secret File Permissions).
  - ~~Telegram token leaking into logs.~~ **Downgraded to low risk (re-checked 2026-09-29).**
    - `telegram.js` embeds the bot token in request URLs, but every error log writes only `e.message` or the Telegram response body, never the URL.
    - Node's fetch network error message is just `fetch failed`; the URL lives in `e.cause`, which is not logged.
    - A grep of the live `logs/` and `~/.pm2/logs/` for the token pattern found nothing.
    - Only revisit this if a log line ever includes `e.cause` or a request URL.
  - ~~HiveMind prompt injection.~~ **Fixed 2026-09-29:** shared lessons are off by default (see HiveMind section).
  - ~~Caret ranges on wallet deps.~~ **Fixed 2026-09-29:** `@solana/web3.js` 1.98.4, `bn.js` 5.2.3 and `bs58` 5.0.0 are exact-pinned in `package.json` and the lockfile root, matching the versions already installed.
