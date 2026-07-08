# Multi-Pipeline architecture (independent per-list processing)

The program runs **N independent Pipelines**, one per configured X List, instead of a single implicit pipeline for one fixed list. Each Pipeline is a self-contained bundle — one X List (input), one Telegram chat (output), its own Tweet Store + Fetch Cursor (state), and optionally a Pipeline System Prompt — sharing the same Summary Window set and Summarizer backend with all other Pipelines.

We rejected two alternative shapes for handling a second list:

- **Same Telegram chat, separate messages per list (Pattern B)** — one shared destination, but a reader scanning a chat cannot tell which list a given summary came from without inspecting a header. For market-summary content where the reader's attention is fragile, list-attribution friction lowers the value of every message.
- **Combined summary (Pattern C)** — merge multiple lists' posts into one Window Summary. The Summary Schema (four fixed sections, tickers preserved verbatim) assumes a single coherent information source; merging heterogeneous lists would either dilute the signal (everything looks like a blended average) or force a schema redesign. The output shape stays correct only if each Pipeline owns its own summary end-to-end.

Pattern A was chosen because each Pipeline is conceptually a complete independent product. Failures isolate naturally (one broken list cannot suppress another's output), cost scales linearly and predictably (~$7/month per Pipeline at 500 posts/day), and the simplest future extension is additive — promote a shared constant (e.g., Summary Window set) to a per-Pipeline field when an actual second use case appears, without breaking existing Pipelines.

## Amendment: per-Pipeline System Prompt

A second list of crypto investors showed that sharing one Summarizer instruction is too strong a coupling: the Japanese-equities framing bleeds into unrelated domains even when the X List itself is correct. We therefore promote the Summarizer's system instruction to an optional per-Pipeline field (`systemPrompt` in `pipelines.json`).

When set, the Pipeline System Prompt **fully replaces** the default instruction — including the default Summary Schema — because append-only overrides cannot escape market assumptions baked into the base prompt, and heterogeneous lists legitimately need different section taxonomies (e.g. tokens/chains vs. 銘柄). Pipelines without the field keep the original Japanese-equities behavior. The Summarizer backend (Gemini) and Summary Window set remain shared; only the instruction becomes per-Pipeline. This matches ADR-0004's stated extension path ("promote a shared constant … when an actual second use case appears").

## Consequences

- **Configuration**: Pipelines are declared in a single `pipelines.json` at the repo root (an array of `{id, listId, telegramChatId, systemPrompt?}`). Adding a Pipeline is a one-entry file edit; no cron change is required. API keys and bot token remain in `.env` (shared across all Pipelines).
- **Storage**: Each Pipeline gets its own subdirectory under `STORE_DIR` (e.g., `store/<pipelineId>/`). Stores never share data. Pipeline identifier slugs must be filesystem-safe (`[a-z0-9-]+`).
- **Cron topology**: A single set of four cron entries (`*/15` poll + three sends) iterates over all Pipelines internally. Execution within one cron invocation is **sequential** with per-Pipeline error isolation: a failing Pipeline is logged and skipped, the loop continues, and the process exits 0 unless every Pipeline failed.
- **Failure notification**: Error Notifications go to the failed Pipeline's own chat. The 3-consecutive-poll-failure counter is **per-Pipeline** and persisted in that Pipeline's `cursor.json` (`consecutivePollFailures` field). Send-time retry exhaustion triggers an immediate per-Pipeline notification.
- **Cost**: SocialData fetch and Gemini summarize costs scale **linearly** with Pipeline count. No rate-limit concern under sequential execution, even with 3+ Pipelines.
- **Migration**: Big-bang cutover. Existing `store/*.json` moves into `store/main/`; legacy `SOCIALDATA_LIST_ID` / `TELEGRAM_CHAT_ID` env vars are removed. A single operator and one running Pipeline make a gradual transition's two-code-path complexity unjustified.
