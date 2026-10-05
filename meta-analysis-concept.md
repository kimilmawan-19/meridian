# LLM-Based Meta-Analysis ("The Analyst") — Pending Implementation

Status: CONCEPT ONLY — not implemented. Approved for future execution.

---

## Problem

The current learning system (`lessons.js`) only finds patterns hardcoded in `derivLesson()` — 9 fixed `if/else` branches. The bot cannot discover unpredicted correlations, e.g.:

- "Pools deployed when `flow_regime=MARKUP` win 80%, but `NEUTRAL` only 30%"
- "bin_step 100 wins in high volatility but loses in low volatility"
- "All losses this week had `minutes_held < 20` — exiting too early"
- "Pools from launchpad X always rug within 1 hour"

Static heuristics will never find these. LLM can — because it reads raw data openly.

---

## Design Principles

**The Analyst is a 4th role, SEPARATE from SCREENER/MANAGER/GENERAL.** No on-chain access, no write tools. Single purpose: read performance data → propose new lessons.

Three mandatory safeguards:

1. **Human-in-the-loop** — LLM-proposed lessons enter `status: "proposed"` and are NOT used in production prompts until approved via Telegram.
2. **No threshold mutation** — `evolveThresholds()` (statistics) remains sole owner of config mutations. Analyst only produces text lessons, never changes numbers.
3. **Evidence-gated** — Analyst only runs when enough data exists (e.g. ≥15 closed positions since last run), preventing hallucination from tiny samples.

---

## Architecture

```
                          ┌─────────────────────────────┐
   weekly cron ─────────► │  runMetaAnalysis()          │
   or /analyze            │  (meta-analysis.js)         │
                          └──────────┬──────────────────┘
                                     │
              getDetailedPerformanceAnalysis()  ← already exists
              getPerformanceHistory({hours:168}) ← already exists
                                     │
                                     ▼
                    ┌────────────────────────────────┐
                    │  agentLoop(prompt, ANALYST)     │  ← new role, read-only
                    │  model: analysisModel           │
                    └────────────┬───────────────────┘
                                 │ structured JSON
                                 ▼
              proposeLesson(rule, tags, evidence, confidence)
                                 │
                                 ▼  status: "proposed"
              ┌──────────────────────────────────────┐
              │  Telegram: "💡 3 new lessons proposed" │
              │  /proposals → approve/reject          │
              └──────────────────────────────────────┘
                                 │ approve
                                 ▼
              addLesson(...) → enters getLessonsForPrompt() → SCREENER/MANAGER read
```

**Already available and ready to use:** `getDetailedPerformanceAnalysis()` (win rate, best3/worst3,
close reason frequency, bin_step buckets) and `getPerformanceHistory()` provide exactly the raw
data the Analyst needs. No new aggregation required.

---

## LLM Input

Analyst receives a **pre-computed data packet** (token-efficient, deterministic):

```
PERFORMANCE SUMMARY (30 days, 42 closed positions):
- Win rate: 45% | Avg win +6.2% | Avg loss -3.1%
- Avg hold: winner 85min, loser 22min
- Close reasons: trailing TP ×18, stop-loss ×11, OOR ×8, volume collapse ×5
- bin_step buckets: {80: -1.2% avg, 100: +3.4% avg, 125: +0.1% avg}

TOP 3: [pool, pnl, reason, hold, volatility, flow_regime at deploy...]
WORST 3: [...]

RAW DATA 42 POSITIONS (condensed CSV):
pool,strategy,bin_step,volatility,fee_tvl,organic,pnl_pct,range_eff,hold_min,close_reason,flow_regime,peak_pnl,tp_veto,partial_count
...
```

## LLM Output (strict JSON)

```json
{
  "patterns": [
    {
      "rule": "AVOID deploying when flow_regime=NEUTRAL — 8/10 such positions closed negative (avg -4%), vs 70% win rate in MARKUP.",
      "tags": ["flow_regime", "screener"],
      "role": "SCREENER",
      "confidence": 0.78,
      "evidence": "10 positions, flow=neutral, win_rate 20% vs 70% baseline",
      "sample_size": 10
    }
  ],
  "summary_for_telegram": "Hold winners longer; exiting losers too early (22min avg)."
}
```

Schema enforced via **prompt + JSON validation in code** — if LLM invents fields or
sample_size is below threshold, the lesson is rejected before it reaches the user.

---

## Files to Change (estimate)

| File | Change |
|---|---|
| `meta-analysis.js` (new) | `runMetaAnalysis()` — orchestration, JSON validation, evidence gating |
| `prompt.js` | Add `ANALYST` system prompt: "quantitative analyst, find patterns, no fabrication, need ≥N samples" |
| `agent.js` | Add `ANALYST` role + empty tool set (read-only) or only `get_performance_history` |
| `lessons.js` | `proposeLesson()`, `listProposed()`, `approveProposal(id)`, `rejectProposal(id)`; add `status: "proposed"\|"active"` field |
| `lessons.js getLessonsForPrompt` | Filter `status !== "proposed"` — proposals never leak to production before approval |
| `index.js` | Weekly cron + Telegram commands `/analyze`, `/proposals`, `/approve <n>`, `/reject <n>` |
| `config.js` | `metaAnalysis` config block (see below) |
| `telegram.js` | `notifyProposals()` |

---

## Config Block

```json
"metaAnalysis": {
  "enabled": false,
  "intervalDays": 7,
  "minNewSamples": 15,
  "analysisModel": "anthropic/claude-sonnet-4-6",
  "autoApprove": false,
  "maxProposalsPerRun": 3
}
```

- `autoApprove: false` (default) → human-in-the-loop, safest
- `autoApprove: true` → lessons activate immediately (still bounded by `maxProposalsPerRun`)
- Stronger model for Analyst is justified — runs weekly, deep analysis, token cost is small

---

## Safety Properties

- **No LLM → on-chain path.** Analyst produces text only.
- **Statistics still own the numbers.** `evolveThresholds()` untouched.
- **Hallucinations are isolated.** `proposed` lessons never enter production prompts without approval. Worst case: bad proposal visible in Telegram, rejected.
- **Reversible.** Approved a bad lesson? `removeLessonsByKeyword()` already exists.
- **Cheap.** Runs weekly, not every cycle.

---

## Implementation Phases

1. **Phase 1** — `runMetaAnalysis()` + `proposeLesson()` + Telegram manual review. Uses existing data. (~1 new file + edits to lessons.js, index.js, telegram.js)
2. **Phase 2** — Automatic cron + sample-size gating.
3. **Phase 3** (optional) — Analyst may *propose* threshold changes (e.g. "raise minOrganic to 65"), still via approve flow, then user runs `update_config` manually. Never automatic.
