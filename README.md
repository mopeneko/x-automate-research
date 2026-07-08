# X-List Market Summary

X の金融系公開リストのツイートを時間帯別に要約し、Telegram に送信するプログラム。
設計の経緯と用語は `CONTEXT.md` および `docs/adr/` を参照。

## アーキテクチャ

```
cron (VPS, JST) ─┬─ */15 * * * *  → poll   (全Pipelineを順次ポーリング)
                 ├─ 30 12 * * *   → send 朝場  (全Pipelineの 06:00-12:30 を要約・送信)
                 ├─ 30 16 * * *   → send 昼場  (全Pipelineの 12:30-16:30 を要約・送信)
                 └─ 0  0 * * *    → send 夜場  (全Pipelineの 16:30-24:00 + Daily を2通送信)
```

- **取得**: SocialData.tools `Get Search Results`（`list:{listId} since_id:{cursor}` クエリ / サーバ側 `since_id` フィルタで新規ポストのみ課金）。各Pipelineが1つのX Listを持つ
- **要約**: Gemini 3.5 Flash。既定は4セクション構造（主要ニュース / 銘柄・テーマ動向 / センチメント / 注目ポイント）。Pipelineごとに `systemPrompt` で上書き可能
- **状態**: `store/<pipelineId>/YYYY-MM-DD.json`（Pipelineごとの日次ポスト）+ `store/<pipelineId>/cursor.json`（Fetch Cursor / アトミック書込）
- **送信**: Telegram Bot API / プレーンテキスト / 4096字超過時は `(n/N)` マーカー付き自動分割。各Pipelineは自分のTelegram chatへ送る
- **障害**: 3回リトライ指数バックオフ / 完全欠落時のみ失敗したPipeline自身のチャットに `⚠️` 通知

1つの **Pipeline** は、1つの X List、1つの Telegram chat、そのPipeline専用の Tweet Store + Fetch Cursor、および任意の Pipeline System Prompt の組です。Summary Window と Summarizer バックエンドは全Pipelineで共有しますが、`systemPrompt` がある Pipeline は要約の市場文脈と出力構造を自前で定義します。

## セットアップ

### 1. 依存
```bash
bun install
```

### 2. 環境変数
```bash
cp .env.example .env
# 各値を設定:
#   SOCIALDATA_API_KEY      socialdata.tools の Bearer トークン
#   GEMINI_API_KEY          Google AI Studio の API キー
#   TELEGRAM_BOT_TOKEN      @BotFather から取得
#   STORE_DIR               (省略可) デフォルト ./store
```

### 3. pipelines.json を作成
リポジトリ直下に `pipelines.json` を置き、各Pipelineを宣言します。

```json
[
  {
    "id": "main",
    "listId": "1234567890123456789",
    "telegramChatId": "-1001234567890"
  },
  {
    "id": "crypto",
    "listId": "9876543210987654321",
    "telegramChatId": "-1001987654321",
    "systemPrompt": "あなたは暗号資産市場のツイート要約アナリストです。\n暗号通貨・トークン・チェーン・DeFi・マクロに関するツイート群を受け取り、暗号資産投資家向けの要約を生成します。\n\n【出力仕様】\n必ず以下の4セクション構造で出力すること。セクション見出しは記号付きで正確に：\n\n【主要ニュース】\n・（簡潔な箇条書き、3〜7項目）\n\n【トークン・テーマ動向】\n・$ティッカー または テーマ名: 動向（数値は原文から正確に保持）\n\n【センチメント】\n強気 / 中立 / 弱気 のいずれか1つ ＋ (好材料x / 悪材料y)\n\n【注目ポイント】\n・次の時間帯への引き継ぎ事項（1〜2項目）\n\n【ルール】\n- 出力は日本語。\n- 日本株・個別日本企業の文脈に無理に寄せない。リストが暗号資産ならその文脈で要約する。\n- ティッカーと数値は原文から正確に抽出し、改変しない。\n- 元ツイートへのリンク・URLは一切含めない。\n- 推測や憶測は加えず、ツイート内容に基づくこと。\n- セクション見出し以外のMarkdown記法は使わない。\n- ウィンドウ名のヘッダーは不要（呼び出し側で付与する）。"
  }
]
```

