# ADR-0007: Review summary claims against source text

## Status

Implemented; evaluation is a small development pilot, not a quality guarantee.
Supersedes ADR-0006 as the default Jev mode when enabled.

## Context

The user's two previews classified every post, but their summaries did not show
clear quality gains. Whole-post labels left about half of evidence dimensions
uncertain. Wording could still strengthen interpretation into fact. Independent
Gemini generations also confounded comparison with sampling variation.

## Decision

Use one ordinary Gemini draft, then Jev Choice checks for certainty inflation and
semantic changes per non-heading line. Retrieve bounded lexical source candidates
and preserve chronology. Route issue probability >=0.6 and unknown >=0.5 to one
Gemini repair request. Unknown means unresolved, not wrong. Reject numeric or
structural edits, and recheck against the same source candidate set. Adopt only
edits with clear >=0.6 on both checks. These thresholds are provisional routing
rules, not calibrated estimates of real-world correctness.

No original text or images are removed from initial generation. Review is text-only
and cannot certify numbers, image details, external truth or coverage. The repair
step conservatively preserves numbers and does not read images. It may leave an
existing error untouched. Lexical retrieval, mixed claims, and unknown image
content can produce misses and false positives.

Limit each audit to 48 lines, 3 concurrent requests and 60 seconds. Repair uses a
120-second budget, Standard capacity, and immediate capacity fallback across the existing Flash models.
Do not extend initial summary-generation timeouts. Preserve drafts on failures and
save explicit unavailable/partial/unresolved states. Preview stores a readable diff
and raw audit with candidate source IDs; a complete audit means responses arrived,
not that every claim is verified. Do not send Telegram during comparisons.

Retain legacy classification only under `JEV_MODE=annotate`. Disabled remains the
default unless the existing opt-in flag and key are supplied.

## Evaluation

Use saved September 19 previews as development examples and September 18 as a
second-day pilot. Source data and credentials stay outside the repository. Live
API results, including missed or rejected corrections, are reported separately;
there is no statistically supported accuracy or profitability claim.
