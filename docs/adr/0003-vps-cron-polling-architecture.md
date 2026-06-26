# VPS + cron polling architecture

The program runs as a single long-lived process driven by **cron** on a VPS, **polling** SocialData's `Get List Tweets` every **15 minutes** and accumulating posts into a local Tweet Store, rather than fetching an entire window's posts in one shot at each send time.

We rejected window-edge bulk fetching (hit the API only at 12:30/16:30/24:00/06:00) because a financial list can produce hundreds to thousands of posts in a 6.5-hour window; retrieving that backlog in one call risks X's list-timeline display caps, requires many paginated calls, and loses the whole window if the single fetch fails. Polling every 15 minutes keeps each fetch small (tens of posts), bounds data loss to ≤15 min on failure, and lets the Daily Summary be rebuilt from accumulated posts without re-fetching.

## Consequences

- State to persist on the VPS: the Fetch Cursor (`since_id`), accumulated posts, and per-window summaries. A local file or SQLite suffices — no external DB needed.
- Two cron entries: a 15-minute poll job, and a send-time job at 06:00/12:30/16:30/24:00 (the poll job still runs at those times; the send job reads the store, slices the just-ended window, summarizes, and sends).
- Time zone: the VPS must run in JST (or cron times must be expressed in JST) so window boundaries align with the user's market-session labels.
- Polling cost is bounded by `since_id`: only newly appeared posts are billed, so 15-min vs 30-min cadence changes latency/failure-loss, not API spend.
