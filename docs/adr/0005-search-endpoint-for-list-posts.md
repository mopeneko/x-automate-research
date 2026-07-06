# Fetch list posts via Get Search Results, not Get List Tweets

We switched from SocialData's `Get List Tweets` endpoint to `Get Search Results` (`/twitter/search?query=list:ID since_id:X`) so that `since_id` is applied as a **server-side filter**: only newly-published posts are returned and billed, instead of fetching page 1 of the list timeline (~20 posts) every poll regardless of newness. Both endpoints charge $0.0002 per retrieved tweet and return identical tweet objects — the savings come purely from the server filtering out already-billed posts before retrieval. Updates ADR-0001's consequence ("we must implement since_id-based pagination ourselves"): `since_id` is now a server operator, not client-side dedup.

## Consequences

- Query is `list:{listId} since_id:{cursor.sinceId}` with `type=Latest`. The `since_id:` operator is exclusive, matching the prior `t.id_str <= sinceId` stop semantics. Cursor persistence (`cursor.json`) is unchanged.
- Reply filtering stays client-side (`!p.isReply`); `-filter:replies` is not used because replies are <5% of list posts and the operator's self-reply semantics are undocumented.
- First-run bootstrap fetches page 1 only (no `since_id:` operator), setting the cursor to the newest id — a behavior change from the prior code, which paginated the entire list history when `sinceId=null`.
- We accepted the risk that `list:` (search) and the list timeline (Get List Tweets) may return slightly different post sets (different ingestion paths) without parallel-run validation.
