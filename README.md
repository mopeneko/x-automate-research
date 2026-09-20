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
- **要約**: Gemini 3.8 Flash（Flex 推論・半額）。既定は4セクション構造（主要ニュース / 銘柄・テーマ動向 / センチメント / 注目ポイント）。Pipelineごとに `systemPrompt` で上書き可能
- **状態**: `store/<pipelineId>/YYYY-MM-DD.json`（Pipelineごとの日次ポスト）+ `store/<pipelineId>/cursor.json`（Fetch Cursor / アトミック書込）
- **送信**: Telegram Bot API / プレーンテキスト / 4096字超過時は `(n/N)` マーカー付き自動分割。各Pipelineは自分のTelegram chatへ送る
- **障害**: 汎用I/Oは3回リトライ。Geminiの503/429（深夜の高負荷）は長めのバックオフ＋Flashモデルフォールバック。完全欠落時のみ失敗したPipeline自身のチャットに `⚠️` 通知

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

## Jevによる原文照合（任意）

`JEV_ENABLED=true`と`TYPESAFE_API_KEY`で有効になります。既定の`JEV_MODE=review`は、Geminiが生成した要約を原文と照合する方式です。

```dotenv
JEV_ENABLED=true
TYPESAFE_API_KEY=取得したキー
JEV_MODEL=jev-1.13.0
JEV_MODE=review
```

1. Geminiが従来どおり原文・画像から要約を生成します。
2. Jevが各要点と関連する原文候補を比較し、「推測・条件の断定化」と「方向・状態・因果の意味変化」を別々に検査します。
3. 誤り候補または本文で確認不能な行だけをGeminiに渡し、必要な場合に最小限の修正を提案させます。
4. 修正案をJevで再検査し、両検査でclearの確率が0.6以上となった行だけを置き換えます。その他の行、見出し、数値はコードで保持します。

誤り候補への振り分けはissue確率0.6以上、確認不能はunknown確率0.5以上です。これらは暫定の処理分岐用の閾値で、正答率を表す値ではありません。`confidence`とは区別しています。

### 制約・障害時の動作

- Jevは本文だけを読みます。画像の数値・内容、計算、外部情報の真偽、要約の網羅性は検証しません。確認不能を誤りとして扱いません。
- 原文候補は語句の一致で最大8投稿・約18KBを選び、時系列順に渡します。候補抽出の漏れや、複数の主張を含む行の判定の曖昧さが残ります。
- 1回の検査は最大48行・3並列・API待機60秒。超過・失敗した行は未検査として記録します。修正は1回のみ、Geminiの待機予算は120秒で、修正のみ通常枠（Standard）を利用します。混雑時は長時間リトライせず、既存のFlashフォールバックを順に試します。
- 修正時の原文候補を再検査でも固定します。数値変更、新しい行・見出し、対象外の行の変更は拒否します。修正できない場合や再検査が不十分な場合、元の行を残して未解決と記録します。
- API障害でも元の要約を維持します。失敗を「検証済み」とは扱いません。`store/<pipelineId>/reviews/<date>/<window>/`に検査結果・変更前後・参照投稿IDを保存します。保存失敗はログに記録します。
- 原文・分類・レビューの保存ファイルは自動削除しません。保管期間は運用側で管理してください。
- Jev検査と必要時のGemini修正のAPI費用が追加されます。下記の従来見積もりには含まれません。現在の要約生成自体のFlex待機設定は変更しません。

### 配信せずに比較する

```bash
bun run preview crypto 2026-09-19 夜場
```

Telegramには送らず、保存済み要約も上書きしません。`store/<pipelineId>/previews/<date>-<window>-<run>/`に保存します。

- `baseline.txt`: 最初に生成した要約
- `jev.txt`: **同じ要約**を検査・修正した結果（別々に生成して比較しません）
- `audit.md`: 修正採用箇所、未解決箇所、検査の限界を読める形式で表示
- `audit.json`: 各行の判定確率、参照投稿ID、変更前後、処理状態
- `input.json`: 原文とDaily用の時間帯別要約など

修正0件は「誤りがない」ことを意味しません。`audit.md`で未検査・未解決・API失敗を確認してください。Dailyの検査対象原文は当日の生投稿で、時間帯別要約そのものを正しい根拠とはしません。

### 旧分類方式と無効化

以前の投稿分類方式を比較する場合は`JEV_MODE=annotate`を明示してください。このモードでは投稿の種類・材料・根拠の分類をGeminiに付け加え、原文照合・修正は行いません。分類のキャッシュは`store/<pipelineId>/jev/<date>/`に保存されます。旧方式のプレビューはGeminiを別々に2回生成するため、生成のばらつきが混ざります。

`JEV_ENABLED=false`でどちらの処理も無効になります。キーは[TypeSafe Console](https://console.typesafe.ai/)で取得し、Gitへコミットしないでください。

## 想定コスト (1日500ポスト)
- SocialData 取得: ~$3/月（新規ポスト500件/日のみ課金 / `since_id` サーバフィルタでページ再課金なし）
- Gemini 要約: ~$1.9/月（Flex・Standard比 約半額）
- **合計: ~$5/月** (VPS除く)

## ファイル構成
```
src/
  config.ts      設定・ウィンドウ定義・リトライポリシー
  types.ts       ドメイン型 (Tweet, WindowName, WindowDef, ...)
  time.ts        JST時刻処理・ウィンドウ判定
  store.ts       Tweet Store (Pipeline別の日次JSON + cursor.json / アトミック書込)
  socialdata.ts  SocialData API クライアント
  jev.ts         任意のJev補助分類・キャッシュ・フォールバック
  review.ts      要約の原文照合・修正案再検査・レポート
  preview.ts     検査前後の比較（Telegram送信なし）
  gemini.ts      Summarizer (Gemini 3.8 Flash / Flex / 4セクション要約)
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
