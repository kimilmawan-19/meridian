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
| marketRegime.cautionMinTokenAgeHours | marketRegime | 72 |
| marketRegime.cautionMinMcapMult | marketRegime | 2 |
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
LLM used, so notifications, auto-swap and `recordPerformance` still run. The LLM is called only
for judgment calls: `TP_PROPOSAL`, `INSTRUCTION`, `CLAIM`. On a failed close the position's
`_pollTriggeredAt` entry is cleared so the 30s poll retries immediately.

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
- **caution** (1.8 ≤ score < `bearishScoreThreshold`, default 3.7): position cap at `cautionMaxPositions` (default 3); screening interval multiplied by `cautionScreeningMult` (default 2×); quality thresholds raised for the cycle and restored after; **deploy size scaled by `cautionPositionSizeMult` (default 0.75)** via `computeDeployAmount`
- **bearish** (score ≥ 3.7): screening skipped entirely

Caution threshold elevation is stored in `_cautionOrigFeeRatio`/`_cautionOrigOrganic` before modification and restored in the `finally` block to prevent compounding across cycles.

**Maturity bias (caution only):** the same elevation block also raises `minTokenAgeHours` to `marketRegime.cautionMinTokenAgeHours` (default 72h, via `Math.max` with the existing value — never loosens a stricter user setting) and `minMcap` by `marketRegime.cautionMinMcapMult` (default 2×). Intent: when the broad market is under stress, prefer tokens that have survived past the newest/most dump-prone phase and have more established liquidity, so fee-earning is less likely to get erased by price drop — **without** leaving the bot's memecoin/trending universe. Shifting to true blue-chip majors was considered and rejected: this bot's edge (`fee_active_tvl_ratio`/organic screening on volatile pools) doesn't transfer to efficient blue-chip markets, where fee/TVL is much thinner — it would likely make the low-fee-day problem worse, not better. Saved into `_cautionOrigMinTokenAgeHours`/`_cautionOrigMinMcap` and restored in the same `finally` block; these use `undefined` as the "was raised this cycle" sentinel (not `!= null`) since `minTokenAgeHours` legitimately defaults to `null`, and a `!= null` restore check would skip restoring it back to `null`.

The assessed regime is also written to runtime `config.marketRegime._activeRegime` (set right after `assessMarketRegime`, or forced to `"healthy"` when `marketRegime.enabled=false`). This is the **only** channel `computeDeployAmount` (config.js) and the deploy guard (executor.js) use to apply caution size modulation — they don't import `_lastRegime`. `deployAmount` is computed **after** the regime block in `runScreeningCycle` so the current cycle's regime modulates size; the executor guard reads the same value, keeping prompt and guard consistent (15% tolerance absorbs position-value drift).

**Live message safety:** the screener no longer opens a live message; its report is a plain `sendMessage` sent only when a deploy was attempted or the cycle failed. The management cycle still opens one, but only once it has actions to execute, and always finalizes it in `finally`. Any new live message must be finalized on every path. An unfinalized one leaves `_liveMessageDepth > 0`, which permanently suppresses all Telegram notifications (`notifyClose`, `notifyDeploy`, etc.) until process restart. All early returns inside the screener `try` block should still assign `screenReport` before returning.

**Regime protection on EXISTING positions (not just new deploys):** previously regime only gated entry (skip screening on bearish, shrink new deploy size on caution) — a position opened during a healthy market kept its original SL/trailing tolerance even if the market turned caution/bearish while it was still open. Four things now also react to `config.marketRegime._activeRegime`:
- **SL tightening** (`state.js` `effectiveStopLossPct`): the per-position `sl_pct_override` **and** the `stopLossTightestPct` clamp are both scaled by `marketRegimeCautionSlMult` (0.85) / `marketRegimeBearishSlMult` (0.7) — a mid-vol-tier `-12%` SL becomes `-10.2%` in caution, `-8.4%` in bearish. Scaling the clamp too matters for the low-vol tier (`-8%`, equal to the default tightest bound): scaling `raw` alone would have no effect there (`-8×0.7=-5.6` is less negative than the unscaled `-8` clamp and would get pulled straight back to it) — this was the most common overshoot tier in observed data (CATWIF, reptilecoin, febu).
- **Faster profit-taking** (`state.js` `updatePnlAndCheckExits`, trailing TP give-back): `effectiveDrop` is scaled by `marketRegimeCautionTrailMult` (0.8) / `marketRegimeBearishTrailMult` (0.6) before stale-peak widening, locking in gains sooner.
- **SOL momentum signal** (`market-regime.js` Signal 4): self-samples `solPriceUsd` (already fetched each cycle, no extra API call) into a small in-memory ring buffer and scores a SOL-denominated dump (≥30m/60m windows) — almost every LP here is SOL-quoted, so a broad SOL move is systemic risk the token-breadth signals don't directly see. Raised the bearish/caution thresholds from the pre-signal 3.0/1.5 to 3.7/1.8 to absorb this signal's +1.0 max headroom (max score now 5.5).
- **Rule 10 — trim-to-cap** (`index.js` `runManagementCycle`): when caution/bearish and open positions exceed `cautionMaxPositions` after other rules run, the single weakest-PnL still-open position is closed this cycle (rate-limited to 1/cycle to avoid dumping several at once — re-evaluated next cycle if still over cap).

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
- **Security audit findings not yet patched** (surfaced 2026-09-28, deferred by user choice — swap-cap and secret-file-permission fixes were prioritized instead):
  - `envcrypt.js` "encryption" (`scripts/envrypt.js` / `envcrypt.js`) is a repeating-key XOR cipher, not real encryption — key length is recoverable via known-plaintext (e.g. the `sk-or-` OpenRouter prefix), giving false confidence that `.env` is protected at rest. Should be replaced with authenticated encryption (e.g. AES-256-GCM with a KDF like scrypt) if this feature is kept.
  - `telegram.js` builds request URLs with the bot token embedded (`https://api.telegram.org/bot${TOKEN}`); thrown fetch errors are logged via `logger.js` and could carry the full URL (with token) into log files. Should redact the token before logging any error containing the request URL.
  - `hivemind.js`'s inbound `rule` text (`getSharedLessonsForPrompt`) is only sanitized for angle-brackets/backticks/control chars, not for instruction-like content, before being injected into the LLM prompt as a `[HIVEMIND ...]` line. `prompt.js` labels it untrusted (advisory to the LLM only) — a compromised `HIVE_MIND_URL` endpoint could still attempt prompt injection to bias trading decisions. No hard-coded guard exists beyond the advisory label.
  - `package.json` pins `@meteora-ag/dlmm` exactly but leaves `@solana/web3.js`, `bs58`, `bn.js` (wallet/crypto-adjacent) on caret ranges — a compromised patch/minor release of any of these would be auto-pulled on `npm install`. Consider exact-pinning these three specifically, or auditing regularly via `npm audit`.
