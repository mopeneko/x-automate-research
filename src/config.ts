import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PipelineConfig, WindowDef } from "./types.ts";

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

/**
 * Same-model Flex capacity backoff (503/429). Flex often sheds on the first try;
 * stay on the current model and wait before falling back to another Flash generation.
 * 夜場/Daily fire at JST 00:00 (= UTC 15:00), which overlaps US daytime demand spikes.
 * Each attempt may already wait up to GEMINI_REQUEST_TIMEOUT_MS in-queue.
 * Inter-attempt wait ≈ 15s + 45s + 120s + 180s ≈ 6 minutes before model fallback.
 */
export const GEMINI_RETRY_DELAYS_MS = [15_000, 45_000, 120_000, 180_000] as const;

/** Pause between sequential Gemini calls (夜場→Daily, Pipeline→Pipeline) to avoid burst 503s. */
export const GEMINI_CALL_GAP_MS = 3_000;

/** Polling: cap pages fetched per poll to bound cost on a bursty list. */
export const POLL_MAX_PAGES = 5;

/** Telegram message length limit. */
export const TELEGRAM_MAX_CHARS = 4096;

export interface Config {
  socialdataApiKey: string;
  geminiApiKey: string;
  telegramBotToken: string;
  pipelines: PipelineConfig[];
  storeDir: string;
}

const PIPELINE_ID_RE = /^[a-z0-9-]+$/;

export function loadConfig(): Config {
  const required = ["SOCIALDATA_API_KEY", "GEMINI_API_KEY", "TELEGRAM_BOT_TOKEN"] as const;
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  return {
    socialdataApiKey: process.env.SOCIALDATA_API_KEY!,
    geminiApiKey: process.env.GEMINI_API_KEY!,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
    pipelines: loadPipelines(),
    storeDir: process.env.STORE_DIR ?? "./store",
  };
}

function loadPipelines(): PipelineConfig[] {
  const path = resolve(process.cwd(), "pipelines.json");
  if (!existsSync(path)) {
    throw new Error(`Missing pipelines.json at ${path}. Create it from the README template.`);
  }

  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pipelines.json: ${reason}`);
  }
  return validatePipelines(parsed);
}

/** Validate and normalize a pipelines.json payload. Exported for tests. */
export function validatePipelines(raw: unknown): PipelineConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error("pipelines.json must contain a JSON array.");
  }
  if (raw.length === 0) {
    throw new Error("pipelines.json must declare at least one Pipeline.");
  }

  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (!isPipelineConfig(entry)) {
      throw new Error(
        `pipelines.json entry #${index + 1} must have non-empty id, listId, telegramChatId; systemPrompt if present must be a non-empty string.`,
      );
    }
    if (!PIPELINE_ID_RE.test(entry.id)) {
      throw new Error(`pipelines.json entry #${index + 1} has invalid id '${entry.id}'. Use [a-z0-9-]+.`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`pipelines.json has duplicate pipeline id '${entry.id}'.`);
    }
    seen.add(entry.id);

    const config: PipelineConfig = {
      id: entry.id,
      listId: entry.listId,
      telegramChatId: entry.telegramChatId,
    };
    if (entry.systemPrompt !== undefined) {
      config.systemPrompt = entry.systemPrompt;
    }
    return config;
  });
}

function isPipelineConfig(value: unknown): value is PipelineConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.listId) || !isNonEmptyString(candidate.telegramChatId)) {
    return false;
  }
  // systemPrompt is optional; when present it must be a non-empty string.
  if (candidate.systemPrompt !== undefined && !isNonEmptyString(candidate.systemPrompt)) {
    return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
