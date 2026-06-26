import type { Config } from "./config.ts";
import type { WindowName } from "./types.ts";
import { Store } from "./store.ts";
import { TelegramClient } from "./telegram.ts";
import { summarizeWindow, summarizeDaily } from "./summarize.ts";
import { targetDateForSend } from "./time.ts";
import { withRetry } from "./retry.ts";

/**
 * Send job: triggered at 12:30 / 16:30 / 24:00 JST cron.
 * Summarizes the just-ended window and sends to Telegram.
 * At 24:00, sends BOTH 夜場 and Daily (two messages).
 * On complete failure, sends an Error Notification to the same chat.
 */

const WINDOW_HEADERS: Record<WindowName, string> = {
  朝場: "🌅 朝場",
  昼場: "🌞 昼場",
  夜場: "🌙 夜場",
  Daily: "📅 一日まとめ",
};

export async function runSend(config: Config, windowName: WindowName): Promise<void> {
  const date = targetDateForSend(windowName);
  const telegram = new TelegramClient(config.telegramBotToken, config.telegramChatId);

  try {
    const windowsToSend: WindowName[] = windowName === "夜場" ? ["夜場", "Daily"] : [windowName];

    for (const w of windowsToSend) {
      const text =
        w === "Daily"
          ? await summarizeDaily(config, date)
          : await summarizeWindow(config, w, date);

      const header = `${WINDOW_HEADERS[w]} (${date})`;
      const message = `${header}\n\n${text}`;

      await withRetry(`telegram.${w}`, () => telegram.send(message));
      console.log(`[send] ${w} ${date} delivered`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[send] ${windowName} ${date} FAILED: ${reason}`);
    // Error Notification: best-effort, never throws.
    try {
      await telegram.send(`⚠️ ${windowName} (${date}) 送信失敗\n理由: ${reason.slice(0, 500)}`);
    } catch (notifyErr) {
      console.error(`[send] failed to send error notification:`, notifyErr);
    }
    throw err; // re-throw so cron logs a non-zero exit
  }
}

/** Standalone error notifier for the poll job (3-consecutive-failure case). */
export async function notifyPollFailure(config: Config, reason: string): Promise<void> {
  const telegram = new TelegramClient(config.telegramBotToken, config.telegramChatId);
  await withRetry("telegram.poll-error", () =>
    telegram.send(`⚠️ ポーリング連続失敗\n理由: ${reason.slice(0, 500)}`),
  );
}
