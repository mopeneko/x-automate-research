/** Retry with exponential backoff. See RETRY_DELAYS_MS in config.ts. */
import { RETRY_DELAYS_MS } from "./config.ts";

export interface RetryOptions {
  /** Override default delay schedule. */
  delays?: readonly number[];
  /**
   * When set, only retry if this returns true. Non-retryable errors are rethrown
   * immediately without consuming further attempts.
   */
  shouldRetry?: (err: unknown) => boolean;
  /** Add ±jitterPct randomness to each delay (0–1). Default 0.2 when delays are custom. */
  jitterPct?: number;
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const delays = options?.delays ?? RETRY_DELAYS_MS;
  const jitterPct = options?.jitterPct ?? (options?.delays ? 0.2 : 0);
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const canRetry = attempt < delays.length && (options?.shouldRetry?.(err) ?? true);
      if (!canRetry) {
        throw err;
      }
      const base = delays[attempt] ?? 5_000;
      const delay = withJitter(base, jitterPct);
      console.error(
        `[${label}] attempt ${attempt + 1} failed, retrying in ${delay}ms:`,
        err instanceof Error ? err.message : err,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Apply symmetric jitter: delay * (1 ± jitterPct). */
export function withJitter(delayMs: number, jitterPct: number): number {
  if (jitterPct <= 0) return delayMs;
  const span = delayMs * jitterPct;
  return Math.max(0, Math.round(delayMs - span + Math.random() * span * 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
