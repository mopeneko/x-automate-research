import type { Tweet, WindowName } from "./types.ts";
import { sleep } from "./retry.ts";

/**
 * Summarizer: Gemini 3.5 Flash. Produces the four-section Summary Schema.
 * For Daily, uses the hybrid method (raw posts + intraday Window Summaries).
 * See ADR-0002.
 *
 * Capacity resilience: on 503/429 UNAVAILABLE (common at JST midnight / US peak),
 * skip useless profile switches, let the outer retry wait longer, then fall back
 * to a stabler Flash model before failing the send.
 */

/** Preferred model; highest Finance Agent quality per ADR-0002. */
export const PRIMARY_MODEL = "gemini-3.5-flash";

/**
 * Fallback when the primary model is capacity-exhausted.
 * Prefer an older Flash generation that usually has spare capacity (Google's
 * troubleshooting guidance: temporarily switch models on 503).
 */
export const FALLBACK_MODELS = ["gemini-3.1-flash", "gemini-2.5-flash"] as const;

export const GEMINI_MODELS = [PRIMARY_MODEL, ...FALLBACK_MODELS] as const;

/** Gemini caps thinking + visible output against maxOutputTokens. See ADR-0002. */
export interface GenerationProfile {
  thinkingBudget: number;
  maxOutputTokens: number;
}

/**
 * Dynamic thinking (-1) can consume nearly all of maxOutputTokens, leaving
 * only a few hundred chars of visible summary (seen on crypto 朝場 2026-07-10).
 * Cap thinking and keep a fallback that disables it.
 */
export const WINDOW_PROFILE: GenerationProfile = {
  thinkingBudget: 2048,
  maxOutputTokens: 8192,
};

export const WINDOW_FALLBACK_PROFILE: GenerationProfile = {
  thinkingBudget: 0,
  maxOutputTokens: 8192,
};

/** Daily has the largest prompt and often needs 6 sections (crypto). Reserve output budget. */
const DAILY_PROFILE: GenerationProfile = {
  thinkingBudget: 2048,
  maxOutputTokens: 16_384,
};

const DAILY_FALLBACK_PROFILE: GenerationProfile = {
  thinkingBudget: 0,
  maxOutputTokens: 16_384,
};

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    mimeType: string;
    data: string; // base64
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** Typed Gemini HTTP failure so callers can classify capacity vs content errors. */
export class GeminiApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly model: string;

  constructor(status: number, body: string, model: string) {
    super(`Gemini ${status} (${model}): ${body.slice(0, 500)}`);
    this.name = "GeminiApiError";
    this.status = status;
    this.body = body;
    this.model = model;
  }

  /** True for transient overload / rate-limit responses that warrant wait + model fallback. */
  get isCapacity(): boolean {
    return isGeminiCapacityStatus(this.status, this.body);
  }
}

/** Detect capacity / demand spikes from status + body (exported for tests). */
export function isGeminiCapacityStatus(status: number, body: string): boolean {
  if (status === 503 || status === 429) return true;
  if (status >= 500 && status < 600) {
    return /UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED|try again later/i.test(body);
  }
  return /UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED/i.test(body);
}

export function isGeminiCapacityError(err: unknown): boolean {
  if (err instanceof GeminiApiError) return err.isCapacity;
  if (err instanceof Error) {
    return /Gemini (429|503)\b/i.test(err.message) ||
      /high demand|UNAVAILABLE|overloaded|RESOURCE_EXHAUSTED/i.test(err.message);
  }
  return false;
}

/** Retry Gemini calls on capacity/5xx/network; do not retry hard client errors. */
export function isRetryableGeminiError(err: unknown): boolean {
  if (err instanceof GeminiApiError) {
    return err.isCapacity || err.status >= 500 || err.status === 408;
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (/Gemini (4\d\d)\b/.test(msg) && !/Gemini (408|429)\b/.test(msg)) {
      // 400/401/403/404 etc. — not worth retrying
      if (/Gemini (400|401|403|404)\b/.test(msg)) return false;
    }
    if (/Gemini (429|5\d\d)\b/.test(msg)) return true;
    if (/fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(msg)) return true;
    // Truncation / empty after profile fallback — retrying the same prompt rarely helps,
    // but a later attempt (or fallback model) might; allow retry.
    if (/truncated|empty visible/i.test(msg)) return true;
  }
  return true;
}

