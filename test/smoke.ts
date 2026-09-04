/**
 * Integration smoke test (no real API keys required).
 * Verifies: time windowing, post filtering, store round-trip, telegram splitting,
 * pipelines.json validation, and system-prompt resolution.
 */
import { validatePipelines } from "../src/config.ts";
import { GEMINI_RETRY_DELAYS_MS, RETRY_DELAYS_MS } from "../src/config.ts";
import {
  DEFAULT_SYSTEM_PROMPT,
  FALLBACK_MODELS,
  GeminiApiError,
  PRIMARY_MODEL,
  WINDOW_FALLBACK_PROFILE,
  WINDOW_PROFILE,
  buildWindowPromptParts,
  extractResponseText,
  formatTweet,
  isGeminiCapacityError,
  isGeminiCapacityStatus,
  isRetryableGeminiError,
  resolveSystemPrompt,
  usesThinkingLevel,
} from "../src/gemini.ts";
import { extractImageUrls } from "../src/socialdata.ts";
import { withJitter } from "../src/retry.ts";
import { Store } from "../src/store.ts";
import { sliceWindow, summarizeablePosts } from "../src/summarize.ts";
import { splitForTelegram } from "../src/telegram.ts";
import { jstDateKey, jstMinutesOfDay, inWindow, targetDateForSend } from "../src/time.ts";
import type { Tweet } from "../src/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    failures++;
  } else {
    console.log(`✓ ${msg}`);
  }
}

function assertThrows(fn: () => void, msg: string) {
  try {
    fn();
    console.error(`✗ ${msg} (expected throw)`);
    failures++;
  } catch {
    console.log(`✓ ${msg}`);
  }
}

// --- Time helpers ---
// 2026-06-26 03:00 UTC = 12:00 JST (in 朝場 [360,750))
const t1200jst = new Date("2026-06-26T03:00:00Z");
assert(jstMinutesOfDay(t1200jst) === 720, "12:00 JST = 720 minutes");

// 2026-06-26 03:30 UTC = 12:30 JST → belongs to 昼場 (right-open boundary)
const t1230jst = new Date("2026-06-26T03:30:00Z");
assert(jstMinutesOfDay(t1230jst) === 750, "12:30 JST = 750 minutes");
assert(inWindow(t1230jst, 360, 750) === false, "12:30 not in 朝場 [360,750) — right-open");
assert(inWindow(t1230jst, 750, 990) === true, "12:30 in 昼場 [750,990)");

// 2026-06-26 15:00 UTC = 24:00 JST (00:00 next day)
const t0000jst = new Date("2026-06-26T15:00:00Z");
assert(jstDateKey(t0000jst) === "2026-06-27", "00:00 JST → next day date key");

// Send target date: 夜場/Daily at JST 00:00 → previous JST day
assert(targetDateForSend("夜場", t0000jst) === "2026-06-26", "夜場 sent at 00:00 JST targets prev day");
assert(targetDateForSend("Daily", t0000jst) === "2026-06-26", "Daily sent at 00:00 JST targets prev day");
assert(targetDateForSend("朝場", t1200jst) === "2026-06-26", "朝場 sent at 12:30 JST targets same day");

// --- Post filter & images ---
const tweets: Tweet[] = [
  { id: "100", text: "normal tweet", createdAt: "2026-06-26T03:00:00Z", author: "a", isReply: false, isRetweet: false, isQuote: false },
  { id: "101", text: "@x reply", createdAt: "2026-06-26T03:01:00Z", author: "a", isReply: true, isRetweet: false, isQuote: false },
  { id: "102", text: "RT @y: hi", createdAt: "2026-06-26T03:02:00Z", author: "a", isReply: false, isRetweet: true, isQuote: false },
  { id: "103", text: "quote", createdAt: "2026-06-26T03:03:00Z", author: "a", isReply: false, isRetweet: false, isQuote: true, imageUrls: ["https://pbs.twimg.com/media/test.jpg"] },
];
const filtered = summarizeablePosts(tweets);
assert(filtered.length === 3, "replies excluded, RT/quote kept (3 of 4)");

// --- SocialData image extraction ---
const sdTweetWithMedia = {
  id_str: "200",
  full_text: "chart attached",
  tweet_created_at: "2026-06-26T03:00:00Z",
  in_reply_to_status_id_str: null,
  is_quote_status: false,
  retweeted_status: null,
  quoted_status: null,
  extended_entities: {
    media: [
      { type: "photo", media_url_https: "https://pbs.twimg.com/media/photo1.jpg" },
      { type: "video", media_url_https: "https://pbs.twimg.com/media/video.mp4" },
      { type: "photo", media_url_https: "https://pbs.twimg.com/media/photo2.png" },
    ],
  },
};
const extractedUrls = extractImageUrls(sdTweetWithMedia);
assert(
  extractedUrls?.length === 2 &&
    extractedUrls[0] === "https://pbs.twimg.com/media/photo1.jpg" &&
    extractedUrls[1] === "https://pbs.twimg.com/media/photo2.png",
  "extractImageUrls filters photos from extended_entities",
);

