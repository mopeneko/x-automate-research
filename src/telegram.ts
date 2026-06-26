import { TELEGRAM_MAX_CHARS } from "./config.ts";

/**
 * Telegram Bot API client. Sends plain text (no parse_mode) for safety with
 * LLM output containing $ and numbers. Auto-splits on the 4096-char limit,
 * appending (n/N) markers. See CONTEXT.md "Telegram delivery".
 */

export class TelegramClient {
  private base: string;

  constructor(private botToken: string, private chatId: string) {
    this.base = `https://api.telegram.org/bot${botToken}`;
  }

  /** Send one or more messages, splitting if needed. Returns count sent. */
  async send(text: string): Promise<number> {
    const chunks = splitForTelegram(text);
    for (const chunk of chunks) {
      await this.sendMessage(chunk);
    }
    return chunks.length;
  }

  private async sendMessage(text: string): Promise<void> {
    const res = await fetch(`${this.base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram ${res.status}: ${body.slice(0, 500)}`);
    }
  }
}

/**
 * Split a long text into <= TELEGRAM_MAX_CHARS chunks.
 * Prefers splitting at newlines so sections aren't cut mid-line. When a single
 * line exceeds the limit, hard-splits it. Reserves room for the (n/N) marker.
 */
export function splitForTelegram(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_CHARS) return [text];

  // First pass: split on raw limit to estimate chunk count.
 const provisional = splitRaw(text, TELEGRAM_MAX_CHARS);
  const n = provisional.length;
  const markerOverhead = n >= 2 ? `( ${n} / ${n} )\n`.length + 2 : 0; // conservative
  const bodyLimit = TELEGRAM_MAX_CHARS - Math.max(markerOverhead, 8);

  const bodies = splitRaw(text, bodyLimit);
  if (bodies.length === 1) return bodies;
  return bodies.map((b, i) => `(${i + 1}/${bodies.length})\n${b}`);
}

function splitRaw(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}