/** Default Summarizer system instruction (Japanese equities context + Summary Schema). */
export const DEFAULT_SYSTEM_PROMPT = `あなたは金融市場のツイート要約アナリストです。
X（旧Twitter）の金融系リストのツイート群を受け取り、日本の株式市場の文脈で意味のある要約を生成します。

【出力仕様】
必ず以下の4セクション構造で出力すること。セクション見出しは記号付きで正確に：

【主要ニュース】
・（簡潔な箇条書き、3〜7項目。最重要な市場ニュース・決算・政策等）

【銘柄・テーマ動向】
・$ティッカー または テーマ名: 動向（1行ずつ。数値・パーセンテージは原文から正確に保持）

【センチメント】
強気 / 中立 / 弱気 のいずれか1つ ＋ (好材料x / 悪材料y)

【注目ポイント】
・次の時間帯への引き継ぎ事項（1〜2項目）

【ルール】
- 出力は日本語。
- 銘柄コード（ティッカー）と数値は原文から正確に抽出し、改変しない。
- 添付画像（チャート、決算資料、統計データ、ニュースキャプチャ等）がある場合、画像内の文字・数値・図表・トレンド等の情報も要約ソースとして抽出し反映すること。
- 元ツイートへのリンク・URLは一切含めない。
- 推測や憶測は加えず、ツイート内容および添付画像に基づくこと。
- 扇情的な表現を避け、客観的に。
- セクション見出し以外のMarkdown記法は使わない。プレーンテキスト構造で出力。
- ウィンドウ名のヘッダーは不要（呼び出し側で付与する）。`;

/** Resolve which system instruction a Pipeline uses. Exported for tests. */
export function resolveSystemPrompt(pipelineSystemPrompt?: string): string {
  return pipelineSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
}

export class GeminiSummarizer {
  private apiKey: string;
  private systemPrompt: string;

  constructor(apiKey: string, pipelineSystemPrompt?: string) {
    this.apiKey = apiKey;
    this.systemPrompt = resolveSystemPrompt(pipelineSystemPrompt);
  }

  /** Summarize one intraday window from its raw posts. */
  async summarizeWindow(window: WindowName, posts: Tweet[]): Promise<string> {
    const parts = await buildWindowPromptParts(window, posts);
    return await this.generate(parts, "window");
  }

  /** Daily Summary via hybrid method: raw posts + intraday Window Summaries. */
  async summarizeDaily(posts: Tweet[], intradaySummaries: Record<string, string>): Promise<string> {
    const rawSection = posts.length === 0
      ? "（当日のツイートはありません）"
      : posts.map(formatTweet).join("\n\n");

    const summarySection = (["朝場", "昼場", "夜場"] as const)
      .filter((w) => intradaySummaries[w])
      .map((w) => `■ ${w}\n${intradaySummaries[w]}`)
      .join("\n\n");

    const userPrompt = `【タスク】当日（00:00-24:00 JST）を通した一日の要約を生成してください。

【当日の生ツイート群】
${rawSection}

【当日の時間帯別要約（参考）】
${summarySection || "（時間帯別要約なし）"}

生ツイートの網羅性と時間帯別要約の整理済み視点を統合し、一日を通した市場動向の総括として出力してください。出力仕様はシステム指示に従うこと。`;

    return await this.generate([{ text: userPrompt }], "daily");
  }