const sdTweetNoMedia = {
  id_str: "201",
  full_text: "no media",
  tweet_created_at: "2026-06-26T03:00:00Z",
  in_reply_to_status_id_str: null,
  is_quote_status: false,
  retweeted_status: null,
  quoted_status: null,
};
assert(extractImageUrls(sdTweetNoMedia) === undefined, "extractImageUrls returns undefined when no media");

// --- Tweet formatting with image note ---
const formattedWithImage = formatTweet(tweets[3]!);
assert(formattedWithImage.includes("[画像1枚添付]"), "formatTweet includes image count note");

// --- Gemini multimodal parts builder ---
const promptPartsEmpty = await buildWindowPromptParts("朝場", []);
assert(promptPartsEmpty.length === 1 && promptPartsEmpty[0]!.text!.includes("（この時間帯のツイートはありません）"), "empty posts prompt parts");

const promptPartsWithPost = await buildWindowPromptParts("朝場", [tweets[0]!]);
assert(promptPartsWithPost.length === 3, "prompt parts with post contains header, post text, and instruction");

// --- Window slicing ---
const allDay: Tweet[] = [
  { id: "1", text: "morning", createdAt: "2026-06-25T21:30:00Z", author: "a", isReply: false, isRetweet: false, isQuote: false }, // 06:30 JST
  { id: "2", text: "noon", createdAt: "2026-06-26T04:00:00Z", author: "a", isReply: false, isRetweet: false, isQuote: false },    // 13:00 JST
  { id: "3", text: "night", createdAt: "2026-06-26T08:00:00Z", author: "a", isReply: false, isRetweet: false, isQuote: false },   // 17:00 JST
];
const asa = sliceWindow(allDay, "朝場");
const hiru = sliceWindow(allDay, "昼場");
const yoru = sliceWindow(allDay, "夜場");
assert(asa.length === 1 && asa[0]!.id === "1", "朝場 slices 06:30 post");
assert(hiru.length === 1 && hiru[0]!.id === "2", "昼場 slices 13:00 post");
assert(yoru.length === 1 && yoru[0]!.id === "3", "夜場 slices 17:00 post");

// --- Store round-trip ---
const tmpDir = `/tmp/store-test-${Date.now()}`;
const store = new Store(tmpDir, "test-pipeline");
await store.init();
const cursor0 = await store.readCursor();
assert(cursor0.sinceId === null, "fresh store has null cursor");
assert(cursor0.consecutivePollFailures === 0, "fresh store has 0 consecutive poll failures");

const added = await store.appendPosts("2026-06-26", tweets);
assert(added === 4, "append adds 4 new posts");
const addedDup = await store.appendPosts("2026-06-26", tweets);
assert(addedDup === 0, "dedup: re-append adds 0");

await store.writeCursor({ sinceId: "999", updatedAt: new Date().toISOString(), consecutivePollFailures: 2 });
const cursor1 = await store.readCursor();
assert(cursor1.sinceId === "999", "cursor persists");
assert(cursor1.consecutivePollFailures === 2, "cursor persists consecutive poll failures");
assert(await Bun.file(`${tmpDir}/test-pipeline/cursor.json`).exists(), "cursor path includes pipeline id");

await store.saveWindowSummary("2026-06-26", "朝場", "summary text");
const summaries = await store.readWindowSummaries("2026-06-26");
assert(summaries["朝場"] === "summary text", "window summary persists");

// --- Telegram splitting ---
const short = splitForTelegram("hello");
assert(short.length === 1 && short[0]! === "hello", "short text → 1 chunk");

const longLine = "あ".repeat(5000);
const longChunks = splitForTelegram(longLine);
assert(longChunks.length === 2, "5000-char → 2 chunks");
assert(longChunks.every((c) => c.length <= 4096), "all chunks <= 4096");
assert(longChunks[0]!.startsWith("(1/2)"), "multi-chunk gets (1/2) marker");

const multiLine = Array(200).fill("line of text here").join("\n");
const mlChunks = splitForTelegram(multiLine);
assert(mlChunks.every((c) => c.length <= 4096), "multiline chunks respect limit");

// --- pipelines.json: optional systemPrompt ---
const withoutPrompt = validatePipelines([
  { id: "main", listId: "111", telegramChatId: "-100" },
]);
assert(withoutPrompt.length === 1 && withoutPrompt[0]!.systemPrompt === undefined, "missing systemPrompt stays valid");

