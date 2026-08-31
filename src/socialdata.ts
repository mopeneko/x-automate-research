import type { Tweet } from "./types.ts";
import { POLL_MAX_PAGES } from "./config.ts";

/**
 * SocialData.tools client using Get Search Results. The `list:{listId} since_id:{id}`
 * query applies since_id as a server-side filter, so only newly-published posts are
 * returned and billed. Pagination is via cursor/next_cursor; the query is fixed
 * across pages. See ADR-0005.
 */

const BASE = "https://api.socialdata.tools/twitter/search";

interface SocialDataMedia {
  type?: string;
  media_url_https?: string;
}

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
  entities?: {
    media?: SocialDataMedia[];
  };
  extended_entities?: {
    media?: SocialDataMedia[];
  };
}

interface SocialDataResponse {
  tweets: SocialDataTweet[];
  next_cursor?: string | null;
}

export class SocialDataClient {
  constructor(private apiKey: string, private listId: string) {}

  /**
   * Fetch posts via search endpoint. When sinceId is non-null, applies `since_id:{sinceId}`
   * as a server-side filter (exclusive — matches prior `t.id_str <= sinceId` semantics).
   * When sinceId is null (first run), fetches page 1 only to establish the cursor
   * without billing for list history.
   */
  async fetchNewPosts(sinceId: string | null): Promise<Tweet[]> {
    const collected: Tweet[] = [];
    let cursor: string | undefined = undefined;
    let newestId: string | null = sinceId;
    const query =
      sinceId != null ? `list:${this.listId} since_id:${sinceId}` : `list:${this.listId}`;

    for (let page = 0; page < POLL_MAX_PAGES; page++) {
      const url = new URL(BASE);
      url.searchParams.set("query", query);
      url.searchParams.set("type", "Latest");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`SocialData ${res.status}: ${body.slice(0, 500)}`);
      }
      const data = (await res.json()) as SocialDataResponse;

      for (const t of data.tweets ?? []) {
        collected.push(toTweet(t));
        if (!newestId || t.id_str > newestId) newestId = t.id_str;
      }

      if (sinceId == null) break;
      if (data.tweets.length === 0) break;
      if (!data.next_cursor) break;
      cursor = data.next_cursor;
    }

    collected.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return collected;
  }

  /** The newest id among fetched posts, to persist as the Fetch Cursor. */
  static newestId(posts: Tweet[], fallback: string | null): string | null {
    if (posts.length === 0) return fallback;
    return posts.reduce((max, p) => (p.id > max ? p.id : max), posts[0]!.id);
  }
}

export function extractImageUrls(t: SocialDataTweet): string[] | undefined {
  const mediaList = t.extended_entities?.media ?? t.entities?.media ?? [];
  const urls: string[] = [];
  for (const m of mediaList) {
    if ((m.type === "photo" || !m.type) && m.media_url_https) {
      urls.push(m.media_url_https);
    }
  }
  return urls.length > 0 ? urls : undefined;
}

function toTweet(t: SocialDataTweet): Tweet {
  const imageUrls = extractImageUrls(t);
  return {
    id: t.id_str,
    text: t.full_text ?? t.text ?? "",
    createdAt: t.tweet_created_at,
    author: t.user?.screen_name ?? "",
    isReply: t.in_reply_to_status_id_str != null,
    isRetweet: t.retweeted_status != null,
    isQuote: !!t.is_quote_status || t.quoted_status != null,
    ...(imageUrls ? { imageUrls } : {}),
  };
}
