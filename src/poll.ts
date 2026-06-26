import type { Config } from "./config.ts";
import { Store } from "./store.ts";
import { SocialDataClient } from "./socialdata.ts";
import { jstDateKey } from "./time.ts";
import { withRetry } from "./retry.ts";

/**
 * Polling job (cron: every 15 minutes).
 * Fetches new posts from the X List via SocialData, appends to today's Tweet Store
 * file, and atomically updates the Fetch Cursor. See ADR-0003.
 */
export async function runPoll(config: Config): Promise<{ added: number }> {
  const store = new Store(config.storeDir);
  await store.init();

  const cursor = await store.readCursor();
  const client = new SocialDataClient(config.socialdataApiKey, config.socialdataListId);

  // Fetch + retry. On total failure, caller decides on notification.
  const posts = await withRetry("socialdata.fetch", () => client.fetchNewPosts(cursor.sinceId));

  if (posts.length === 0) {
    console.log(`[poll] no new posts since ${cursor.sinceId ?? "(none)"}`);
    return { added: 0 };
  }

  const today = jstDateKey(new Date());
  const added = await store.appendPosts(today, posts);

  const newCursor = {
    sinceId: SocialDataClient.newestId(posts, cursor.sinceId),
    updatedAt: new Date().toISOString(),
  };
  await store.writeCursor(newCursor);

  console.log(`[poll] fetched ${posts.length} new posts, ${added} added to ${today}, cursor=${newCursor.sinceId}`);
  return { added };
}
