import type { WindowDef } from "./types.ts";

/**
 * Configuration loaded from environment variables. All secrets come from env;
 * window definitions and retry policy are fixed by design (see CONTEXT.md / ADRs).
 */

export const WINDOWS: readonly WindowDef[] = [
  { name: "朝場", startMin: 6 * 60, endMin: 12 * 60 + 30, sendLabel: "12:30" },
  { name: "昼場", startMin: 12 * 60 + 30, endMin: 16 * 60 + 30, sendLabel: "16:30" },
  { name: "夜場", startMin: 16 * 60 + 30, endMin: 24 * 60, sendLabel: "24:00" },
  { name: "Daily", startMin: 0, endMin: 24 * 60, sendLabel: "24:00" },
] as const;

/** Retry policy: 3 attempts with exponential backoff (2s, 8s, 30s). */
export const RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;

/** Polling: cap pages fetched per poll to bound cost on a bursty list. */
export const POLL_MAX_PAGES = 5;

/** Telegram message length limit. */
export const TELEGRAM_MAX_CHARS = 4096;

export interface Config {
  socialdataListId: string;
  socialdataApiKey: string;
  geminiApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  storeDir: string;
}

export function loadConfig(): Config {
  const required = [
    "SOCIALDATA_LIST_ID",
    "SOCIALDATA_API_KEY",
    "GEMINI_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
  ] as const;
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }
  return {
    socialdataListId: process.env.SOCIALDATA_LIST_ID!,
    socialdataApiKey: process.env.SOCIALDATA_API_KEY!,
    geminiApiKey: process.env.GEMINI_API_KEY!,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
    telegramChatId: process.env.TELEGRAM_CHAT_ID!,
    storeDir: process.env.STORE_DIR ?? "./store",
  };
}