  private async generate(parts: GeminiPart[], kind: "window" | "daily"): Promise<string> {
    let lastError: unknown;

    for (let m = 0; m < GEMINI_MODELS.length; m++) {
      const model = GEMINI_MODELS[m]!;
      try {
        return await this.generateWithModel(parts, kind, model);
      } catch (err) {
        lastError = err;
        const hasFallback = m < GEMINI_MODELS.length - 1;
        if (hasFallback && isGeminiCapacityError(err)) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(
            `[gemini.${kind}] model ${model} capacity-unavailable, falling back to ${GEMINI_MODELS[m + 1]}: ${reason}`,
          );
          await sleep(2_000);
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  private async generateWithModel(
    parts: GeminiPart[],
    kind: "window" | "daily",
    model: string,
  ): Promise<string> {
    const profiles = kind === "daily"
      ? [DAILY_PROFILE, DAILY_FALLBACK_PROFILE]
      : [WINDOW_PROFILE, WINDOW_FALLBACK_PROFILE];

    let lastError: unknown;
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i]!;
      try {
        const { text, finishReason, usage } = await this.callGemini(parts, profile, model);
        if (finishReason === "MAX_TOKENS") {
          const usageHint = usage
            ? ` thoughts=${usage.thoughtsTokenCount ?? 0} output=${usage.candidatesTokenCount ?? 0}`
            : "";
          throw new Error(`Gemini output truncated at ${text.length} chars (MAX_TOKENS${usageHint})`);
        }
        if (!text) {
          throw new Error("Gemini returned empty visible response");
        }
        if (model !== PRIMARY_MODEL) {
          console.warn(`[gemini.${kind}] succeeded via fallback model ${model}`);
        }
        return text.trim();
      } catch (err) {
        lastError = err;
        // Capacity errors will fail the same way on every profile — don't burn attempts.
        if (isGeminiCapacityError(err)) {
          throw err;
        }
        if (i < profiles.length - 1) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[gemini.${kind}] profile ${i + 1}/${profiles.length} failed, retrying: ${reason}`);
          continue;
        }
      }
    }
    throw lastError;
  }

  private async callGemini(
    parts: GeminiPart[],
    profile: GenerationProfile,
    model: string,
  ): Promise<{
    text: string;
    finishReason: string | undefined;
    usage: GeminiResponse["usageMetadata"];
  }> {
    const body = {
      contents: [{ role: "user", parts }],
      systemInstruction: { parts: [{ text: this.systemPrompt }] },
      generationConfig: {
        temperature: 0.3,
        thinkingConfig: { thinkingBudget: profile.thinkingBudget },
        maxOutputTokens: profile.maxOutputTokens,
      },
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(`${endpoint}?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new GeminiApiError(res.status, errText, model);
    }

    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const text = extractResponseText(candidate?.content?.parts ?? []);
    return {
      text,
      finishReason: candidate?.finishReason,
      usage: data.usageMetadata,
    };
  }
}

/** Keep only visible answer parts; thinking content uses the same text field with thought=true. */
export function extractResponseText(parts: GeminiPart[]): string {
  return parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
}

export function formatTweet(t: Tweet): string {
  const time = t.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const prefix = t.isRetweet ? "[RT] " : t.isQuote ? "[QT] " : "";
  const imageNote = t.imageUrls && t.imageUrls.length > 0 ? ` [画像${t.imageUrls.length}枚添付]` : "";
  return `${time} @${t.author}: ${prefix}${t.text}${imageNote}`;
}
export async function fetchImageAsPart(url: string, timeoutMs = 5000): Promise<GeminiPart | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "image/*" },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[gemini.image] failed to fetch image ${url}: HTTP ${res.status}`);
      return null;
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const mimeType = contentType.split(";")[0]!.trim();
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    return {
      inlineData: {
        mimeType,
        data: base64,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[gemini.image] error fetching image ${url}: ${reason}`);
    return null;
  }
}

/**
 * Build Gemini request parts for a list of posts in a Window Summary,
 * embedding inline images if present.
 */
export async function buildWindowPromptParts(
  window: WindowName,
  posts: Tweet[],
): Promise<GeminiPart[]> {
  if (posts.length === 0) {
    return [
      {
        text: `【要約対象ウィンドウ】${window}

【ツイート群】
（この時間帯のツイートはありません）

上記ツイート群を要約してください。`,
      },
    ];
  }

  const parts: GeminiPart[] = [
    {
      text: `【要約対象ウィンドウ】${window}\n\n【ツイート群】\n`,
    },
  ];

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]!;
    const postHeader = `${i > 0 ? "\n\n" : ""}${formatTweet(post)}`;

    const imageParts: GeminiPart[] = [];
    if (post.imageUrls && post.imageUrls.length > 0) {
      const fetched = await Promise.all(post.imageUrls.map((url) => fetchImageAsPart(url)));
      for (const img of fetched) {
        if (img) imageParts.push(img);
      }
    }

    parts.push({ text: postHeader });
    for (const imgPart of imageParts) {
      parts.push(imgPart);
    }
  }

  parts.push({
    text: `\n\n上記ツイート群および添付画像（チャート、決算資料、統計データ、ニュースキャプチャ等）を精査して要約してください。`,
  });

  return parts;
}
