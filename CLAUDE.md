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
briefing.js         Daily Telegram briefing (text) + shared 24h stats
report-html.js      HTML report file: morning briefing attachment, /briefing, /viz
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
| maxBundlePct | screening | 30 (inert: needs OKX advanced-info, which returns HTTP 402) |
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
- `minPoolAgeHours`, `maxTop10Pct`, `minTokenFeesSol`, `maxBundlePct` (inert since OKX advanced-info returns HTTP 402), `maxBotHoldersPct`, `blockedLaunchpads`, rugpull/PVP flags — all applied before LLM prompt is built.

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
| `/positions` | List open positions, one line each, then a total across all of them (value, PnL, unclaimed fees) |
| `/close <n>` | Close position by list index |
| `/closeall confirm` | Close all positions (bare `/closeall` only asks for confirmation) |
| `/set <n> <note>` | Set note on position by list index |
| `/check <n>` | Simulate exit checks for position n (aliases: `/test-pnl-poll`, `/test-emergency-exit`) |
| `/pause` / `/resume` | Stop / resume **new deploys** only |
| `/viz` | HTML report snapshot as one file with a 3-line caption (see "HTML Report") |
| `/briefing` | Morning briefing text, then the same HTML report as a file |

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
- **`/positions` ends with a total line** (`formatPositionsMessage`, index.js): `Total (3): $402.70 | PnL: -$0.90 | fees: $4.20`, in ◎ with 4 decimals when `solMode` is on. A position with a missing figure is left out of the sum and counted as `data kurang: N posisi`, so a gap never reads as zero; its own line prints `?` for that figure (it used to print `+$null`). The total sums the listed positions, while the header count is the `total_positions` the caller passes. Test: `test:positions-total`.
- **Auto-swap after close or partial close.** `swapToken` returns `{ success:false, error }` instead of throwing, so the executor now checks the result. A failure sends `notifyAutoSwapFailed`, which is never suppressed by a live message. Previously a failed swap was marked `auto_swapped: true`, and the failure branch never ran.

---

## HTML Report (report-html.js, since 2026-10-13)

One self-contained `.html` file with three entry points: the morning briefing sends it after the text, `/briefing` sends text + file, `/viz` sends only the file with a 3-line caption (open positions, regime, 24h PnL / closes / win rate). Read-only: it reads `state.json`, `lessons.json`, `decision-log.json` and the position list, and touches no trading logic. Tests: `test:report-html` (data, periods, escaping, drift guard), `test:report-send` (upload, retries, commands, briefing flow).

- **Static file.** Inline CSS, inline SVG charts, no JavaScript, no outside request (font stack is the system one). It was built that way because it is not known how Telegram on a given phone opens an `.html` document. Chart values are `<title>` tooltips plus a table under each chart. Light and dark follow `prefers-color-scheme`. About 150 KB with all periods (4,000 closes: 116 KB, built in about 30 ms).
- **Period selector without JS.** Radio buttons + CSS: every period is rendered into the file and the checked one is shown. Periods: 1 day, 7, 30, 60 days (default), "Sejak 30 Sep" (`SINCE_FIX`, the exit-fix date, for the 2026-10-16 evaluation), all. Free date ranges are not possible without JS. Bars are hourly for 1 day, daily up to 31 days, weekly beyond. Days are WIB calendar days; the 1-day period is a rolling 24h with clock-hour buckets (first bucket partial). The current day counts in 7 days and up.
- **Same numbers as the text.** `collectBriefingStats()` (briefing.js) computes the 24h figures once for both; the report's 1-day panel is the same window (`recorded_at` in the last 24h). "Dibuka / ditutup" come from `state.json` positions, as the text always did.
- **Open positions** use `getMyPositions()` without `force` (cache TTL 5 min, refreshed by the 30s poll), so there is normally no extra RPC call. If the call throws or returns `error`, the report says live data is unavailable and shows cards from `state.json` without PnL. Stop loss comes from `effectiveStopLossPct` with the live regime. The trailing levels are a copy of the formula in `updatePnlAndCheckExits` (`trailingLevels`): "Trailing" is where the trigger starts, "Lantai give-back" is the level that closes at once in range. `test:report-html` [2] compares both against the real function, so a change to the trailing rules there fails the test.
- **Decisions come from `decision-log.json`, which keeps the newest 100 entries.** Live that is roughly a day or less, so the timeline can start later than 24h ago; the report says so when the log is full and its oldest entry is newer than the window. Deploy entries only carry strategy, SOL, volatility and fee/TVL; the candidate rank is joined from `signal_snapshot` in `state.json` (kept 7 days). Why a pool was picked and which candidates were rejected are not stored, except the `rejected` list of a "No candidates available" entry. Consecutive identical skips are grouped (`Skip ×N`).
- **Delivery and failure.** `sendDocument` (telegram.js) uploads multipart with the same network retry as `postTelegram` (1s, 3s); a caption Telegram rejects (400) is resent once as plain text; other HTTP errors are not retried. In `runBriefing` the date is stamped right after the **text** is sent, and the file is best-effort and only logged (`HTML report failed`): a file failure must never leave the date unset, or the 6h watchdog would resend the text. `/viz` and `/briefing` reply with the reason when the file fails.
- **Commands.** `/viz` is answered before the busy gate (read-only, no LLM, no state writes), so it does not queue behind a screening or management cycle; `/briefing` stays behind it. A 30s cooldown is shared by both (`reportCooldownLeftMs`), plus a busy flag. Only the configured chat can send commands (`isAuthorizedIncomingMessage`).
- **Lessons in the briefing text were shortened.** The block used to list every lesson of the last 24h in full (110–240 chars each, no cap). Per-close lessons are written for closes with PnL ≥ +5% (or ≥ 0 with fee yield ≥ 2%) or < −5%, and `AGGREGATE` lessons (strategy × bin_step statistics, up to 4) are recomputed every 20 closes with a fresh `created_at`, so they counted as "new" almost every day. Now the text shows `Lessons: N new (type counts)`, the two lessons with the largest |PnL| cut at a word boundary (about 90 chars; operator-written and auto-evolved lessons always first), and a pointer to the report. `AGGREGATE` is not counted in the text; the report lists the per-close lessons in full and the aggregates as a small table. The real number of lessons per day was estimated from the code, not measured: count them with `node -e "const L=JSON.parse(require('fs').readFileSync('lessons.json','utf8')).lessons;const c=Date.now()-864e5;const r=L.filter(l=>Date.parse(l.created_at)>c);const by={};for(const l of r){const k=(l.tags||[]).includes('aggregate')?'AGGREGATE':String(l.rule).split(':')[0];by[k]=(by[k]||0)+1}console.log(r.length,by)"`.
- **Known quirk, not changed:** a negative net PnL prints as `$-23.39` in the text, because the `+` is added only for non-negative values.
- **Check at the 2026-10-16 evaluation:** the morning files arrived (log lines `HTML report sent` vs `HTML report failed`); file size in the log; whether the decision-log window covers 24h (the report note appears when it does not; raising `MAX_DECISIONS` in decision-log.js is a one-number change); the real lessons-per-day count above; whether `/viz` is used (then consider `/viz 7` to open on another period, which only changes the checked radio).

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

## Bundler Detection (OKX, currently inactive)

`bundle_pct` comes from OKX advanced-info (`getAdvancedInfo` in `tools/okx.js`, field `bundleHoldingPercent`) and is filtered in `tools/screening.js` and `index.js` against `maxBundlePct` (default 30). There is no local bundler detection: the `common_funder` / `funded_same_window` signals and the key `maxBundlersPct` that this section used to describe do not exist in the code. The OKX endpoint has returned HTTP 402 since at least 2026-09-16, so `bundle_pct` is null and the filter passes everything (see Known Issues, "OKX enrichment is dead").

**Thresholds in config**: `maxBundlePct` (default 30%, inert), `maxTop10Pct` (default 60%)
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

