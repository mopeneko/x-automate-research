import type { Config } from "./config.ts";
import type { PipelineConfig } from "./types.ts";
import { Store } from "./store.ts";
import { SocialDataClient } from "./socialdata.ts";
import { jstDateKey } from "./time.ts";
import { withRetry } from "./retry.ts";
import { notifyPollFailure } from "./send.ts";

/**
 * Polling job (cron: every 15 minutes).
 * Fetches new posts from the X List via SocialData, appends to today's Tweet Store
 * file, and atomically updates the Fetch Cursor. See ADR-0003.
 */
export async function runPoll(config: Config, pipelineId?: string): Promise<{ added: number }> {
  const pipelines = selectPipelines(config, pipelineId);
  let totalAdded = 0;

  for (const pipeline of pipelines) {
    totalAdded += await pollOnePipeline(config, pipeline);
  }

  return { added: totalAdded };
}

async function pollOnePipeline(config: Config, pipeline: PipelineConfig): Promise<number> {
  const prefix = `[poll pipeline=${pipeline.id}]`;
  const store = new Store(config.storeDir, pipeline.id);
  await store.init();

  const cursor = await store.readCursor();
  const client = new SocialDataClient(config.socialdataApiKey, pipeline.listId);

  try {
    const posts = await withRetry("socialdata.fetch", () => client.fetchNewPosts(cursor.sinceId));

    let totalAdded = 0;
    if (posts.length > 0) {
      const postsByDate = new Map<string, typeof posts>();
      for (const post of posts) {
        const date = jstDateKey(new Date(post.createdAt));
        const arr = postsByDate.get(date);
        if (arr) {
          arr.push(post);
        } else {
          postsByDate.set(date, [post]);
        }
      }

      for (const [date, datePosts] of postsByDate) {
        const added = await store.appendPosts(date, datePosts);
        totalAdded += added;
        console.log(`${prefix} ${added} added to ${date}`);
      }

      await store.writeCursor({
        sinceId: SocialDataClient.newestId(posts, cursor.sinceId),
        updatedAt: new Date().toISOString(),
        consecutivePollFailures: cursor.consecutivePollFailures,
      });
    }

    if (cursor.consecutivePollFailures > 0) {
      await store.writeCursor({
        sinceId: posts.length > 0 ? SocialDataClient.newestId(posts, cursor.sinceId) : cursor.sinceId,
        updatedAt: posts.length > 0 ? new Date().toISOString() : cursor.updatedAt,
        consecutivePollFailures: 0,
      });
    }

    console.log(`${prefix} ok`);
    return totalAdded;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failedCursor = {
      sinceId: cursor.sinceId,
      updatedAt: cursor.updatedAt,
      consecutivePollFailures: cursor.consecutivePollFailures + 1,
    };

    try {
      await store.writeCursor(failedCursor);
    } catch (writeError) {
      const writeReason = writeError instanceof Error ? writeError.message : String(writeError);
      console.error(`${prefix} failed to persist cursor after error: ${writeReason}`);
    }

    console.error(`${prefix} failed: ${reason}`);
    if (failedCursor.consecutivePollFailures >= 3) {
      try {
        await notifyPollFailure(config, pipeline, reason);
      } catch (notifyError) {
        const notifyReason = notifyError instanceof Error ? notifyError.message : String(notifyError);
        console.error(`${prefix} failed to send poll failure notification: ${notifyReason}`);
      }
    }
    return 0;
  }
}

function selectPipelines(config: Config, pipelineId?: string): PipelineConfig[] {
  if (!pipelineId) return config.pipelines;
  const pipeline = config.pipelines.find((entry) => entry.id === pipelineId);
  if (!pipeline) {
    throw new Error(`Unknown pipeline id: ${pipelineId}`);
  }
  return [pipeline];
}
