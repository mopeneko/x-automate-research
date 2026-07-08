import type { Tweet, WindowName } from "./types.ts";

/**
 * Summarizer: Gemini 3.5 Flash. Produces the four-section Summary Schema.
 * For Daily, uses the hybrid method (raw posts + intraday Window Summaries).
 * See ADR-0002.
 */

const MODEL = "gemini-3.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Gemini caps thinking + visible output against maxOutputTokens. See ADR-0002. */
interface GenerationProfile {
  thinkingBudget: number;
  maxOutputTokens: number;
}

const WINDOW_PROFILE: GenerationProfile = {
  thinkingBudget: -1,
  maxOutputTokens: 4096,
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

interface GeminiPart {
  text?: string;
  thought?: boolean;
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
- 元ツイートへのリンク・URLは一切含めない。
- 推測や憶測は加えず、ツイート内容に基づくこと。
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
    const input = posts.length === 0
      ? "（この時間帯のツイートはありません）"
      : posts.map(formatTweet).join("\n\n");

    const userPrompt = `【要約対象ウィンドウ】${window}

【ツイート群】
${input}

上記ツイート群を要約してください。`;

    return await this.generate(userPrompt, "window");
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

    return await this.generate(userPrompt, "daily");
  }

  private async generate(userPrompt: string, kind: "window" | "daily"): Promise<string> {
    const profiles = kind === "daily" ? [DAILY_PROFILE, DAILY_FALLBACK_PROFILE] : [WINDOW_PROFILE];

    let lastError: unknown;
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i]!;
      try {
        const { text, finishReason, usage } = await this.callGemini(userPrompt, profile);
        if (finishReason === "MAX_TOKENS") {
          const usageHint = usage
            ? ` thoughts=${usage.thoughtsTokenCount ?? 0} output=${usage.candidatesTokenCount ?? 0}`
            : "";
          throw new Error(`Gemini output truncated at ${text.length} chars (MAX_TOKENS${usageHint})`);
        }
        if (!text) {
          throw new Error("Gemini returned empty visible response");
        }
        return text.trim();
      } catch (err) {
        lastError = err;
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
    userPrompt: string,
    profile: GenerationProfile,
  ): Promise<{
    text: string;
    finishReason: string | undefined;
    usage: GeminiResponse["usageMetadata"];
  }> {
    const body = {
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: this.systemPrompt }] },
      generationConfig: {
        temperature: 0.3,
        thinkingConfig: { thinkingBudget: profile.thinkingBudget },
        maxOutputTokens: profile.maxOutputTokens,
      },
    };

    const res = await fetch(`${ENDPOINT}?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
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

function formatTweet(t: Tweet): string {
  const time = t.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const prefix = t.isRetweet ? "[RT] " : t.isQuote ? "[QT] " : "";
  return `${time} @${t.author}: ${prefix}${t.text}`;
}
