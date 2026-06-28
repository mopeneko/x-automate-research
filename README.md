# X-List Market Summary

X の金融系公開リストのツイートを時間帯別に要約し、Telegram に送信するプログラム。
設計の経緯と用語は `CONTEXT.md` および `docs/adr/` を参照。

## アーキテクチャ

```
cron (VPS, JST) ─┬─ */15 * * * *  → poll   (SocialData取得 → 日次JSON + cursor.json)
                 ├─ 30 12 * * *   → send 朝場  (06:00-12:30 を要約・送信)
                 ├─ 30 16 * * *   → send 昼場  (12:30-16:30 を要約・送信)
                 └─ 0  0 * * *    → send 夜場  (16:30-24:00 + Daily を2通送信)
```

- **取得**: SocialData.tools `Get List Tweets`（公開リスト / since_id 相当のID比較で新規のみ課金）
- **要約**: Gemini 3.5 Flash（4セクション構造: 主要ニュース / 銘柄・テーマ動向 / センチメント / 注目ポイント）
- **状態**: `store/YYYY-MM-DD.json`（日次ポスト）+ `store/cursor.json`（Fetch Cursor / アトミック書込）
- **送信**: Telegram Bot API / プレーンテキスト / 4096字超過時は `(n/N)` マーカー付き自動分割
- **障害**: 3回リトライ指数バックオフ / 完全欠落時のみ同チャットに `⚠️` 通知

## セットアップ

### 1. 依存
```bash
bun install
```

### 2. 環境変数
```bash
cp .env.example .env
# 各値を設定:
#   SOCIALDATA_LIST_ID      XリストのID (x.com/i/lists/<ID> の数値)
#   SOCIALDATA_API_KEY      socialdata.tools の Bearer トークン
#   GEMINI_API_KEY          Google AI Studio の API キー
#   TELEGRAM_BOT_TOKEN      @BotFather から取得
#   TELEGRAM_CHAT_ID        送信先チャットID (@userinfobot で取得、または getUpdates)
#   STORE_DIR               (省略可) デフォルト ./store
```

### 3. VPS のタイムゾーンを JST に
```bash
sudo timedatectl set-timezone Asia/Tokyo
```

### 4. cron 登録
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

## 手動実行
```bash
# ポーリング（即時取得）
bun run poll

# 各ウィンドウ送信
bun run send:asa      # 朝場
bun run send:hiru     # 昼場
bun run send:yoru     # 夜場 + Daily

# テスト・型チェック
bun run test
bun run typecheck
```

## 想定コスト (1日500ポスト)
- SocialData 取得: ~$3/月
- Gemini 要約: ~$3.8/月
- **合計: ~$7/月** (VPS除く)

## ファイル構成
```
src/
  config.ts      設定・ウィンドウ定義・リトライポリシー
  types.ts       ドメイン型 (Tweet, WindowName, WindowDef, ...)
  time.ts        JST時刻処理・ウィンドウ判定
  store.ts       Tweet Store (日次JSON + cursor.json / アトミック書込)
  socialdata.ts  SocialData API クライアント
  gemini.ts      Summarizer (Gemini 3.5 Flash / 4セクション要約)
  telegram.ts    Telegram送信クライアント (4096字自動分割)
  retry.ts       指数バックオフリトライ
  poll.ts        ポーリングジョブ
  summarize.ts   ウィンドウ要約 + Daily要約(ハイブリッド)
  send.ts        送信ジョブ (24:00は夜場+Dailyの2通)
  index.ts       エントリ (poll | send <window>)
test/smoke.ts    ロジック統合テスト
CONTEXT.md       ドメイン用語集・決定一覧
docs/adr/        アーキテクチャ決定記録
```
