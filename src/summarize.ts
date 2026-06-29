import type { Config } from "./config.ts";
import type { Tweet, WindowName } from "./types.ts";
import { WINDOWS } from "./config.ts";
import { Store } from "./store.ts";
import { GeminiSummarizer } from "./gemini.ts";
import { inWindow } from "./time.ts";
import { withRetry } from "./retry.ts";

/**
 * Summarization: slices a window's posts from the Tweet Store and generates
 * the Window Summary via the Summarizer. For Daily, uses the hybrid method.
 */

/** Posts that pass the post filter: replies excluded, RT/quote included. */
export function summarizeablePosts(posts: Tweet[]): Tweet[] {
  return posts.filter((p) => !p.isReply);
}

/** Filter posts to a window's [startMin, endMin) on their JST day. */
export function sliceWindow(posts: Tweet[], windowName: WindowName): Tweet[] {
  const def = WINDOWS.find((w) => w.name === windowName)!;
  return posts
    .filter((p) => inWindow(new Date(p.createdAt), def.startMin, def.endMin))
    .filter((p) => !p.isReply);
}

/** Generate and persist an intraday Window Summary. Returns the summary text. */
export async function summarizeWindow(
  config: Config,
  pipelineId: string,
  windowName: WindowName,
  date: string,
): Promise<string> {
  const store = new Store(config.storeDir, pipelineId);
  const day = await store.readDay(date);
  const posts = sliceWindow(day.posts, windowName);

  const summarizer = new GeminiSummarizer(config.geminiApiKey);
  const text = await withRetry(`gemini.${windowName}`, () => summarizer.summarizeWindow(windowName, posts));

  await store.saveWindowSummary(date, windowName, text);
  console.log(`[summarize] ${windowName} ${date}: ${posts.length} posts → ${text.length} chars`);
  return text;
}

/** Generate the Daily Summary (hybrid: raw posts + intraday summaries). */
export async function summarizeDaily(config: Config, pipelineId: string, date: string): Promise<string> {
  const store = new Store(config.storeDir, pipelineId);
  const day = await store.readDay(date);
  const posts = summarizeablePosts(day.posts);
  const intraday = await store.readWindowSummaries(date);

  const summarizer = new GeminiSummarizer(config.geminiApiKey);
  const text = await withRetry("gemini.Daily", () => summarizer.summarizeDaily(posts, intraday));

  await store.saveWindowSummary(date, "Daily", text);
  console.log(`[summarize] Daily ${date}: ${posts.length} posts → ${text.length} chars`);
  return text;
}