const withPrompt = validatePipelines([
  { id: "crypto", listId: "222", telegramChatId: "-200", systemPrompt: "crypto analyst prompt" },
]);
assert(withPrompt[0]!.systemPrompt === "crypto analyst prompt", "present systemPrompt is accepted");

assertThrows(
  () => validatePipelines([{ id: "bad", listId: "333", telegramChatId: "-300", systemPrompt: "" }]),
  "empty systemPrompt is rejected",
);
assertThrows(
  () => validatePipelines([{ id: "bad", listId: "333", telegramChatId: "-300", systemPrompt: 1 }]),
  "non-string systemPrompt is rejected",
);

// --- System prompt resolution ---
assert(resolveSystemPrompt(undefined) === DEFAULT_SYSTEM_PROMPT, "undefined systemPrompt uses default");
assert(resolveSystemPrompt("custom override") === "custom override", "present systemPrompt fully replaces default");
assert(!DEFAULT_SYSTEM_PROMPT.includes("custom override"), "default prompt is unchanged by override helper");

// --- Gemini response parsing ---
assert(
  extractResponseText([
    { text: "internal reasoning", thought: true },
    { text: "visible answer" },
  ]) === "visible answer",
  "extractResponseText skips thought parts",
);
assert(
  extractResponseText([{ text: "part1" }, { text: "part2" }]) === "part1part2",
  "extractResponseText joins visible parts",
);

// --- Window generation budget (thinking + visible share maxOutputTokens) ---
assert(WINDOW_PROFILE.thinkingBudget > 0, "window profile caps thinking (not dynamic -1)");
assert(
  WINDOW_PROFILE.thinkingBudget + 1024 <= WINDOW_PROFILE.maxOutputTokens,
  "window profile reserves >=1024 tokens for visible output",
);
assert(WINDOW_PROFILE.thinkingLevel === "medium", "window primary uses medium thinking level");
assert(WINDOW_FALLBACK_PROFILE.thinkingBudget === 0, "window fallback disables thinking on budget models");
assert(WINDOW_FALLBACK_PROFILE.thinkingLevel === "low", "window fallback uses lowest 3.8 thinking level");
assert(
  WINDOW_FALLBACK_PROFILE.maxOutputTokens >= WINDOW_PROFILE.maxOutputTokens,
  "window fallback keeps at least the primary output budget",
);
assert(usesThinkingLevel(PRIMARY_MODEL), "3.8 Flash uses thinkingLevel");
assert(!usesThinkingLevel("gemini-3.5-flash"), "3.5 Flash keeps thinkingBudget");

// --- Gemini capacity / retry classification (夜場 503 high-demand) ---
assert(PRIMARY_MODEL === "gemini-3.8-flash", "primary model is 3.8 Flash");
assert(FALLBACK_MODELS[0] === "gemini-3.5-flash", "first fallback is previous primary");
assert(FALLBACK_MODELS.length >= 1, "at least one fallback model configured");
assert(
  isGeminiCapacityStatus(
    503,
    '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
  ),
  "503 high-demand body is capacity",
);
assert(isGeminiCapacityStatus(429, "RESOURCE_EXHAUSTED"), "429 is capacity");
assert(!isGeminiCapacityStatus(400, "INVALID_ARGUMENT"), "400 is not capacity");

const capacityErr = new GeminiApiError(
  503,
  '{"error":{"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
  PRIMARY_MODEL,
);
assert(capacityErr.isCapacity, "GeminiApiError.isCapacity for 503 UNAVAILABLE");
assert(isGeminiCapacityError(capacityErr), "isGeminiCapacityError recognizes GeminiApiError");
assert(isRetryableGeminiError(capacityErr), "503 capacity is retryable");
assert(
  isGeminiCapacityError(new Error('Gemini 503: {"error":{"status":"UNAVAILABLE"}}')),
  "stringified 503 errors still classify as capacity",
);
assert(!isRetryableGeminiError(new GeminiApiError(400, "bad request", PRIMARY_MODEL)), "400 is not retryable");

assert(GEMINI_RETRY_DELAYS_MS.length > RETRY_DELAYS_MS.length, "Gemini uses a longer retry schedule than generic I/O");
assert(
  GEMINI_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) >= 5 * 60_000,
  "Gemini capacity retries span at least ~5 minutes total",
);
const jittered = withJitter(1000, 0.2);
assert(jittered >= 800 && jittered <= 1200, "withJitter stays within ±20%");

console.log("");
if (failures === 0) {
  console.log("🎉 All smoke tests passed");
  process.exit(0);
} else {
  console.error(`❌ ${failures} test(s) failed`);
  process.exit(1);
}
