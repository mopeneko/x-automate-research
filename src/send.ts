import type { Config } from "./config.ts";
import type { PipelineConfig, WindowName } from "./types.ts";
import { GEMINI_CALL_GAP_MS } from "./config.ts";
import { TelegramClient } from "./telegram.ts";
import { summarizeWindow, summarizeDaily } from "./summarize.ts";
import { targetDateForSend } from "./time.ts";
import { sleep, withRetry } from "./retry.ts";

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

export async function runSend(config: Config, windowName: WindowName, pipelineId?: string): Promise<void> {
  const pipelines = selectPipelines(config, pipelineId);

  for (let i = 0; i < pipelines.length; i++) {
    const pipeline = pipelines[i]!;
    if (i > 0) {
      // Pace Pipeline→Pipeline Gemini bursts (esp. 夜場+Daily at JST midnight).
      await sleep(GEMINI_CALL_GAP_MS);
    }
    try {
      await sendOnePipeline(config, pipeline, windowName);
    } catch {
      // Per-Pipeline failure isolation by design.
    }
  }
}

async function sendOnePipeline(config: Config, pipeline: PipelineConfig, windowName: WindowName): Promise<void> {
  const date = targetDateForSend(windowName);
  const telegram = new TelegramClient(config.telegramBotToken, pipeline.telegramChatId);
  const prefix = `[send pipeline=${pipeline.id}]`;

  try {
    const windowsToSend: WindowName[] = windowName === "夜場" ? ["夜場", "Daily"] : [windowName];

    for (let i = 0; i < windowsToSend.length; i++) {
      const w = windowsToSend[i]!;
      if (i > 0) {
        // 夜場 → Daily: avoid back-to-back generateContent during capacity spikes.
        await sleep(GEMINI_CALL_GAP_MS);
      }
      const text =
        w === "Daily"
          ? await summarizeDaily(config, pipeline.id, date, pipeline.systemPrompt)
          : await summarizeWindow(config, pipeline.id, w, date, pipeline.systemPrompt);

      const header = `${WINDOW_HEADERS[w]} (${date})`;
      const message = `${header}\n\n${text}`;

      await withRetry(`telegram.${w}`, () => telegram.send(message));
      console.log(`${prefix} ${w} ${date} delivered`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`${prefix} ${windowName} ${date} FAILED: ${reason}`);
    // Error Notification: best-effort, never throws.
    try {
      await telegram.send(`⚠️ ${windowName} (pipeline=${pipeline.id}, date=${date}) 送信失敗\n理由: ${reason.slice(0, 500)}`);
    } catch (notifyErr) {
      console.error(`${prefix} failed to send error notification:`, notifyErr);
    }
    throw err;
  }
}

/** Standalone error notifier for the poll job (3-consecutive-failure case). */
export async function notifyPollFailure(config: Config, pipeline: PipelineConfig, reason: string): Promise<void> {
  const telegram = new TelegramClient(config.telegramBotToken, pipeline.telegramChatId);
  await withRetry("telegram.poll-error", () =>
    telegram.send(`⚠️ ポーリング連続失敗 (pipeline=${pipeline.id})\n理由: ${reason.slice(0, 500)}`),
  );
}

function selectPipelines(config: Config, pipelineId?: string): PipelineConfig[] {
  if (!pipelineId) return config.pipelines;
  const pipeline = config.pipelines.find((entry) => entry.id === pipelineId);
  if (!pipeline) {
    throw new Error(`Unknown pipeline id: ${pipelineId}`);
  }
  return [pipeline];
}