**Swap detail log (since 2026-10-17).** `swapToken` writes one `[SWAP_DETAIL] {json}` line to `logs/agent-*.log` after every successful swap, right after the `[SWAP] SUCCESS tx: …` line (which is unchanged). Log-only: `buildSwapDetail` (tools/wallet.js) is pure, and the call is wrapped so a logging bug can never turn a successful swap into a reported failure (it logs `swap_warn` "Swap detail not logged" instead). Test: `test:swap-detail`.
- **Why.** The referral fee was measured from volume × bps, but slippage and price impact on the roughly 550 token → SOL auto-swaps a month (about $23.8K) were recorded nowhere: the old log had only the tx, `amount_out` and `fee_bps_applied` lived in `swapToken`'s return value, and `sol_received` is set after `logAction`.
- **Fields.** `tx`; `in` / `out` ("SOL" or a mint); `in_ui` (amount swapped); `out_raw` (executed output, raw units; apparently before Jupiter's fee, see "Reading it"); `out_sol` (SOL received, only when the output is SOL); `quote_out` (Jupiter's quoted output at order time); `fee_bps` (the fee Jupiter says it applied); `price_impact`, `jup_in_usd`, `jup_out_usd` (Jupiter's own figures when the order response has them: the names `priceImpact` / `inUsdValue` / `outUsdValue` were confirmed by the first live line (2026-10-17 04:33Z, all 13 fields filled; the code also falls back to `priceImpactPct`, which that line did not need); `price_impact` is in percent and equals `jup_out_usd` ÷ `jup_in_usd` − 1, so it includes the fee); `expected_usd` (the wallet's USD value of the token just before the swap) and `sol_usd` (SOL price at that moment). The last two are passed only by the three auto-swap callers in `tools/executor.js` (after close, after partial close, after claim); manual swaps leave them null.
- **Reading it.** Slippage per swap = 1 − `out_sol` × `sol_usd` ÷ `expected_usd`; cost in $ = `expected_usd` − `out_sol` × `sol_usd`. Cross-checks: `out_raw` against `quote_out` (execution against the quote, after allowing for the fee, see below), the volume-weighted `price_impact` (the same number as `jup_out_usd` ÷ `jup_in_usd` − 1, so one check, not two), and the wallet's SOL change on-chain. `expected_usd` is the Helius mark rounded to cents, so tiny swaps are noisy (weight by volume), and a stale mark on an illiquid token can add error of either sign; the cross-checks say which.
- **First live line (2026-10-17 04:33Z, a $1.89 swap, so n=1 and no evidence about slippage).** `out_raw` 18,072,050 against `quote_out` 18,053,978 is exactly 1 ÷ 0.999 (`fee_bps` 10), so the executed output looks like the route output before Jupiter's fee and the quote is after it. If so `out_sol` overstates what reaches the wallet by `fee_bps`; not yet verified on-chain (see the amendments). On the same line `expected_usd` $1.87 sits 1.07% below `jup_in_usd` $1.8899 (rounding to cents explains at most 0.27%), so S against the Helius mark was −1.07% (a gain), which is mark error; Jupiter's own figures put the cost at 0.117% (fee 0.100% + price impact 0.017%).
- **`fee_bps` is Jupiter's total fee on the order, not a referral test.** First live line: 10, so the referral is off for that order (while it was on, `diag-referral.mjs` counted 0 "referral fee requested … but order applied" warnings in 525 successful swaps over 31 days, i.e. `order.feeBps` was exactly 50). So the 50 bps replaced Jupiter's own base fee instead of adding to it (Jupiter's fee docs, seen only through search summaries because `developers.jup.ag` does not resolve from the dev sandbox: Jupiter keeps 20% of an integrator fee and charges no separate base fee then; base tiers 0 / 2 / 5 / 10 bps, and 50 bps for tokens under 24h old on the Ultra page, not checked for Swap V2). A 50 on a later line is therefore not by itself a leak (a young token can carry it); a leak would show 50 on every swap. Test the distribution, not single lines.
- **Rule, set 2026-10-17 before any data.** Use auto-swaps (lines with `expected_usd`, `sol_usd` and `out_sol`) from the first restart with this code, at least 100 of them (about 6 days; about 250 by 2026-10-30). With S = Σ cost ÷ Σ `expected_usd`: S ≥ 0.5% (about $120 a month at the current volume, the size of the referral fee) is material, so find which tokens and sizes drive it before changing anything; `swapSlippageBps` only caps the worst case and is not the cost, so do not touch it on this evidence alone. 0.2% ≤ S < 0.5%: noted, no change. S < 0.2% (about $48 a month): closed. S must also point the same way in at least one cross-check (`price_impact` or the Jupiter USD values); if it does not, report it as possible mark error, not as a cost. The analysis is a read-only `diag-slippage.mjs`, written at the evaluation.
- **Amendments to the rule, 2026-10-17, written after the first line and before any analysis (gaps found in the rule as first written).**
  1. Split the fee from slippage. F = Σ(`fee_bps` × `expected_usd`) ÷ 10⁴ ÷ Σ `expected_usd` is Jupiter's own fee, reported separately in $ per month. S_all = 1 − Σ(`out_sol` × (1 − `fee_bps`/10⁴) × `sol_usd`) ÷ Σ `expected_usd`, and S_p = S_all − F. The thresholds above (0.5% / 0.2%) apply to S_p. If the on-chain check shows `out_raw` is already what the wallet receives, drop the (1 − `fee_bps`/10⁴) factor.
  2. The two Jupiter cross-checks are one: `price_impact` is `jup_out_usd` ÷ `jup_in_usd` − 1. It includes the fee, so compare it with S_all. "Points the same way" now means the volume-weighted −`price_impact` is at least half of S_all. The independent cross-check is the wallet's SOL change on-chain.
  3. Mark error is measured: Σ `jup_in_usd` ÷ Σ `expected_usd` − 1 over auto-swaps. Beyond ±0.3% the Helius mark is not a usable reference and S is reported against Jupiter's value instead.
  4. On-chain check (`diag-swap-recv.mjs`, read-only): needs at least 8 swaps with `out_sol` ≥ 0.3 whose input token account was not closed in the same transaction. proceeds = wallet SOL change + network fee + change in the wallet's wSOL. Hypothesis A: `out_raw` is before the fee (proceeds ≈ `out_raw` × (1 − `fee_bps`/10⁴)); hypothesis B: `out_raw` is what arrives (proceeds ≈ `out_raw`). A or B wins by the smaller median |error|, and only if that median is ≤ 0.04%; otherwise "unclear" and nothing is concluded. First run on the live server (2026-10-17, shortly after the first line): 8 log files, 1 line, 0 malformed; [1] and [2] ran on the real log format and said "not enough" (n=1 and n=0); [3] found no swap ≥ 0.3 SOL yet, so it has not touched a real Jupiter transaction: tips, gasless payers and closed input accounts are still untested live.
  5. Uncertainty, written after seeing that auto-swaps run from $0.10 up (`tools/executor.js`: `token.usd >= 0.10`) and that the Helius mark was 1.07% off on the one line so far: the swap count overstates the information, because S is volume-weighted and a few large swaps carry it. Report S_p with SE = √(Σ wᵢ² (sᵢ − S_p)²) ÷ Σ wᵢ (wᵢ = `expected_usd`, sᵢ = the swap's own slippage) and the Kish effective count n_eff = (Σ wᵢ)² ÷ Σ wᵢ² next to n. Conclude only when S_p ± 2·SE lies inside one band (closed < 0.2% ≤ noted < 0.5% ≤ material); the one exception is material, which needs only S_p ≥ 0.5% and S_p − 2·SE > 0.2%, because investigating costs little. Otherwise "not decided": keep collecting and change nothing. The 100-swap minimum stays as a floor, not as a stopping rule.

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

**Not-yet-indexed readings are ignored (since 2026-10-16).** `getMyPositions` (tools/dlmm.js) treats a PnL reading of ≤ −99% on a position younger than 10 minutes (`UNINDEXED_PNL_MAX_AGE_MIN`, a constant, not a config key) as missing PnL. `pnl_pct`, `pnl_usd` and `pnl_true_usd` are null, `pnl_pct_suspicious` is true, and the log line is `Unindexed PnL reading for XXXXXXXX: reported -100.00% at age 0m — PnL ignored this tick`.
- Why: right after a deploy the PnL API sometimes returns the reading before the balance (or the deposit) is indexed. Reported and derived PnL then both read −100% (or the derived one is null), so the reported-vs-derived check (`pnlSanityMaxDiffPct`) passes and the early-dump override fires. Live: 6 times in 12 days, all at age 0 (`Stop loss: PnL -100.00% <= -8% [per-position] [early-dump override] (age: 0m)`). CLAUDIA (10-05) and QI (10-13) were closed at about 0%. The other 4 close attempts failed, and those positions then ran normally for 1–2 hours.
- Effect: stop loss, early dump, break-even, trailing and peak confirmation skip on `pnl_pct_suspicious`. Rules 1 and 2 need a non-null `pnl_pct`. Rules 7, 9, 11, rapid drop and the Rule 10 trim read null as 0, so the new position counts as green, not as the weakest. `/positions` prints `PnL: ?`.
- From 10 minutes on, a −100% reading is acted on as before, so a real total loss and an orphan are still handled. A real rug to −99% inside the first 10 minutes waits at most 10 minutes, and about 1% of the position is left to save at that point.
- Test: `test:unindexed-pnl` (without the fix it reproduces the live reason above).

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
  - **Re-verified 2026-10-03 with the fixed random generator (`diag-feetvl.mjs`, 60 days, 1501 positions).** Top quintile minus the rest: +1.07 points (90% +0.36..+1.80, 99% of resamples positive; before +1.03, 100%). By thirds of time: +1.97 (+0.66..+3.40), +1.01 (−0.30..+2.37), +0.56 (−0.50..+1.67), the same fade as before, with the last two including 0. bid_ask +1.00 (+0.10..+1.82, 97%), curve +0.99 (−0.43..+2.42, 88%). Spearman unchanged (0.15 overall, 0.45 bid_ask, 0.27 curve). The conclusion stands: the effect is real overall but fading and not consistent across all three periods and both strategies, which is why it is a prompt-level preference and not a hard rule.
  - **Not done on purpose.** No deterministic "take #1" and no higher `minFeeActiveTvlRatio`: the lower groups still earn, the recent effect is weak, and the LLM still catches bad tokens the numbers don't show.
  - **Recorded, not used (in `signal_snapshot` and the `lessons.json` record):** `candidate_rank`, `candidate_count`, `top_fee_tvl` (fee_tvl of #1 in that cycle), `tvl`, `fee_tvl_24h` (one extra `getPoolDetail(timeframe "24h")` per candidate, fail-open). Two log lines per screening: `Candidates (best first): #1 NAME fee_tvl=… | #2 …` and `Screener pick: NAME rank #k of n`. Not Darwin weights.
  - **Check at the 2026-10-16 evaluation.** How often the pick is #1; PnL of picks at #1 vs lower ranks; whether `fee_tvl_24h` ranks outcomes better than the 5m value (Spearman against fee earned per hour, top-quintile PnL); PnL by `tvl` bucket. If the pick is rarely #1 even without a skip signal, tighten the wording or take the pick out of the LLM's hands. If the top-quintile effect is gone, drop `CANDIDATE ORDER`.
  - **Live config differs from the defaults in this file** (seen 2026-10-02): `maxTvl` 300000, `minBinStep` 20, `minVolume` 1500, `maxMcap` 20M, `minFeeActiveTvlRatio` 0.09. With `maxTvl` 300k, raising it to 1M adds 0 pools (12 candidates both ways, highest TVL $161k), so TVL is not what limits the list. `initial_fee_tvl_24h` in state.js holds the screening-timeframe ratio, not a 24h one; the real 24h value is `fee_tvl_24h` above.
- **Screener filter relevance (2026-10-02, `diag-filters.mjs`, 60 days, 1491 curve/bid_ask positions, avg +0.51%, stop loss 9%).** Only the caution bar changed (above); everything else is unchanged. Test: `test:caution-bar`.
  - **Which filters select winners.** Only fee/TVL does: +0.34% (0.09–0.13, n=83), +0.15% (0.13–0.3, n=370), +0.35% (0.3–0.85), +0.82% (0.85–2), +1.30% (≥2, n=209, stop loss 6%; both halves positive, +1.92 / +0.91). The lowest band still earns, so there is no case for raising the floor. Exit link: the ≥2 band exits by trailing/break-even 17% and low yield 21%, the lower bands by trailing/break-even 1–5% and low yield 31–35%. High 5m fee/TVL reaches profit-taking, low fee/TVL ends in Rule 5.
  - **The rest are hard bounds or hygiene, not selectors.**
    - Organic is hump-shaped: 60–65 −0.10% (n=83), 65–70 +0.86%, 70–80 +0.84% (n=689), ≥80 +0.13% (n=545, both halves ≤0.23, stop loss 11%, OOR 25%). About 1.6 SE, no action.
    - Mcap has no monotonic relation: <400k +1.00% (n=82), 400k–1M +0.84%, 1–3M +0.06% (n=452, stop loss 12%), 3–10M +0.73%, ≥10M +0.73% (n=121, OOR 33%). Small caps are not worse.
      - **Re-checked 2026-10-03 with `diag-mcap.mjs` (1401 positions, rank correlation of log mcap with PnL, permutation test): no relation.** Spearman −0.02 (p=0.55) overall, curve −0.01, bid_ask −0.04, thirds of time −0.02/+0.04/−0.06, last 14 days −0.07 (p=0.25), last 7 days +0.01; inside the volatility tiers −0.01/−0.04/+0.01. Mcap vs stop loss 0.01. Smallest third (≤0.95M) +0.88% vs largest third (≥2.92M) +0.71%, bootstrap 90% −0.31..+0.81. Mcap does move with other features (fee/TVL −0.25, volatility −0.21, curve share +0.18), and PnL still does not follow. Only OOR rises at the top (33% at 10–20M, n=121, as before), without a PnL effect. Mcap is not a lever for stop loss or entry; don't add a mcap rule.
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
- **Erratum, 2026-10-03: bootstrap intervals and permutation p-values from the `diag-*.mjs` scripts are unreliable.** The scripts used `seed = (seed * 1103515245 + 12345) % 2147483648` in plain doubles. The product exceeds 2^53, so the generator loses its low bits: it repeats after 280 steps and is not uniform (10 equal bins held 11.8k–30.0k of 200k draws). Resamples then reuse a small set of indices, so intervals come out too narrow and shifted. Found when `diag-regap.mjs` printed intervals that did not contain their own point estimate (for example estimate −79, interval 5..115).
  - **Not affected:** point estimates (means, rates, Spearman r, totals), analytic standard errors, and any train/test split. `diag-breakeven.mjs` and `diag-streak.mjs` use valid generators. The affected scripts are `diag-filters`, `diag-feetvl`, `diag-combo`, `diag-impulse`, `diag-oor`, `diag-oor2`, `diag-mcap`, `diag-slsim`, `diag-cooldown`, `diag-regap`. All now use `Math.imul(seed, 1664525) + 1013904223 >>> 0`.
  - **Where a recorded conclusion used an interval, "% of resamples" or a permutation p-value, treat that number as unverified until the script is re-run:** fee/TVL-first (the only entry-side change, prompt only; the top-quintile gap of +1.03 points is about 4 standard errors analytically, so the direction is likely safe), caution bar and volatility floor (both rejected), impulse filter (rejected), OOR-below simulation (rejected), mcap (point estimate r=−0.02 is unchanged; analytic SE about 0.027), SL counterfactual (already judged unusable), cooldown after stop loss (counts, not intervals). Every one of these ended in "no change" except the prompt, so nothing live rests on a bad interval. **Re-run with the fixed generator (2026-10-03):** `diag-feetvl.mjs` matches the earlier numbers (see "Fee/TVL-first", re-verified) and `diag-regap.mjs` gave its first valid result (see "General cooldown after any close"). The other scripts are not yet re-run.
- **Stop loss too tight? Checked 2026-10-03 (`diag-sl.mjs`, 60 days, 1494 closes, 143 stop losses). No change.**
  - **The rise is mostly noise and a lucky prior week.** Stop-loss share: 3 days 13% (n=68), 7 days 13% (n=157), 7–14 days ago 3% (n=175), 14–30 days 9%, 30–60 days 11%. About +1.3 SE above the 10% baseline; the 3% week is the outlier. Average PnL of all closes was −0.75% over 7 days against +0.48/+0.56% before, so the market was weaker too.
  - **The deeper average stop loss (−14.3% vs −9.4%) is mostly overshoot and labelling.** Older "stop loss" rows include LLM-labelled break-even closes that ended around 0. Of the 14 stop losses with the threshold in the reason text, 5 closed far past it: AMERICA −68% (threshold −12), HOURS −27.6% (−12.75), SI −25.7% (−8), Jane −17.5% (−12.75), www −16.6% (−12), about two thirds of the loss. These are dumps between 30s polls. A wider or tighter threshold would not change them. The rest closed within 1–2 points of their threshold.
  - **Stopping out was right on average.** After a stop loss (63 positions with candles) the price 6h later was a median −7.9% below the close, 54% fell more than 5% further, and only 29% touched the entry price again (8% within 1h). The 1h bounce (68% peak >+5%) rarely reached entry. No random-time baseline, small n.
  - **Where it concentrates (unchanged from 09-30).** Curve 15% vs bid_ask 4%. Vol 1.5–2.0: 23% (n=169) vs 11% at ≤1.5 and 2.0–2.5; the 7-day rate for vol ≤2 is 23% (n=26). That band is the top of the −8% tier. Not changed: it still averages +0.24%, and the post-stop price shows no clear recovery (vol ≤2 after 1h: 25% fell >5%, 38% rose >5%, n=24). Only 14 stop losses carry the threshold text, so a tier-level test is not possible yet.
  - Re-check on 2026-10-16: stop losses after 09-29 have the threshold in the text (expect 40+). Compare stop-loss share and average depth by tier, and count overshoots (>3 points past the threshold). Loosen the −8% tier only if its stop losses at the threshold keep a high share in vol 1.5–2.0 and the price after them recovers.
  - **Counterfactual simulation (2026-10-03, `diag-slsim.mjs`, 647 positions with candles, 57 actual stop losses): not usable, no change.** The model values a single-sided SOL position from the 5m price path (curve/bid_ask bin weights, fees linear in time) and replays each position with the stop at 0.6–3× its tier threshold.
    - **Validation passed only on the pre-registered correlation.** r=0.87 at close (bias −0.25, MAE 1.43 points), but r=0.74 and MAE 4.95 on the actual stop losses.
    - **Calibration failed.** At k=1 the model stops 186 positions against 57 real ones (135 the bot never stopped), and its total is −$1781 against a real +$268. The model overstates intra-candle drawdowns, so any delta against its k=1 baseline is mostly the model unwinding stops that did not happen. The pre-registered rule had no calibration condition; added after seeing this (model stops within about 1.5× the real count and a total near the real one), because the absolute level is unusable, not to steer the result.
    - **What the formal rule would have said, and why it is an artifact.** Tighter (k=0.6/0.75: +$486 [297..611] / +$314) and the −8% tier at k=2/3 (+$156 [15..322] / +$203) pass it, with both halves positive. In both, the gain sits in the column of positions the bot did not stop; those are the fake model stops.
    - **The only clean column is the 57 positions the bot did stop** (model and reality agree on 51 of them). Wider stops: k=1.25 −$39, k=1.5 +$17, k=2 +$25, k=3 −$178, all inside noise. In vol 1.5–2.0 (14 stops) every loosening interval includes 0 (k=1.25 −$6 [−47..42], k=2 +$80 [−45..213]). So there is no evidence that a wider stop helps, which matches the post-stop price check above. The cost of tightening (false stops on positions that recover) cannot be measured with this model.
    - Decision: thresholds unchanged. Don't extend the model. Judge on real post-09-29 stop losses at the 2026-10-16 evaluation.
- **Cooldown after stop loss: checked 2026-10-03 (`diag-cooldown.mjs`, 90 days, 1985 positions, 207 stop losses). Works as intended, no change.**
  - The in-range-dump cooldown needs `range_efficiency > 70`, so a stop loss at ≤70 gets no token cooldown. Suspected gap, but it is empty in practice: of 168 stop losses ≤ −5%, 167 had range_eff >70 (median 132m hold, avg −12.04%) and only 1 was ≤70. Simulating the cooldown for that group would block 1 redeploy.
  - No leak: 0 redeploys of the same token inside an active cooldown. Redeploys start at 12h or later (61 at 12–24h, 40 at 24–72h; 66 of 168 were not redeployed within 72h).
  - After the cooldown they behave normally: +0.90% (n=61) and +0.03% (n=40) against +0.40% for all positions, stop-loss rate 11% and 10% against 10%.
  - **DARK-SOL 2026-10-03 was three separate deploys, not one position:** 07:48→12:40 Rule 3 pumped above range +6.49%; 13:31→15:36 trailing TP +0.84% (peak 8.31%); 15:47→16:34 stop loss −10.26% at age 46m (−11.71% vs the caution-tightened −10.2%). The two earlier closes were profitable and carry no cooldown, so the third deploy 11 minutes after the second is allowed. One case; the 09-29 check found same-pool repeats did fine, including a 6th+ deploy. Not acted on.
  - Rule (set before the result): extend the cooldown to range_eff ≤70 only with n≥30 blocked redeploys, a negative total with a 90% upper bound <0, and a negative total in both halves. Not met (n=1).
- **General cooldown after any close (same token): checked 2026-10-03 (`diag-regap.mjs`, 90 days, 1985 positions, 1754 close→redeploy pairs, fixed generator). No change.** Idea: a minimum gap after every close, not only after the loss/low-yield/emergency closes that already trigger a cooldown. Today a profitable close carries none, so DARK-SOL was redeployed 11 minutes after its trailing TP.
  - Redeploys by gap (avg PnL, stop-loss share): <0.5h n=321 +0.13% / 15%; 0.5–1h n=136 +0.18% / 15%; 1–3h n=241 +0.97% / 12%; 3–6h +0.61% / 8%; 6–12h +0.77% / 8%; 12–24h +0.55% / 8%; ≥24h +0.47% / 5%. All positions: +0.40%, stop loss 10%. 449 of the pairs under 1h followed a non-stop-loss close (273 of the first bucket followed a profit).
  - Simulated general cooldown, extra $ against the all-position average (90% interval; first/second half): H=0.5h −$74 (−210..+65; −40/−34), H=1h −$79 (−241..+91; +19/−98), H=3h +$43 (−164..+266), H=6h +$35 (−193..+258), H=12h +$113 (−137..+344). Every interval includes 0, so the pre-registered rule (n≥30, upper bound <0, both halves negative) is met nowhere. An earlier printout said "MEMENUHI" for 0.5h; that came from the broken generator (see the erratum).
  - Reading: under 1h the redeploys average lower (+0.13/+0.18% vs +0.40%) and stop out more often (15% vs 10%, about 3.5 standard errors on the rate), but the dollar gap is about 1 standard error, and longer cooldowns would block deploys that did better than average (not significant either). Not acted on. Re-check at the 2026-10-16 evaluation only if the under-1h stop-loss share stays near 15%.
- **BB/MACD and the "rebalance on lower band" idea: checked 2026-10-04 (`diag-bbmacd.mjs`, 726 curve/bid_ask positions with 5m candles, 60 days). Nothing built; one pre-registered hold-out test is open.** Source: a public post describing a manual routine (SOL-side position, price dumps to the lower Bollinger band with MACD red on 5m and 15m, withdraw only the token, re-add it as bid_ask above price, exit near the upper band).
  - **Tool and null.** Bollinger (20,2) and MACD (12,26,9) from the cached 5m candles (15m built from them, completed bars only). Signals are judged only on in-range candles, as a difference inside the same position (signal candles minus other in-range candles). That difference is biased even on random data, because a position's total move is fixed, so a candle after a drop has a more positive remaining path (null +4..+6 points at 3h here). The comparison is therefore a null: each position's post-deploy return series shifted circularly by a random offset, 400 times. Candles are clipped first (5m close ratio to 0.6–1.65, wicks to 1.5×/0.67×), the same way for real and null paths; 305 of 726 positions (42%) had at least one clipped candle, so extreme 5m candles are common in this data and the cleaning shapes the result. The first version (full shuffle, no clipping) gave nonsense nulls (+91, +129 points, intervals ±1300) and was discarded. A synthetic random-walk check with injected glitches gave 2 false passes in 32 tests, the control never passed.
  - **Signal results (3h price, excess over null, 95% null band).** Lower BB + MACD red 5m & 15m ("tweet" signal, 231 positions): +1.92 points (real 7.69 vs null 5.77, band 4.28..7.29), halves +2.30 / +1.51: meets the pre-registered rule. Same direction at 6h (+1.35), max bounce (+1.85) and shallower further drop (+1.21, outside the band); 1h −0.30. Lower BB alone (+0.71) and MACD red alone (+0.92) stay inside the band. Close ≥ upper BB (75 positions): excess +0.20, inside the band, so there is no support for an upper-band exit. The random control was inside its band on all metrics.
  - **Entry conditions (no null needed, 10 groups, avg +0.49%).** MACD red on 5m and 15m at deploy: n=141, +1.14% vs the rest, difference +0.81 (95% +0.11..+1.52), halves +1.02 / +0.61, stop loss 6%: the only group that passes. The tweet condition at deploy has only 16 positions (−0.63%, stop loss 13%), and %B<0 has 22 (−0.22%, stop loss 14%); too few to judge.
  - **Why this is not acted on.** (1) Four signals were tested on the main metric and 10 groups on entry, so about one passing result is expected by chance. (2) It measures price after the signal, not position PnL, and the earlier PnL model failed calibration, so the value of a rebalance cannot be computed from this data. (3) The token a position holds already sits in bins above the active price, which is a sell ladder. A rebalance reshapes it (more weight farther above, a fresh range near price); it does not create the ladder. (4) Rough scale, not measured: for a $110–160 position holding perhaps half in token, +1.9% is about $1 per event, which is the same size as the average PnL per position ($0.5–0.7) and as the cost of two extra transactions plus the failure rate of add-liquidity (wide deploys fail 27% of the time and leave orphans). (5) The numbers moved with the cleaning choices (42% of positions affected), which was not stress-tested.
  - **Pre-registered hold-out (set before any new data).** Only positions closed after 2026-10-04 count; the 726 above are the discovery set and must not be reused. H1: the tweet signal's +3h excess over the null is positive and outside the 95% null band, with at least 100 signal positions. H2: MACD red on 5m and 15m at deploy has a PnL difference vs the rest whose 95% interval is above 0, with at least 80 such positions. Run on the cached candles: `node diag-ohlcv.mjs 30` first (it fetches candles for new positions), then `node diag-bbmacd.mjs <days since 2026-10-04>`. If H1 holds, the next step is an economic test (a calibrated position model or a small live trial), not a build. If H2 holds, the cheapest use is a record-only field at deploy before any prompt line or filter. No bot code changed.
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
- **Longer-timeframe regime inputs: recorded only, since 2026-10-05.** Question: should caution use a higher timeframe? Not added to the score: the regime does not predict outcomes (see audit above), a higher timeframe mostly makes it slower, and smoothing for blips was already rejected on simulation. The log has no data to backtest it, so it is recorded first. Test: `test:regime-longtf`.
  - What is logged: each `[MARKET_REGIME]` line has `longtf: breadth 4h=…% volChange 4h=…% breadth 12h=…% volChange 12h=…%` (50 trending DLMM pools: share with positive price change, mean `volume_change_pct`). Meteora's list here has no 6h (`TIMEFRAME_MINUTES`: 5m…2h, 4h, 12h, 24h), so 4h and 12h bracket it. Not checked against the live API from the dev sandbox; a rejected timeframe logs `?` and changes nothing. Also in `signals.longTf`.
  - Cost: two extra Meteora calls per assessment, no LLM. Failure is fail-open (null). Score, thresholds and regime are unchanged (the test compares scores with and without the data).
  - Check after 2–3 weeks with `diag-regime.mjs` extended to read `longtf:`: does 4h/12h breadth or volume separate the loss clusters (or the blips) better than the current score? Set the rule before looking. Only then consider adding it to the score.
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
  - Evaluate after about 2–3 weeks (300+ closes): group PnL by `signal_snapshot.price_vs_ath_pct` bucket and strategy. Turn on `athFilterPct` only if a bucket is clearly net-negative. **Update 2026-10-16:** `price_vs_ath_pct` has been null for every position (OKX price-info returns HTTP 402), so there is nothing to evaluate; see "OKX enrichment is dead".
  - Also recorded: `flow_consensus` (the 5m/1h/6h flow label the screener shows), `txn_buys_5m`/`txn_sells_5m` (DexScreener) and `net_buyers_1h` (Jupiter).
  - Use them the same way: keep or drop a flow/transaction filter or prompt line only if its buckets actually separate winners from losers. The aim is to simplify, not to add rules.
  - **Audit fields (added 2026-10-02), same path, record-only:** `top10_pct`, `bot_holders_pct`, `bundle_pct`, `token_fees_sol`, `token_age_hours`, `active_pct`, `unique_traders` and `regime_at_entry` (the cycle's regime when the candidate was staged). They were missing, so the rug-hygiene filters (top10, bots, bundle, token fees), the pool-structure prompt lines and the old caution age floor could not be evaluated. Values are raw (null when the source had none). Not Darwin weights. Test: `test:signal-snapshot` [3]. **Update 2026-10-16:** `bundle_pct` has been null for every position (OKX advanced-info returns HTTP 402); the other audit fields are filled.
  - How to use them (about 2–3 weeks, 300+ closes): group PnL, stop-loss rate and rug rate (PnL ≤ −25%) by bucket of each field. The hygiene filters only reject candidates, so the data covers the accepted side: look at the band just inside each limit (for example top10 45–55%, bots 20–30%, bundle 20–30%, token fees 30–60 SOL) and whether it carries more stop losses or rugs than the rest. A filter whose near-limit band looks no worse than the middle could be loosened; one whose near-limit band is clearly worse supports keeping it. `regime_at_entry` replaces the log join used in `diag-filters.mjs` section B. `active_pct` (the prompt's "<10% = wide/inactive, >85% = trapped") and `unique_traders` can be checked the same way before keeping those prompt lines.
- **Win rate / avg audit (2026-09-30, `diag-edge.mjs` + `diag-breakeven.mjs`, 60 days, 1465 positions). No change made.**
  - Totals: win 65.7%, avg +0.56% (SE ±0.15%), median +0.39%, p10 −4.37%, p5 −9.82%, total +$452. Avg win $2.33 vs avg loss −$3.57.
  - The leak is exits, not entries. Stop-loss closes are −$1219 (n=135, avg −9.9%). Losers that had peaked 0.5–5% are −$1111.
  - **Entry features don't separate.** Every quartile of fee/TVL, organic, volatility, bin_step, mcap, holders and size is within about 2 SE of the mean. With 32 buckets that is noise. Don't add entry filters from this data.
  - **Break-even in-range deferral is not the cause.**
    - Only 81 positions were ever deferred, with a median lowest PnL of −0.92% while deferred. Shortening it (−0.5% to −4% depth caps) was negative in every variant (bootstrap positive in 8–42% of resamples). No deferral lasted 10m or more.
    - The 80 stop losses on break-even-armed positions (−$659) went down without a deferral. They mostly predate direct closes (2026-09-29), when the break-even close waited on the LLM loop.
  - Levers already deployed, to be measured at the 2026-10-16 evaluation: direct closes (09-29), the in-range trailing fix (09-30) and max age 600. Re-check stop-loss $ on armed positions (peak ≥1%) closed after 09-30.
  - **Erratum 2026-10-16:** "armed" above means peak ≥1%, but the live `breakEvenTriggerPct` is 5, so those positions had no break-even at all. See "Break-even never closes a position" below.
- **Projection for the 2026-10-16 evaluation (written 2026-09-30).**
  - These are estimates from the backtests above, not a joint simulation. Baseline (60 days, before the fixes): total +$452, avg +0.56%, median +0.39%, win 65.7%, p10 −4.37%, p5 −9.82%, avg win $2.33 vs avg loss −$3.57. Average position is about $92.
  - Expected change per 60 days, by fix:

    | Fix | Basis | Expected | Confidence |
    |---|---|---|---|
    | In-range trailing TP (09-30) | 39 losers with peak ≥5% ended −3.2% (−$120); the floor closes near half the peak (about +3.5%). Discounted for in-range dips that recover. | +$150 to +$300 | Medium |
    | Direct closes (09-29) | 13 break-even decisions in 30 days waited on the LLM and ended −10.7% avg; a prompt close would realize about −1 to −2%. Upper bound: 80 armed stop losses, −$659 per 60 days. Range-crossing rugs are not helped. (Erratum 2026-10-16: with live `breakEvenTriggerPct` 5 they were not armed, so this row could not deliver.) | +$100 to +$240 | Medium |
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
- **Loss segments: checked 2026-10-05 (`diag-segments.mjs`, 60 days, 1508 curve/bid_ask positions, total +$442). No segment passed, no change.**
  - Rule (set before the result): n≥40, total $ negative with the 95% bootstrap upper bound <0, avg % <0, negative in both time halves (n≥15 each). 74 segments tested (strategy, vol, bin_step, fee/TVL, organic, mcap, holders, smart wallets, strategy × vol/bin_step/fee_tvl, and the new snapshot fields).
  - Where the loss is: stop loss −$1479 (n=142), more than three times the bot's net. Losses ≤ −8% are 70% of all loss $ (104 positions). Since 09-30: no break-even or emergency closes, trailing +$76 (n=29), stop loss avg −12.85% (n=14, −$286).
  - Near misses: mcap 1–3M −$134 (first half +26, wide interval); bs ≥126 −$130 (already blocked); organic <65 / ≥90 (avg % positive); curve & bs 50–80 −$22, stop loss 21% (almost all in the old half).
  - **flow EXHAUSTION is the only consistent one:** n=18 (all since 09-30), −$100, avg −3.37%, stop loss 28%, interval −218..+5. 12 of the 18 overlap the 09-30 finding, so only 6 are a fresh check (about −2.7% avg). 7 of the 15 largest losses since 09-30 entered on EXHAUSTION. Not blocked: n<40 and 74 segments were tested at once. Adding it to `entryFlowBlockRegimes` is config-only. **Update 2026-10-16: did not replicate** (n=60, −$23, stop loss 12%); see "Stop loss vs entry features".
- **Why stop losses got deeper since 09-30 (2026-10-05, from the 13 visible in `diag-segments.mjs` section C).** Average threshold −10.8%, average close −13.8%, so about 3 points past the threshold on average.
  1. Two gap dumps account for about 83% of the overshoot: HOURS (threshold −12.75%, first read −31.8%) and SI on 10-02 (threshold −8%, first read −25.0%), −$92 of −$286. The other 11 overshot about 0.6 points on average (avg close about −11.5%). No threshold can catch a fall of 15+ points inside one 30s poll.
  2. Thresholds are wider: only 4 of 13 used the −8% tier; the rest used −12%, −12.75% (−15% × 0.85 caution) or −15%, on volatile tokens (vol 4.7–9.4). Execution at the threshold was accurate (Agency −15.03% vs −15%, HOOKED −12.22% vs −12%).
  3. The old −10% average was shallow because it included LLM-labelled break-even closes near 0% (see the label caveat under "Screener evaluation").
  - n=14, not a trend yet.
- **Evaluation checklist for 2026-10-16 (consolidated 2026-10-05).** Use only data after the fixes (closes after 2026-09-30 unless stated). Write the decision rule before looking at each result. Re-run any script listed in the RNG erratum before quoting its intervals.
  1. **Overall vs projection** (see "Projection for the 2026-10-16 evaluation"): `diag-breakeven.mjs`, `diag-edge.mjs` for the post-09-30 window.
  2. **Exit fixes:** trailing in-range fix ("give-back floor" / "in-range grace expired" closes and their PnL; "confirmed exit cancelled … back in range" only after OOR exits); direct closes (stop-loss $ on positions with peak ≥1%, baseline about −$150 per 2 weeks); max age 600 (`diag-explore2.mjs`: PnL in 6–12h and 12h+ buckets, stop losses past 6h, "no longer earning" closes).
  3. **Stop loss per tier (`diag-sl-tier.mjs`, written 2026-10-16 and run on the server; price after the stop comes from the existing `diag-sl.mjs`):** stop-loss share and average depth per tier (−8 / −12 / −15, and caution-scaled), overshoot (>3 points past the threshold, from the threshold in the reason text), and price after the stop (6h, share that returns to entry). Loosen the −8% tier only if its stops keep a high share in vol 1.5–2.0 and price recovers after them; tighten −12/−15 only if stops at those tiers keep falling well past the threshold without gap dumps. Gap dumps (first read already >5 points past the threshold) counted separately. **Rule, set 2026-10-16 before any result:** loosen −8% only with ≥20 stops carrying threshold text in the low tier, the vol 1.5–2.0 band at n≥40 closes with a stop-loss share ≥20% (baseline about 10%), and price recovering after those stops; tighten mid/high only with ≥20 stops in that tier and an average overshoot without gap dumps above 3 points.
  4. **Segments:** re-run `diag-segments.mjs` on the post-09-30 window with the same rule. EXHAUSTION: block in `entryFlowBlockRegimes` if n≥40 and the rule holds; same for CAPITULATION. Re-check curve & bs 50–80 and mcap 1–3M. (Done 2026-10-16 with `diag-sl-entry.mjs`: EXHAUSTION did not hold, CAPITULATION n=14; mcap 1–3M and curve fee/TVL <0.3 became hold-outs, see "Stop loss vs entry features".)
  5. **Screener:** how often the pick is #1 (`Screener pick` lines), PnL by `candidate_rank`, `fee_tvl_24h` vs the 5m value, PnL by `tvl` bucket; drop `CANDIDATE ORDER` if the top-quintile effect is gone (see "Fee/TVL-first selection").
  6. **Audit fields:** near-limit bands of top10, bots, bundle, token fees; `active_pct`, `unique_traders`, `regime_at_entry`, `price_vs_ath_pct`, `flow_consensus`. (2026-10-16: `bundle_pct` and `price_vs_ath_pct` are null for every position because OKX returns HTTP 402 and the Agent Meridian route is deprecated, so they cannot be evaluated; see "OKX enrichment is dead". Decision 2026-10-16: OKX is left as is, so bundle, ATH and cluster stay unevaluated.)
  7. **Smaller items:** bin_step <80 (live `minBinStep` 20); stop losses within 1h after a close of the same token (under-1h redeploy stop-loss share, baseline 15%); Rule 10 trims (should drop about 60%); `diag-streak.mjs`; partial closes (JACK, repeated partials per position); `Orphan position … closed` vs `left open`; `Price recovering` cancels; regime staleness (refresh in the management cycle is the more promising change than a higher timeframe).
  8. **Not before 2–3 weeks:** BB/MACD hold-out H1/H2 (`node diag-ohlcv.mjs 30` then `node diag-bbmacd.mjs <days since 2026-10-04>`, needs ≥100 / ≥80 positions); 4h/12h regime inputs (extend `diag-regime.mjs` to read `longtf:`).
  9. **`curveMinFeeActiveTvlRatio` (idea from the 09-29 reminder; the key does not exist in code):** add it only if `diag-curve-sweep.mjs` shows curve in the fee/TVL 0.3–0.5 band passing the same rule as the segments (n≥40, total negative with 95% upper bound <0, avg % <0, negative in both halves with n≥15). Otherwise no change: the lower fee/TVL bands still earned in the 60-day data.
- **2026-10-16 evaluation, part 1** (`diag-age`, `diag-ng-sl`, `diag-rug`, `diag-curve-sweep`: 14 days, 307 positions, +$119; `diag-tg-close`: 7 days; `diag-sl-tier`: since 09-30, 362 closes). Nothing changed yet; part 2 (`diag-breakeven`, `diag-edge`, segments, screener, audit fields) is still to run.
  - **Targets from the 09-29 reminder.**
    - Stop losses close at their threshold: met. Average close −10.69% vs threshold −10.60%; outside gap dumps the overshoot per tier is about 0 points.
    - No rug at bin_step ≥200: met. None was deployed; the only rug-grade close (≤ −25%) was SI-SOL, curve, bin_step 100.
    - No `can't parse entities`: met. Zero in 7 days, with 134 closes carrying `< > &` in the reason. The 249 `TELEGRAM_ERROR`s are 242 `Poll error: fetch failed` and 7 `sendChatAction` drops.
    - Fewer stop losses on positions that had been green: not met. 20 in 14 days, about the old rate of armed stop losses (80 per 60 days). No break-even close appeared at all. Cause: the live `breakEvenTriggerPct` is 5 (see "Break-even never closes a position").
  - **Where the money went (14 days).** Stop loss 37 closes −$392; everything else +$511. Rule 3 pumped above range 96 closes +$238; max age 45 closes +$143 (win 71%, with 4 stop losses past 6h in 7 days); trailing 74 closes +$142 (about twice the pre-fix $ pace); Rule 10 trims 19 closes −$24 (down about 20%, not the expected 60%). The total is near the old pace (about +$105 per 14 days) and below the projection.
  - **Decisions by the pre-registered rules.**
    - `curveMinFeeActiveTvlRatio` for the 0.3–0.5 band: rejected, the band is +$38 (n=50). The loss sits below 0.3 (curve n=43, −$48; curve vol <2 & fee/TVL <0.3: n=27, −$44, avg −1.64%). That cut-off came out of a sweep of 8, so it is a hold-out, not a change: add a curve fee/TVL floor of 0.3 only if curve closes after 2026-10-16 with fee/TVL <0.3 reach n≥40, total negative with a 95% upper bound <0, avg % <0 and both halves negative.
    - Loosen the −8% tier: not met (16 stops with threshold text in the low tier, 20 needed). The vol 1.5–2.0 band again has a high stop-loss share (27%, n=44, z=3.4; 23% over the 60 days before). But 9 of the 17 never-green stops are curve at vol 1.7–2.1, which a wider stop would not save. The cluster looks like an entry problem, which the curve hold-out above covers.
    - Tighten −12/−15: not met (17 and 10 stops; overshoot outside gap dumps 0.3 and 0.1 points).
  - **New findings.**
    - **Fixed 2026-10-16: a `PnL -100.00%` reading right after deploy fired the early-dump stop loss.** 6 times in 12 days, all at age 0; 2 executed that we identified (CLAUDIA, QI at about 0%), and `diag-sl-entry.mjs` later found 3 closed records carrying that reason since 09-30. See "Early-Dump SL Override" for the rule and test. The two bogus stops also distort the stop-loss counts and the "first read" averages above.
    - **Trailing exits use a 3.00-point give-back floor, set globally.** Every healthy-regime trailing reason in 7 days prints `>= 3.00%` (2.40 in caution, 5.25 with the stale-peak widening). Source, checked by the user: the live `user-config.json` has `trailingDropPct: 3` (code default 1.5). Per-position `trailing_drop_override` in `state.json` (7 days): null ×131, 3 ×10, 2.5 ×7. So it is the global key, set by hand (no `Agent self-tuned` log line mentions it), not the LLM; the screener prompt line "trailing_drop_pct: widen (e.g. 2.5–3)" only sets those 17. With a floor of 3 the half-peak floor never binds below a 6% peak, so peaks of 3–4.6% exit near 0: 16 such closes in 7 days ended between −2.98% and +1.84%. Rough upper bound for a floor of 1.5: about 1 point per trailing close (38 points over 37 closes in 7 days). That ignores positions a tighter floor would cut before a higher peak, which this data cannot show. Not decided: needs a check of how often positions dipped 1.5–3 points below their peak and then set a new peak (pool-memory snapshots or poll logs) before changing the key.
    - **Close failures: checked 2026-10-16, no change** (`diag-close-cost.mjs`, 7 days, 168 attempts, 21 failed).
      - All transaction-landing errors, no program error: 9 `block height exceeded`, 8 `Blockhash not found` at preflight, 4 on the bogus −100% closes (now prevented).
      - Every successful close was one transaction, so multi-transaction closes are not the cause. Ranges >69 bins failed 19% (9/47) vs 9% (11/118) at ≤69, z≈1.7, the same direction as wide deploys.
      - The existing retry (the failed position's poll cooldown is cleared) closed them a median 59s later (39–205s). GOMO (27 min) and CyberLee (8h) were not slow closes: their close condition went away.
      - $ between decision and final close, for the 5 with a PnL in the reason: −$10.91 (QUBIT −7.65, HIRE −9.33, HIGGS +2.71, Altai +3.05, CyberLee +0.31). The deltas on the bogus rows compare against the fake −100% and mean nothing.
      - Rule (set before the result): resend inside `closePosition` if ≥10 non-bogus positions per 7 days failed with these errors and the median delay is ≥60s. Result: 17 positions, median 59s, so not met, by one second. Re-check at the next evaluation; if wide ranges keep failing about twice as often, the candidate is a priority fee / compute budget, not a resend.
    - Close slippage in dumps: TWEETCRAFT and knightcat realized 3–4 points below their first read.
    - Not acted on, one of about 60 cells each: tokens with a loss in the previous 48h (n=97, avg −0.31% vs +0.71%); mcap 0.97–2.55M (−$27, never-green 12%), the same band as the 60-day near miss.
- **Break-even never closes a position: live `breakEvenTriggerPct` is 5 (found 2026-10-16). Recording first, decision about 2026-10-30.** Test: `test:be-probe`.
  - Live `user-config.json`: `breakEvenTriggerPct: 5` (code default 1), `trailingTriggerPct: 3`, `trailingDropPct: 3`, `breakEvenInRangeDeferMin: 60`. October logs: 82 `break-even stop activated`, 1 `Break-even deferred`, 0 `Rule 1: break-even`; no break-even close in 307 positions over 14 days.
  - Mechanism: break-even arms only at a 5% peak, and from there trailing (armed at 3%, give-back floor 3, half-peak floor) always closes first, so break-even never acts. A peak of 1–3% has no protection at all (break-even not armed, trailing not armed) and can ride to the stop loss; a peak of 3–5% has only the 3-point trailing floor and exits near 0.
  - Cost: of 37 stop losses in 14 days (−$392), 20 had a peak ≥1% (about −$215, derived as the total minus the never-green rows) and 15 never reached 1% (about −$175, mostly curve at vol 1.7–2.1 with low fee/TVL: an entry problem, covered by the curve hold-out). The rest were 2 bogus −100% stops and 2–3 gap dumps.
  - Why it was not set back to 1 right away (user's choice: measure first): Rule 1 (`index.js` `getDeterministicCloseRule`) closes as soon as PnL ≤ 0 and skips the 60-minute in-range deferral that `state.js` applies. Bid_ask earns by price falling into the range (PnL below 0) and recovering (Rule 3 +$238, max age +$143 in 14 days), so a 1% break-even may cut winners. No data shows how often: there is no per-poll PnL trail, and `pool-memory` keeps only a pool's last 48 snapshots.
  - Recording (record-only, no exit reads it): `trackPosition` adds `be_probe: {}`; `updatePnlAndCheckExits` arms levels 1, 2 and 3 on the same condition as the real break-even (confirmed peak ≥ level, not OOR ABOVE) and stores the first reading at PnL ≤ 0 afterwards (`hit_at`, `hit_pnl`, `hit_in_range`), the reading Rule 1 would close on. Suspicious or missing readings are skipped. Positions tracked before the change get no probe. `be_probe` goes into the `lessons.json` performance record at close.
  - **Live check 2026-10-16.** The user saw `be_probe: {}` on a position opened after the restart, so the initialisation in `state.json` works (nothing is armed until a peak ≥1%). Arming, hits and the copy into `lessons.json` at close are confirmed only by closes. Check after a few days: count the performance records whose `be_probe` is a non-null object, and how many have level 1/2/3 armed and hit. Expect roughly 23 closes a day (363 in the 16 days to 10-16), so about 300 records with a probe by 10-30; level 3 may stay under the 30-hit bar, in which case only levels 1 and 2 can be decided (an estimate, not a measurement).
  - **Rule, set 2026-10-16 before any data:** use only positions with `be_probe` (deployed after the change), about 14 days. For each X in {1, 2, 3}: Δ$ = Σ (hit_pnl − 0.5 − pnl_pct) / 100 × initial_value_usd over the positions whose level X was hit (0.5 points charged for execution lag and slippage). Lower `breakEvenTriggerPct` to the X with the largest Δ$ only if that X has ≥30 hits, Δ$ > 0, and Δ$ > 0 in both halves by close time. Report how many hits ended as winners (cost) and as losers (saved). If no X passes, keep 5 and leave peaks of 1–3% to entry and trailing work.
  - The analysis script is written at that evaluation (heredoc, read-only).
- **Strategy evaluation agenda (2026-10-16), in order of money at stake.**
  1. Break-even (above).
  2. Costs outside the recorded PnL. Every auto-swap after a close, partial or claim pays a Jupiter referral fee of 50 bps to the account hard-coded in `config.js` (`jupiter.referralAccount`, `referralFeeBps`), on by default and changeable only by env (`JUPITER_REFERRAL_FEE_BPS`, 0 = off). That is the user's decision, not a code change. Swap slippage (cap 5%) is not recorded either: the `[SWAP]` log has no `amount_out`, and `sol_received` is set after `logAction`. Measure with a read-only `diag-hidden-cost.mjs` (sum of `Auto-swapping … ($X)` lines × bps vs recorded PnL). *Superseded 2026-10-17: the referral part was measured with `diag-referral.mjs` (below), and slippage is recorded by the `swap_detail` line.*
     - **Referral fee measured and turned off (2026-10-17).** `diag-referral.mjs` (31 days of logs from 09-17, 50 bps): 551 auto-swaps (550 after a close, 1 partial, 0 claim), volume $23,775, average $43, fee $118.88 (about $3.83 a day), **36% of the recorded PnL** in the same window (+$331, 758 closes). Upper bound: the `Auto-swapping` line is written before the swap runs, and there were 31 `[SWAP_ERROR]` lines; the 525 `SUCCESS` lines include manual swaps, so the fee actually paid was about $110–119. The fee is not in any recorded PnL (PnL comes from the position value before the swap), so the real net was about $331 − $119.
     - **Decision (user, 2026-10-17): off,** with `JUPITER_REFERRAL_FEE_BPS=0` in `.env` and a restart. In code, `getJupiterReferralParams` (`tools/wallet.js`) returns null at 0, so the order goes out without `referralAccount`/`referralFee`; nothing else changes. Values 1–49 are also ignored, but with a warning on every swap, so use 0. `envcrypt.js` loads `.env` with `override: false`, so a value in the pm2 environment would win: check `pm2 env <id> | grep -c '^JUPITER_REFERRAL'` (expect 0), and after the restart `node -e 'import("./envcrypt.js").then(()=>import("./config.js")).then((m)=>{console.log("referralFeeBps:",m.config.jupiter.referralFeeBps);process.exit(0)})'` (expect 0). Recorded PnL does not change, so the 2026-10-30 evaluation is unaffected; the wallet keeps about $115 a month at the current volume. **Done 2026-10-17:** the user ran the steps (`.env` line, pm2 environment count, restart, config one-liner) and reported the result as 0; the exact outputs were not pasted. No log line shows the fee applied to an auto-swap (`[SWAP] SUCCESS` carries only the tx, and `fee_bps_applied` / `amount_out` exist only in `swapToken`'s return value, which the auto-swap paths in `tools/executor.js` do not log), so the config check is the only evidence until the `swap_detail` line below is live. **Slippage was unmeasured:** at the measured volume (about $23.8K a month) each 1% of average slippage would be about $238 a month, against $119 for the fee; there is no data on the real figure. **Log added the same day:** the `swap_detail` line (see "Swap Safety") records the amounts, the quote and the fee for every swap; the first read is at the 2026-10-30 evaluation, with the rule fixed beforehand. **First line seen 2026-10-17 04:33Z, and a correction:** `fee_bps` was 10, and while the referral was on it was exactly 50, so the referral replaced Jupiter's own fee instead of adding to it. Turning it off saves 40 bps, at most $95.10 per 31 days (29% of the recorded PnL), not $118.88 (36%); the other 10 bps (about $24 per 31 days) is Jupiter's and was already inside the 50 ($118.88 = about $24 to Jupiter + about $95 to the referral account). "At most" because a token under 24h old may carry a 50 bps base fee that the referral did not raise; the real saving is Σ volume × (50 − `fee_bps`) from the new lines, which `diag-swap-recv.mjs` prints.
  3. Trailing floor 3 (manual setting, see "Trailing exits use a 3.00-point give-back floor").
  4. Never-green stop losses: the curve fee/TVL <0.3 hold-out, and part 2 of the evaluation (segments, curve vs bid_ask by vol band, `diag-breakeven`, `diag-edge`).
  5. Idle capital: time out of range (`minutes_in_range` vs `minutes_held`), Rule 4 waiting 90m above range, failed wide deploys.
  - Reading note: `pnl_pct` / `pnl_usd` are in USD, so they include SOL/USD drift during the hold, while the bot's capital sits in SOL.
- **Stop loss vs entry features: checked 2026-10-16 (`diag-sl-entry.mjs`, closes since 09-30, 363 curve/bid_ask closes, total +$162, 75 segments). No screener change.** Rule (fixed before the result): n≥40, total $ negative with a 95% bootstrap upper bound <0, avg % <0, negative in both time halves (n≥15 each), and worse than the other positions (the 95% interval of n × (mean $ of the rest − mean $ of the segment) above 0). Result: no segment passes.
  - **Where the stop-loss money is.** 40 stop losses (11% of closes), −$664. 22 had peaked ≥1%: −$383 (58%), the exit side (see "Break-even never closes a position"). 18 never reached 1%: −$282 (42%), the only part the screener can touch. This replaces the earlier estimates of about −$215 and −$175, which were derived by subtraction from the 14-day total. The script excluded 3 closed records with the bogus `PnL -100.00%` reason.
  - **The 18 never-green stops.** 15 curve; 12 with volatility <2.5 (8 at 1.7–2.1); 7 curve with fee/TVL <0.3; 11 with mcap 1–3M. They never reached +1% and were held a median of about 130 minutes. The flow label does not separate them (BULLISH_MIXED 5, MARKUP 5, MIXED 4, EXHAUSTION 2, NEUTRAL 1, BEARISH_MIXED 1).
  - **flow EXHAUSTION: closed, not blocked.** n=60, −$23 [−168..+110], stop loss 12% (baseline 11%), halves −$83 / +$60. The 10-05 signal (n=18, −$100, 28%) did not replicate: the other 42 made about +$77. CAPITULATION n=14, +$3, below the n≥40 bar. Neither goes into `entryFlowBlockRegimes`.
  - **Hold-outs, decided at the 2026-10-30 evaluation on closes after 2026-10-16 only** (`node diag-sl-entry.mjs 2026-10-16`; read only the rows named here, since the table lists 75). Rule for 1 and 2: the clauses above plus at least 15 distinct tokens and no single token above 25% of the segment's loss, because the bot re-enters the same tokens (TWEETCRAFT ×2 and DOPE ×2 among the 18); those two clauses need a v2 of the script, written at that evaluation with a shorter output (negative-total segments only) and no Δ-replaced when the complement has fewer than 30 positions. If a hold-out passes, propose the smallest filter to the user; nothing is decided now.
    1. **curve & fee/TVL <0.3**: n=52, −$67 [−146..+10], halves −3 / −64, stop loss 19% (rest 10%), Δ-replaced +$105 [12..204]. Fails only on the upper bound. Same candidate as the part-1 bullet (`curveMinFeeActiveTvlRatio`; the key does not exist in code). 5 closes so far after 10-16.
    2. **mcap 1–3M**: n=113, −$106 [−278..+55], halves −15 / −90, stop loss 17% (rest 8%, z=2.4), Δ-replaced +$226 [19..438]; holds 11 of the 18 never-green stops. Fails on the upper bound. Not an independent replication: the 10-05 60-day scan had this band at −$134 with a first half of +$26 (the loss is from recent weeks), and the windows overlap by a week. The mcap rank-correlation test (r=−0.02) does not test a trough.
    3. **curve entered after a falling coin** (return over the 6 hours before entry <0), the 10-02 hypothesis (−0.36%, n=137 vs +1.19%, n=142). Check on positions opened after 10-16 with the existing `node diag-ohlcv.mjs 16` then `node diag-impulse.mjs 14` (table C, curve rows). Replicated only if the "<0%" bucket has n≥60, its average is at least 1.0 point lower than the ≥0 buckets, and the difference is above 1.96 combined standard errors.
  - **Not decisions, for information.** curve & vol <2 & fee/TVL <0.3: n=31, −$70 [−133..−12], halves −28 / −41, stop loss 26% (a subset of hold-out 1, chosen after seeing the data). vol 1.5–2.0: stop loss 27% (z=3.7) but total −$27, so the stops are offset by winners in the band: an exit or strategy question, not a screener one. Tokens with a loss in the previous 48h: n=116, −$63 [−230..+97]. Segments with a tiny complement (for example "net buyers 1j ≥0", 354 of 363) give a meaningless Δ-replaced; ignore them.
  - **Caveats.** 75 segments were tested at once, so about 2 can look negative by chance. Positions are not independent (the same tokens are re-entered), so the z-values are optimistic. If the effects are real, waiting two weeks forgoes up to roughly the Δ-replaced central estimates (+$105 and +$226 per 17 days, overlapping); acting now would need new config keys on borderline evidence.
- **Tighter stop loss when fees are low: the version that reads the fee at the stop is rejected (2026-10-16, `diag-sl-fee.mjs`, closes since 09-30, 365 curve/bid_ask closes, 3 bogus −100% stops excluded); the version that reads the fee before the drop is untested (2026-10-17, see the last three sub-bullets). No change.**
  - Idea (user): when a position never went green (peak < 1%) or peaked only 1–3% and its fees are low, stop it earlier. "Low fee" used the bot's own low-yield definition: fee rate at close (fees ÷ initial value × 1440 ÷ minutes held × 100) below `minFeePerTvl24h` (live 5, code default 7).
  - Rule, set before the result, per group: ≥10 stops of which ≥60% low-fee; AUC ≥ 0.65 (stops have lower fee rates than the group's other closes); savings upper bound ≥ $50 for a stop at −3%. Both groups fail all three clauses.
  - Never green (120 closes): 18 stops, −$282, fee rate median 40%/24h, **0 of 18 low-fee**, AUC 0.09. The low-fee positions are the low-yield closes (22, −$6) and other closes (80, −$67, median 3.1%).
  - Peak 1–3% (82 closes): 23 stops, −$391, median 35.7%, 0 of 23 low-fee, AUC 0.16. Other closes +$72, low yield +$11.
  - Reading: stops are the opposite of low-fee. A dump through the range trades heavily against the position, so it earns a lot of fee while price falls faster than fees can make up. A low-fee condition would never fire on them; a tight stop on low-fee positions would only cut positions that end near flat (worst case −$308 at −3% for never green, saving $0), which the existing low-yield exit already closes cheaply. The rate is measured at close and is inflated for short holds (5 and 3 of the stops were under 60 minutes), which does not change "0 low-fee".
  - "High fee + falling PnL" was noticed only after seeing the data, and that fee is earned during the dump itself, so it does not lead the stop. Not pursued.
  - Most of the stop-loss money is in the peak 1–3% stops, which the break-even probe already measures (`be_probe`, decision about 2026-10-30). 41 stops here vs 40 in `diag-sl-entry.mjs`: closes kept coming in between the two runs.
  - **Erratum 2026-10-17 (the user asked what exactly was measured).** `diag-sl-fee.mjs` read the fee over the whole life of the closed position (`fees_earned_usd` ÷ `initial_value_usd` × 1440 ÷ `minutes_held`), so the fee "at the stop" includes what was earned during the final dump. It rejects a rule that waits for low fee at the stop. It says nothing about low fee before the drop, which is what the idea was (never green and little fee so far, so tighten the stop). Labelling the idea "rejected" was too strong. Mechanism guess, not evidence: low fee usually means the position has not been activated (price has not entered the range), so there is nothing to cut; the case that fits the idea is an idle position that one dump then sweeps through.
  - **Leading-version test: `diag-sl-fee2.mjs` (read-only; written 2026-10-17, not yet run on the live server).** Data: `pool-memory.json` snapshots (one per management cycle: PnL, unclaimed fees, age; the last 48 per pool, about 4–8 hours) joined by position address to the `lessons.json` close record. Coverage is partial by construction: only the latest positions of each pool, 10-minute resolution, and anything overwritten is gone. Closed curve/bid_ask positions since 09-30 count if the first snapshot is at most 25 minutes old (a path that starts at the opening). The hypothetical exit is the first snapshot with age ≥ `minAgeBeforeStopLoss` (15m) and PnL ≤ T (T = −3 main, −5 information), charged 0.5 points. Group = tracked peak at that moment (exact when the final peak was reached before the trigger, else the snapshot maximum, never above the final peak): never green (< 1%) or 1–3%. Fee so far = running maximum of the unclaimed fees up to that snapshot, as % of `initial_value_usd`, so a claim or a falling token price cannot make a position look low-fee (claims start at `minClaimAmount`, default 5, far above the low-fee bar). Low = below `minFeePerTvl24h` × age ÷ 1440, the bot's own low-yield rate scaled to the age (fixed before any result). Δ$ = value at the exit − actual outcome, summed over triggered positions; reported at the snapshot value (pessimistic, decides) and at T − 0.5 (optimistic, because the 30s poll exits near the threshold). Interval: 90% bootstrap, 2000 resamples, fixed generator. Tested on synthetic data: 38 checks, 23 deliberate breakages all caught, 10 end-to-end CLI checks.
  - **Rule, set 2026-10-17 before any result** (the same text is in the script header). At T = −3, per group. Idea II (the user's: tight stop only when the fee so far is low) passes only if: (a) at least 15 triggered positions with low fee; (b) Δ$ at the snapshot value is positive with the 90% lower bound above 0; (c) Δ$ is positive in both halves by close time, at least 5 positions in each; (d) the mean Δ$ per position is higher for low fee than for high fee, with at least 5 high-fee positions to compare (otherwise the fee condition adds nothing, or cannot be judged). Pass means a record-only probe on new data as a hold-out, like `be_probe`, never a live change from this sample. If (b) or (c) fails at the snapshot value but all of (a)–(d) hold at the optimistic exit: uncertain, next step the probe (user decides). Fewer than 15 low-fee positions, fewer than 5 high-fee, or fewer than 40 closes with a full path: not enough data, next step the probe (user decides). Anything else closes the leading version for that group. Idea I (a tight stop for every triggered position, no fee condition) is reported with (a)–(c) only and labelled exploratory; it can only lead to the same probe. Four verdicts (2 groups × 2 ideas), so one chance pass would not be surprising. Expectation written beforehand: coverage is likely thin, so "not enough data" is the most probable outcome.
- **OKX enrichment is dead on the live server (checked 2026-10-16 with `diag-okx-cover.mjs`). Not restored; no code change.**
  - **Result.** From the live server, through the bot's own `tools/okx.js`: `advanced-info`, `price-info` and `cluster-list` fail with HTTP 402 (payment required) in every probe, one at a time and in a burst of 24 calls (every failure message shown was 402), so it is not a rate limit. `risk-check` works (2 of 2 one at a time, and 6 successes in the burst, matching its 6 calls). The Agent Meridian route `/okx/enrich/<mint>` answers HTTP 410 `OKX enrichment deprecated — use local screening signals`. No OKX keys are in the shell environment or `.env`; the pm2 process environment was not checked (it carried a stale LPAGENT key before; count with `pm2 env <id>` piped to `grep -c '^OKX'`, which prints only a number). The logs show the three endpoints "unavailable" on every day since at least 09-16 (about 340–1,200 lines a day; the script's default window is 30 days, which is why it starts on 09-16, so the onset is not dated; older logs may exist, see `diag-okx-impact.mjs` below). `risk-check` failures begin on 09-28 (109 that day, 270 on 09-29, 1–45 a day since 10-10), the date of the over-fetch commit; the cause is unknown because the error text is not logged. In `lessons.json` no close carries `bundle_pct` or `price_vs_ath_pct` (0% in every week, while `top10_pct` and `bot_holders_pct` are 100%).
  - **Corrections to the first write-up.** The script's automatic verdict said "network errors or timeouts", which was wrong: the decision rule had no branch for other HTTP statuses, so every failure without 401/403/key words fell into the network branch. The messages (`OKX API 402`, HTTP 410) are the reading. The rate-limit idea (the 09-28 over-fetch doubling the parallel calls) is rejected for the three dead endpoints because the failures are deterministic. The idea that missing OKX data raised the curve share is not supported: weekly curve share was 71, 58, 58, 55, 50, 50, 36, 43, 49, 49, 48% from W31 to W41 and 76% in W42 (5 days, n=96) while OKX was down throughout; the volatility mix is the more likely driver.
  - **What is inert.** `bundle_pct`, sniper/suspicious % and `risk_level`, and with them the bundle filter (`maxBundlePct`); `price_vs_ath_pct` and the ATH filter (`athFilterPct`, off by default); `top_cluster_trend`, so the bid_ask exception for a bullish cluster never fires and low-volatility candidates are always curve; the tags `smart_money_buy`, `dex_boost`, `dev_sold_all`, `dex_screener_paid` and the KOL-cluster flag. Because `smart_money_buy` is never set, a rugpull-flagged pool is always dropped (stricter than intended, harmless). **What still works:** the wash-trading and rugpull filters (`risk-check`), except for candidates whose risk-check call fails (fail-open).
  - **Why nothing is changed.** The stop-loss share is 11% since 09-30 against 9% in the 60 days before; whether the inputs were alive during those 60 days is unknown. No data shows these inputs drive stops: they were never recorded, so none of the audit-field analyses can be done. The server's own message points to local screening signals (top10, bots, token fees, `active_pct`, `unique_traders`, fee/TVL), which the bot already uses. The prompt says "fail-open if missing" for bundle and rugpull. **Erratum 2026-10-16:** a candidate block says `okx: unavailable` only when `risk-check` failed too (about 6% of candidates lately). Otherwise it shows `okx: rugpull=NO, wash=NO` (index.js `okxParts`), and the missing `bundle=` / `sniper=` / `risk=` / ATH parts are not flagged as missing.
  - **Decision 2026-10-16 (user): leave OKX as is (option A).** No keys, no code or config change, no further OKX probes. Considered and not done: (B) OKX API keys (`OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `OKX_PROJECT_ID` in `.env`; untested whether keys avoid the 402); (C) local replacements for the inert signals (no evidence of value); (D) skipping the three dead calls (saves at most about 60 requests and some log lines per screening cycle, not worth a change). Reopen only on new evidence (a rug-grade loss, PnL ≤ −25%, on a token whose bundle share the filter could have checked) or if the user wants to try keys.
  - **Follow-up 2026-10-16: do exits or the screener depend on the missing data? (code audit; no outcome data exists)**
    - **Exits: no.** No exit rule (stop-loss tiers, early dump, break-even, trailing, Rules 1–11, the `state.js` exits) reads an OKX field. The OKX names outside screening are `top_cluster_trend` (an LLM-supplied `deploy_position` argument that `trackPosition` stores and nothing reads afterwards) and the LPAgent relay close in `tools/dlmm.js` (`provider: "OKX"` for the swap leg of the zap-out). The relay runs only when `lpAgentRelayEnabled` is true (code default false; the live value was not read, but every successful close in the close-cost check was a single transaction, which fits the SDK path), and a relay failure before submit falls back to the local close.
    - **Screener: yes, in bounded ways whose size cannot be measured.** (1) The bundle filter is the one hard filter lost. (2) The bid_ask exception for a bullish cluster can only move a deploy with volatility in (`curveMaxVolatility` − 1, `curveMaxVolatility`] from curve to bid_ask, and only if the LLM passes `top_cluster_trend` (the executor trusts the argument and checks it against nothing, so a spurious `bullish` would relax the guard with no data behind it). It was fragile even when OKX worked: the candidate line prints `top_cluster=` only when `price_vs_ath_pct` exists (both price-info and cluster-list had to answer), and the code comment says the trend is `buy|sell|neutral` while the tool enum is `bullish|bearish|neutral` (not checked which strings OKX returns). (3) The overrides that need `smart_money_buy` or a KOL cluster (rugpull override, volume-collapse override) never fire, so the bot is stricter, not riskier. (4) The dev blocklist is mostly intact: Jupiter's `dev` is the primary source and OKX `creator` only a fallback. (5) The LLM sees no tags and no ATH line, and cannot tell that bundle was not checked (see the erratum above). (6) The prompt tags `is_honeypot`, `low_liquidity` and `dev_buying_more` are never passed to candidates, even when OKX works.
    - **Still working:** the wash and rugpull flags (`risk-check` is a `/priapi/` endpoint, a different family from the three that return 402), top10, bot holders, token fees, blocklists and the flow filters.
    - **What the 402 is (OKX's own skill files, `okx/onchainos-skills` on GitHub; the pricing page itself was not reachable from the sandbox, so treat the numbers as defaults).** The Market API has a monthly free quota per account, then per-call pricing paid through x402 (OKX calls it the Agent Payments Protocol; USDG or USDT on X Layer). Defaults in the skill file: Basic 1M calls/month free, Premium 100K/month free, overage $0.0001 and $0.005 per call; existing users had a 30-day grace (fallback end date 2026-05-31). Which endpoint is Basic or Premium is not stated. The bot has no payment signer, so a 402 is only an error and nothing can be charged. The logs imply at most about 1,200 failed calls a day over the three endpoints (about 36K a month), under 100K, so an account's free quota would probably cover the bot, if the quota applies to API-key requests (untested).
    - **If reopened (the decision above stands; this is only the groundwork).** Wait for the end of the 2026-10-30 hold-out window: restoring OKX would change the entry mix (bundle filter) and the strategy mix in the exception band while the be_probe and the three hold-outs are measured. Test keys outside the bot first: give them only to the probe command's environment (the running bot reads `.env` once, at start, so keys in `.env` go live on the next restart, whatever the reason for it). If they work, restore with `maxBundlePct: 100` for the first two weeks (record only; `null` does not disable the filter because `config.js` does `u.maxBundlePct ?? 30`), then judge the bundle bands from the recorded `bundle_pct`. `diag-okx-cover.mjs` needs its HTTP 402 / 429 verdict branch before that test.
    - **`diag-okx-impact.mjs`** (read-only, not in the repo, 90 days of logs by default) dates the onset, counts what the bundle filter dropped per day while the data existed, shows the share of closes in the exception band by month (curve vs bid_ask), the `top_cluster_trend` values in `state.json`, and prints the relay flag. No decision rule: it dates and sizes, and does not test PnL. Tested on synthetic data (expected counts matched, empty and corrupt inputs handled). Delivered to the user on 2026-10-16; no result is recorded, because the user chose to leave OKX. Run it only if the question is reopened.
  - **Doc fixes the same day.** The "Bundler Detection" section and the key `maxBundlersPct` described a local detection (`common_funder`, `funded_same_window`) that does not exist in the code; the real key is `maxBundlePct` (OKX). The README still lists `maxBundlersPct` in its config table and was not touched.
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
- **Close tx expiry (observed 2026-09-29, not changed).** 6 of about 75 close attempts in 3 days failed with `block height exceeded`, 6–30s after the tx was built. The retry landed within 3–60s every time. The bot sets no priority fee, and neither does the DLMM SDK. e/acc-SOL (a rug) expired twice and took about 90s to close. Revisit (priority fee or a resend loop) only if expiries grow or start costing measurable PnL. Re-checked 2026-10-16: 10.4% of close attempts failed excluding the bogus −100% ones (17/164), against 8% on 09-29. Still not changed; see "Close failures" under the 2026-10-16 evaluation.
- **Security audit findings not yet patched** (surfaced 2026-09-28, deferred by user choice — swap-cap and secret-file-permission fixes were prioritized instead):
  - `envcrypt.js` "encryption" is a repeating-key XOR cipher, not real encryption. **Left as is (re-checked 2026-09-29):** the key (`.envrypt` / `ENVRYPT_KEY`) lives on the same host as `.env`, so authenticated encryption would add little. The real protection is `chmod 600` on `.env` / `user-config.json` (see Secret File Permissions).
  - ~~Telegram token leaking into logs.~~ **Downgraded to low risk (re-checked 2026-09-29).**
    - `telegram.js` embeds the bot token in request URLs, but every error log writes only `e.message` or the Telegram response body, never the URL.
    - Node's fetch network error message is just `fetch failed`; the URL lives in `e.cause`, which is not logged.
    - A grep of the live `logs/` and `~/.pm2/logs/` for the token pattern found nothing.
    - Only revisit this if a log line ever includes `e.cause` or a request URL.
  - ~~HiveMind prompt injection.~~ **Fixed 2026-09-29:** shared lessons are off by default (see HiveMind section).
  - ~~Caret ranges on wallet deps.~~ **Fixed 2026-09-29:** `@solana/web3.js` 1.98.4, `bn.js` 5.2.3 and `bs58` 5.0.0 are exact-pinned in `package.json` and the lockfile root, matching the versions already installed.
