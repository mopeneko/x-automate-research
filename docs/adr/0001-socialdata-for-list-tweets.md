# Fetch list tweets via SocialData.tools, not the official X API

The official X API's pay-per-use pricing charges $0.005 per post read for `GET /2/lists/{id}/tweets` (~$75/month at 500 posts/day). We chose SocialData.tools' `Get List Tweets` endpoint at $0.0002 per post (~$3/month equivalent), accepting that the list must be **public** and that the service can break when X changes its internals.

This was a real trade-off: the user has no X API tier, has a manual fallback if the automation breaks (so downtime risk is tolerable), and cost was the priority. We rejected user-level fetching because SocialData's per-resource price is identical across endpoints, so it only adds implementation complexity (per-user `since_id` management) without saving money.

## Consequences

- The X List must be set to public, exposing its membership to other users.
- We must implement `since_id`-based pagination ourselves; SocialData has no deduplication, so every fetched post is billed.
- The fetcher should be isolated behind an interface so we can swap providers (official API, self-scraping) without rewriting the summarization pipeline.
