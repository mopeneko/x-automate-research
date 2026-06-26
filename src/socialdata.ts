import type { Tweet } from "./types.ts";
import { POLL_MAX_PAGES } from "./config.ts";

/**
 * SocialData.tools client. `Get List Tweets` has no since_id parameter; pagination
 * is via cursor/next_cursor. We fetch pages newest-first and stop once we reach a
 * post already seen (by Snowflake id), so only genuinely new posts are billed.
 * See ADR-0001.
 */

const BASE = "https://api.socialdata.tools/twitter/list";

interface SocialDataTweet {
  id_str: string;
  full_text: string | null;
  text?: string | null;
  tweet_created_at: string;
  in_reply_to_status_id_str: string | null;
  is_quote_status: boolean;
  retweeted_status: unknown | null;
  quoted_status: unknown | null;
  user?: { screen_name: string };
}

interface SocialDataResponse {
  tweets: SocialDataTweet[];
  next_cursor?: string | null;
}

export class SocialDataClient {
  constructor(private apiKey: string, private listId: string) {}

  /**
   * Fetch all posts newer than `sinceId` (exclusive). Returns newest-first.
   * Stops paginating when a post id <= sinceId is encountered, or after POLL_MAX_PAGES.
   */
  async fetchNewPosts(sinceId: string | null): Promise<Tweet[]> {
    const collected: Tweet[] = [];
    let cursor: string | undefined = undefined;
    let newestId: string | null = sinceId;

    for (let page = 0; page < POLL_MAX_PAGES; page++) {
      const url = new URL(`${BASE}/${this.listId}/tweets`);
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`SocialData ${res.status}: ${body.slice(0, 500)}`);
      }
      const data = (await res.json()) as SocialDataResponse;

      let reachedOld = false;
      for (const t of data.tweets ?? []) {
        // Snowflake ids are lexicographically monotonic — string compare works.
        if (sinceId != null && t.id_str <= sinceId) {
          reachedOld = true;
          break;
        }
        collected.push(toTweet(t));
        if (!newestId || t.id_str > newestId) newestId = t.id_str;
      }

      if (reachedOld) break;
      if (!data.next_cursor) break;
      cursor = data.next_cursor;
    }

    // collected is newest-first per page; keep newest-first globally.
    collected.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return collected;
  }

  /** The newest id among fetched posts, to persist as the Fetch Cursor. */
  static newestId(posts: Tweet[], fallback: string | null): string | null {
    if (posts.length === 0) return fallback;
    return posts.reduce((max, p) => (p.id > max ? p.id : max), posts[0]!.id);
  }
}

function toTweet(t: SocialDataTweet): Tweet {
  return {
    id: t.id_str,
    text: t.full_text ?? t.text ?? "",
    createdAt: t.tweet_created_at,
    author: t.user?.screen_name ?? "",
    isReply: t.in_reply_to_status_id_str != null,
    isRetweet: t.retweeted_status != null,
    isQuote: !!t.is_quote_status || t.quoted_status != null,
  };
}
