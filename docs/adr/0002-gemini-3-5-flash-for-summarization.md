# Summarize with Gemini 3.8 Flash

> **Updated 2026-09-04:** primary model upgraded from Gemini 3.5 Flash → **Gemini 3.8 Flash** (`gemini-3.8-flash`). Filename kept for stable links.

We chose **Gemini 3.8 Flash** (released September 2, 2026) as the Summarizer over both cheaper Flash variants and more expensive frontier models.

3.8 is the current Flash workhorse at the same introductory price as 3.7 ($0.75 / $3.75 per 1M tokens through 2026-12-31), with stronger multi-step reasoning — useful for extracting market signals from financial tweeters. For a summary task, paying Opus/GPT frontier prices would be overkill, while older Flash generations (3.5 / 3.1) remain capacity fallbacks only.

## Context

- **1M token input context** lets us feed an entire window's tweets (and, for the Daily Summary, all three sub-window summaries) in a single request — no chunking or map-reduce pipeline.
- **64K token output** is ample for a window summary.
- **thinking levels** (`low` / `medium` / `high`) replace the older integer `thinkingBudget` on 3.8+; we run `medium` for primary summaries and `low` on profile fallback (3.8 cannot disable thinking). Older fallback models still use `thinkingBudget`.
- At our workload (~2.1M input + ~75K output tokens/month), cost remains on the order of a few dollars/month — comparable to the SocialData fetch cost and negligible versus the value delivered.

## Considered options

- **Gemini 3.5 Flash** — previous primary; still the first capacity fallback.
- **Gemini 3.1 Flash** — cheaper but an older generation; weaker on finance/long-context benchmarks.
- **Claude Sonnet / GPT frontier** — strong summarization but higher cost and no advantage for this volume/shape of work.

## Consequences

- We depend on the Google Gemini API; 3.8 rejects `thinkingBudget` and deprecates sampling knobs like `temperature`, so `callGemini` branches on `usesThinkingLevel(model)`.
- `gemini-3.8-flash` can still be capacity-sensitive during US daytime, which overlaps the JST 00:00 夜場/Daily send. The runtime therefore treats 503/429 as capacity errors: longer backoff, no wasted thinking-profile switches, and automatic fallback across Flash models (`3.8` → `3.5` → `3.1` → `2.5`) before surfacing an Error Notification.
- For the Daily Summary, we feed the three intraday summaries as context rather than re-feeding all raw tweets, keeping token usage flat regardless of tweet volume.
