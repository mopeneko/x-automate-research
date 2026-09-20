import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, GEMINI_CALL_GAP_MS, WINDOWS } from "./config.ts";
import type { Config } from "./config.ts";
import { GeminiSummarizer } from "./gemini.ts";
import { reviewSummary, formatReviewReport } from "./review.ts";
import { annotatePosts } from "./jev.ts";
import { Store } from "./store.ts";
import { sliceWindow, summarizeablePosts } from "./summarize.ts";
import type { WindowName } from "./types.ts";

/** Generate comparison files only. Never sends Telegram or overwrites saved summaries. */
export async function previewComparison(config: Config, pipelineId: string, date: string, window: WindowName): Promise<string> {
  const pipeline = config.pipelines.find((p) => p.id === pipelineId);
  if (!pipeline) throw new Error("Unknown pipeline id");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Use a valid YYYY-MM-DD date");
  if (!WINDOWS.some((w) => w.name === window)) throw new Error("Unknown summary window");
  if (!config.jev) throw new Error("Preview requires JEV_ENABLED=true and TYPESAFE_API_KEY");
  const store = new Store(config.storeDir, pipelineId);
  const day = await store.readDay(date);
  const posts = window === "Daily" ? summarizeablePosts(day.posts) : sliceWindow(day.posts, window);
  if (!posts.length) throw new Error("No stored posts for this date/window");
  const annotations = await annotatePosts(posts, config.jev.mode === "annotate" ? config.jev : undefined, join(config.storeDir, pipelineId, "jev", date));
  if (config.jev.mode === "annotate" && !Object.keys(annotations).length) throw new Error("No Jev annotations available; comparison cancelled before Gemini calls");
  // The same intraday snapshot is used for both variants, even for Daily.
  const intraday = window === "Daily" ? await store.readWindowSummaries(date) : {};
  const baseline = new GeminiSummarizer(config.geminiApiKey, pipeline.systemPrompt);
  const enriched = new GeminiSummarizer(config.geminiApiKey, pipeline.systemPrompt, annotations);
  const outputDir = join(config.storeDir, pipelineId, "previews", `${date}-${window}-${Date.now()}`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "input.json"), JSON.stringify({ posts, intraday, annotations }, null, 2));
  const generate = (summarizer: GeminiSummarizer) => window === "Daily"
    ? summarizer.summarizeDaily(posts, intraday)
    : summarizer.summarizeWindow(window, posts);
  const draft = await generate(baseline);
  await writeFile(join(outputDir, "baseline.txt"), draft);
  if (config.jev.mode === "annotate") {
    await Bun.sleep(GEMINI_CALL_GAP_MS);
    await writeFile(join(outputDir, "jev.txt"), await generate(enriched));
  } else {
    const report = await reviewSummary(draft, posts, config.jev, (items) => baseline.repairClaims(items));
    await writeFile(join(outputDir, "audit.json"), JSON.stringify(report, null, 2));
    await writeFile(join(outputDir, "audit.md"), formatReviewReport(report));
    await writeFile(join(outputDir, "jev.txt"), report.final);
    console.log(`[jev.review] edits=${report.appliedLines.length} unresolved=${report.unresolvedLines.length} unchecked=${report.before.uncheckedLines}`);
  }
  return outputDir;
}

if (import.meta.main) {
  const [pipelineId, date, window] = Bun.argv.slice(2);
  if (!pipelineId || !date || !window) {
    console.error("Usage: bun run preview <pipelineId> <YYYY-MM-DD> <朝場|昼場|夜場|Daily>");
    process.exit(1);
  }
  try {
    console.log(`Comparison saved: ${await previewComparison(loadConfig(), pipelineId, date, window as WindowName)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Preview failed");
    process.exit(1);
  }
}
