import { reviewSummary, saveReview } from "./review.ts";
import { join } from "node:path";
import { annotatePosts } from "./jev.ts";
import type { Config } from "./config.ts";
import type { Tweet, WindowName } from "./types.ts";
import { RETRY_DELAYS_MS, WINDOWS } from "./config.ts";
import { Store } from "./store.ts";
import {
  GeminiSummarizer,
  isGeminiCapacityError,
  isRetryableGeminiError,
} from "./gemini.ts";
import { inWindow } from "./time.ts";
import { withRetry } from "./retry.ts";

/**
 * Outer retry covers truncation / network / timeouts only.
 * Flex capacity (503/429) is retried with exponential backoff inside the
 * Summarizer on the same model before any model fallback — do not double-retry
 * it here or we burn through fallback models on every outer attempt.
 */
function shouldRetryOuterGemini(err: unknown): boolean {
  return isRetryableGeminiError(err) && !isGeminiCapacityError(err);
}

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
  systemPrompt?: string,
): Promise<string> {
  const store = new Store(config.storeDir, pipelineId);
  const day = await store.readDay(date);
  const posts = sliceWindow(day.posts, windowName);

  const annotations = await annotatePosts(posts, config.jev?.mode === "annotate" ? config.jev : undefined, join(config.storeDir, pipelineId, "jev", date));
  const summarizer = new GeminiSummarizer(config.geminiApiKey, systemPrompt, annotations);
  const draft = await withRetry(
    `gemini.${windowName}`,
    () => summarizer.summarizeWindow(windowName, posts),
    { delays: RETRY_DELAYS_MS, shouldRetry: shouldRetryOuterGemini },
  );

  const text = await finishReview(draft, posts, config, summarizer, join(config.storeDir, pipelineId, "reviews", date, windowName));
  await store.saveWindowSummary(date, windowName, text);
  console.log(`[summarize] ${windowName} ${date}: ${posts.length} posts → ${text.length} chars`);
  return text;
}

/** Generate the Daily Summary (hybrid: raw posts + intraday summaries). */
export async function summarizeDaily(
  config: Config,
  pipelineId: string,
  date: string,
  systemPrompt?: string,
): Promise<string> {
  const store = new Store(config.storeDir, pipelineId);
  const day = await store.readDay(date);
  const posts = summarizeablePosts(day.posts);
  const intraday = await store.readWindowSummaries(date);

  const annotations = await annotatePosts(posts, config.jev?.mode === "annotate" ? config.jev : undefined, join(config.storeDir, pipelineId, "jev", date));
  const summarizer = new GeminiSummarizer(config.geminiApiKey, systemPrompt, annotations);
  const draft = await withRetry(
    "gemini.Daily",
    () => summarizer.summarizeDaily(posts, intraday),
    { delays: RETRY_DELAYS_MS, shouldRetry: shouldRetryOuterGemini },
  );

  const text = await finishReview(draft, posts, config, summarizer, join(config.storeDir, pipelineId, "reviews", date, "Daily"));
  await store.saveWindowSummary(date, "Daily", text);
  console.log(`[summarize] Daily ${date}: ${posts.length} posts → ${text.length} chars`);
  return text;
}

async function finishReview(draft: string, posts: Tweet[], config: Config, summarizer: GeminiSummarizer, dir: string): Promise<string> {
  if (!config.jev || config.jev.mode === "annotate") return draft;
  try {
    const report = await reviewSummary(draft, posts, config.jev, (items) => summarizer.repairClaims(items));
    await saveReview(report, dir);
    console.log(`[jev.review] status=${report.before.status} edits=${report.appliedLines.length} unresolved=${report.unresolvedLines.length} unchecked=${report.before.uncheckedLines}`);
    return report.final;
  } catch {
    console.warn("[jev.review] unavailable; preserving draft (not verified)");
    return draft;
  }
}
