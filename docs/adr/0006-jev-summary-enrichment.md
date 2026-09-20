# ADR-0006: Optional Jev annotations before summarization

## Status

Superseded as default by ADR-0007. Retained as explicit `JEV_MODE=annotate` for comparison.

## Context

The Summarizer currently selects and interprets all posts while generating prose.
We want to try explicit labels for post kind, event category, and stated evidence
without dropping important image-only posts or introducing a delivery dependency.

## Decision

- Keep Gemini as Summarizer and image reader. Use TypeSafe's text-only Choice API
  for three narrow classifications. Do not ask Jev to generate summaries, verify
  facts, predict market returns, count items, or reconstruct numeric values.
- Opt in with `JEV_ENABLED=true` and `TYPESAFE_API_KEY`; pin `jev-1.13.0` by default.
- Preserve every original input and its order. Only append controlled labels;
  low-confidence dimensions become "判断保留". Do not introduce semantic deduplication
  or sentiment counts in this initial implementation.
- Supply the same labels to Window and Daily summaries, with instructions to
  prefer source text/images and preserve the Pipeline's output schema.
- Cache successful annotations by Pipeline/date/full input/model/schema hash.
  Preserve post ID, actual response model, classification time, and distributions.
  Raw Tweet Store records are unchanged. Cache files use unique temporary files
  and atomic rename. Cache I/O errors do not prevent summarization.
- Bound request size and concurrency (8 posts, about 18KB text, 3 workers) and
  use a shared 60-second API deadline. Stop dispatching on API errors; no automatic
  retries. Failed/unprocessed posts remain unannotated. Successful batches can
  still contribute annotations. Logs contain counts rather than source text,
  upstream error bodies, or keys.
- Add a local comparison command that calls Gemini with and without annotations
  using the same stored inputs and saves both outputs; it never sends Telegram.

## Consequences

This may improve distinctions between reports, speculation, and reactions, but
quality gains are not established. Japanese-language accuracy and the provisional
0.7 confidence threshold need evaluation. Classification and extra Gemini input
increase cost. Labeling cannot replace source verification or fix image-reading
errors. Cache retention follows operator-managed data retention; aliases can
mix historical model versions, so a pinned model is preferred.

API keys are not available during implementation. Tests mock HTTP responses,
including timeouts, malformed output, cache reuse, and end-to-end prompt assembly.
The first live comparison must be performed after setting the API key.

## References

- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/confidence
- https://docs.typesafe.ai/model-jaggedness/jev-1.13
