# Summarize with Gemini 3.5 Flash

We chose **Gemini 3.5 Flash** (released May 19, 2026) as the Summarizer over both cheaper Flash variants and more expensive frontier models.

The decisive factor was Google's model card: on **Finance Agent v2** (financial analysis and decision-making), Gemini 3.5 Flash scores **57.9%**, beating Claude Sonnet 4.6 (51.0%), Opus 4.7 (51.5%), and GPT-5.5 (51.8%). This benchmark maps directly to our use case — extracting market signals from financial tweeters. For a summary task, paying Opus/GPT-5.5-pro prices ($15-30/M input) would be overkill, while the older 3.1 Flash sacrifices quality we can get for ~$4/month.

## Context

- **1M token input context** lets us feed an entire window's tweets (and, for the Daily Summary, all three sub-window summaries) in a single request — no chunking or map-reduce pipeline.
- **64K token output** is ample for a window summary.
- **thinking levels** let us trade latency for quality per window; we can run cheaper/faster for the intraday windows and richer for the Daily.
- At our workload (~2.1M input + ~75K output tokens/month), cost is ~$3.8/month — comparable to the SocialData fetch cost and negligible versus the value delivered.

## Considered options

- **Gemini 3.1 Flash** — cheaper (~$1.3/mo) but an older generation; weaker on finance/long-context benchmarks.
- **Claude Sonnet 4.5** — strong Japanese summarization, ~$8/mo, but no 1M-context single-shot and lower Finance Agent score.
- **gpt-5.4-nano** — cheapest (~$0.55/mo) but lower quality on nuanced financial text.

## Consequences

- We depend on the Google Gemini API and its `thinking` config semantics; the summarizer interface should isolate model-specific parameters so a future swap is contained.
- For the Daily Summary, we feed the three intraday summaries as context rather than re-feeding all raw tweets, keeping token usage flat regardless of tweet volume.
