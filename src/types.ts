/** Domain types for X-List Market Summary. See CONTEXT.md for the glossary. */

/** One declared Pipeline. Loaded from pipelines.json. */
export interface PipelineConfig {
  /** Filesystem-safe slug: [a-z0-9-]+. Used as store subdir and log/CLI identifier. */
  id: string;
  /** X List ID (numeric string from x.com/i/lists/<ID>). */
  listId: string;
  /** Telegram chat ID this Pipeline sends to (and receives Error Notifications). */
  telegramChatId: string;
}

/** A post fetched from the X List. Stored verbatim in the Tweet Store. */
export interface Tweet {
  /** Snowflake ID, monotonically increasing with time. Used for cursor comparison. */
  id: string;
  /** Full text, RT/quote prefixes included. */
  text: string;
  /** ISO 8601 creation timestamp from X (UTC). */
  createdAt: string;
  /** Author screen name without @. */
  author: string;
  /** True if this is a reply to another post (in_reply_to_status_id_str set). */
  isReply: boolean;
  /** True if this is a retweet of another post. */
  isRetweet: boolean;
  /** True if this is a quote tweet. */
  isQuote: boolean;
}

/** Names of the four Summary Windows plus Daily. */
export type WindowName = "朝場" | "昼場" | "夜場" | "Daily";

/** Definition of one Summary Window in JST minutes-of-day. Left-closed, right-open. */
export interface WindowDef {
  name: WindowName;
  /** Start boundary in JST minutes-of-day, inclusive. */
  startMin: number;
  /** End boundary in JST minutes-of-day, exclusive. */
  endMin: number;
  /** Cron-driven send time label, for logging/notification. */
  sendLabel: string;
}

/** A generated Window Summary following the Summary Schema. */
export interface WindowSummary {
  window: WindowName;
  date: string; // YYYY-MM-DD JST
  text: string; // The four-section structured text sent to Telegram
}
