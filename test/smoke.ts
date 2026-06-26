/**
 * Integration smoke test (no real API keys required).
 * Verifies: time windowing, post filtering, store round-trip, telegram splitting.
 */
import { Store } from "../src/store.ts";
import { sliceWindow, summarizeablePosts } from "../src/summarize.ts";
import { splitForTelegram } from "../src/telegram.ts";
import { jstDateKey, jstMinutesOfDay, inWindow, targetDateForSend } from "../src/time.ts";
import { WINDOWS } from "../src/config.ts";
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

// --- Post filter ---
const tweets: Tweet[] = [
  { id: "100", text: "normal tweet", createdAt: "2026-06-26T03:00:00Z", author: "a", isReply: false, isRetweet: false, isQuote: false },
  { id: "101", text: "@x reply", createdAt: "2026-06-26T03:01:00Z", author: "a", isReply: true, isRetweet: false, isQuote: false },
  { id: "102", text: "RT @y: hi", createdAt: "2026-06-26T03:02:00Z", author: "a", isReply: false, isRetweet: true, isQuote: false },
  { id: "103", text: "quote", createdAt: "2026-06-26T03:03:00Z", author: "a", isReply: false, isRetweet: false, isQuote: true },
];
const filtered = summarizeablePosts(tweets);
assert(filtered.length === 3, "replies excluded, RT/quote kept (3 of 4)");

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
const store = new Store(tmpDir);
await store.init();
const cursor0 = await store.readCursor();
assert(cursor0.sinceId === null, "fresh store has null cursor");

const added = await store.appendPosts("2026-06-26", tweets);
assert(added === 4, "append adds 4 new posts");
const addedDup = await store.appendPosts("2026-06-26", tweets);
assert(addedDup === 0, "dedup: re-append adds 0");

await store.writeCursor({ sinceId: "999", updatedAt: new Date().toISOString() });
const cursor1 = await store.readCursor();
assert(cursor1.sinceId === "999", "cursor persists");

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

console.log("");
if (failures === 0) {
  console.log("🎉 All smoke tests passed");
  process.exit(0);
} else {
  console.error(`❌ ${failures} test(s) failed`);
  process.exit(1);
}