- `id`: filesystem-safe slug (`[a-z0-9-]+`)。`store/<id>/` やログ識別子に使われます。
- `listId`: `x.com/i/lists/<ID>` の数値文字列
- `telegramChatId`: そのPipelineの送信先Telegram chat ID（Error Notificationも同じチャット）
- `systemPrompt` (任意): そのPipelineの Summarizer system instruction。**指定時は既定の日本株向けプロンプトを完全置換**します（出力仕様も含めて自己完結させてください）。未指定の Pipeline は従来どおり既定プロンプトを使います。

既存の単一Pipeline環境から移行する場合は、従来のリスト/チャットを `main` として宣言し、既存の `store/*.json` を `store/main/` に移動してください。

### 4. VPS のタイムゾーンを JST に
```bash
sudo timedatectl set-timezone Asia/Tokyo
```

### 5. cron 登録
`crontab -e`:
```
# 環境変数を読み込んで実行 (例: ~/.env を source)
SHELL=/bin/bash

# 平日: 朝場・昼場(06:00-16:30) → 30分間隔, 夜場・深夜 → 1時間間隔
*/30 6-16 * * 1-5 cd /path/to/repo && /path/to/bun run src/index.ts poll >> logs/poll.log 2>&1
0    0-5,17-23 * * 1-5 cd /path/to/repo && /path/to/bun run src/index.ts poll >> logs/poll.log 2>&1

# 週末: 1時間間隔
0 * * * 0,6 cd /path/to/repo && /path/to/bun run src/index.ts poll >> logs/poll.log 2>&1

# 送信ジョブ
30 12 * * * cd /path/to/repo && /path/to/bun run src/index.ts send 朝場 >> logs/send.log 2>&1
30 16 * * * cd /path/to/repo && /path/to/bun run src/index.ts send 昼場 >> logs/send.log 2>&1
0  0  * * * cd /path/to/repo && /path/to/bun run src/index.ts send 夜場 >> logs/send.log 2>&1
```

cron のコマンド形は単一Pipeline時代と同じですが、内部では宣言済みの全Pipelineを順次処理します。特定Pipelineだけを実行したい場合は `bun run src/index.ts poll main` や `bun run src/index.ts send 朝場 main` のように `pipelineId` を追加できます。

## 手動実行
```bash
# ポーリング（即時取得）
bun run poll
bun run src/index.ts poll main

# 各ウィンドウ送信
bun run send:asa      # 朝場
bun run send:hiru     # 昼場
bun run send:yoru     # 夜場 + Daily
bun run src/index.ts send 朝場 main

# テスト・型チェック
bun run test
bun run typecheck
```

## 想定コスト (1日500ポスト)
- SocialData 取得: ~$3/月（新規ポスト500件/日のみ課金 / `since_id` サーバフィルタでページ再課金なし）
- Gemini 要約: ~$3.8/月
- **合計: ~$7/月** (VPS除く)

## ファイル構成
```
src/
  config.ts      設定・ウィンドウ定義・リトライポリシー
  types.ts       ドメイン型 (Tweet, WindowName, WindowDef, ...)
  time.ts        JST時刻処理・ウィンドウ判定
  store.ts       Tweet Store (Pipeline別の日次JSON + cursor.json / アトミック書込)
  socialdata.ts  SocialData API クライアント
  gemini.ts      Summarizer (Gemini 3.5 Flash / 4セクション要約)
  telegram.ts    Telegram送信クライアント (4096字自動分割)
  retry.ts       指数バックオフリトライ
  poll.ts        ポーリングジョブ
  summarize.ts   ウィンドウ要約 + Daily要約(ハイブリッド)
  send.ts        送信ジョブ (24:00は夜場+Dailyの2通)
  index.ts       エントリ (poll [pipelineId] | send <window> [pipelineId])
test/smoke.ts    ロジック統合テスト
pipelines.json   Pipeline定義 ({ id, listId, telegramChatId, systemPrompt? } の配列)
CONTEXT.md       ドメイン用語集・決定一覧
docs/adr/        アーキテクチャ決定記録
```
