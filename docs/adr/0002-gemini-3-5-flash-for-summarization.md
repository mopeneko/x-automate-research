# Summarize with Gemini 3.8 Flash (Flex)

> **Updated 2026-09-04:** primary model upgraded from Gemini 3.5 Flash → **Gemini 3.8 Flash** (`gemini-3.8-flash`). Filename kept for stable links.
> **Updated 2026-09-04:** primary traffic routed via **Flex** inference (`service_tier: flex`).

We chose **Gemini 3.8 Flash** (released September 2, 2026) as the Summarizer over both cheaper Flash variants and more expensive frontier models, and we run it on the **Flex** pay-as-you-go tier.

3.8 is the current Flash workhorse at the same introductory Standard price as 3.7 ($0.75 / $3.75 per 1M tokens through 2026-12-31), with stronger multi-step reasoning — useful for extracting market signals from financial tweeters. Flex cuts that in half (~50% discount) in exchange for best-effort availability and 1–15 minute target latency. For a summary task, paying Opus/GPT frontier prices would be overkill, while older Flash generations (3.5 / 3.1) remain capacity fallbacks only.

## Context

- **1M token input context** lets us feed an entire window's tweets (and, for the Daily Summary, all three sub-window summaries) in a single request — no chunking or map-reduce pipeline.
- **64K token output** is ample for a window summary.
- **thinking levels** (`low` / `medium` / `high`) replace the older integer `thinkingBudget` on 3.8+; we run `medium` for primary summaries and `low` on profile fallback (3.8 cannot disable thinking). Older fallback models still use `thinkingBudget`.
- **Flex** fits cron-driven window sends: we already wait minutes for capacity backoff, and Telegram delivery is not interactive. Client + `X-Server-Timeout` are set to 15 minutes so Flex queueing does not abort early.
- At our workload (~2.1M input + ~75K output tokens/month), Flex keeps summarizer spend on the order of a couple of dollars/month — comparable to or below the SocialData fetch cost.

## Considered options

- **Standard tier** — lower latency, full price; unnecessary for scheduled digests.
- **Batch API** — same ~50% discount but async job polling; worse fit for sequential 夜場→Daily chains.
- **Gemini 3.5 Flash** — previous primary; still the first capacity fallback.
- **Gemini 3.1 Flash** — cheaper but an older generation; weaker on finance/long-context benchmarks.
- **Claude Sonnet / GPT frontier** — strong summarization but higher cost and no advantage for this volume/shape of work.

## Consequences

- We depend on the Google Gemini API (paid tier required for Flex); 3.8 rejects `thinkingBudget` and deprecates sampling knobs like `temperature`, so `callGemini` branches on `usesThinkingLevel(model)`.
- Requests set `service_tier: "flex"`. Flex does **not** auto-upgrade to Standard when shed — capacity errors (503/429) retry the **same model** with exponential backoff (`15s → 45s → 120s → 180s`), skip useless thinking-profile switches, and only then fall back across Flash models (`3.8` → `3.5` → `3.1` → `2.5`) before surfacing an Error Notification.
- A single Flex call may sit in queue for minutes; 夜場+Daily across multiple Pipelines can therefore run longer than under Standard. Cron schedules should leave headroom (or accept delayed Telegram delivery).
- For the Daily Summary, we feed the three intraday summaries as context rather than re-feeding all raw tweets, keeping token usage flat regardless of tweet volume.
