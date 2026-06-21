# 012_scrivener

行政書士試験の過去問を解く、自分専用の学習アプリ。

> ⚠️ 私的使用（著作権法30条）の範囲で作る前提のプロジェクトです。問題本文をオンラインに置かない・配布しない等の制約は **CLAUDE.md の「絶対に守ること」** を必ず参照してください。

## 公開URL / 別端末での使い方

- アプリ（フロント）: **https://bassie0303.github.io/012_scrivener/** （GitHub Pages・自動デプロイ）
  - 公開ビルドに載るのは **自作サンプル問題だけ**。実過去問は含まれない。
- **構成の原則: フロント＝公開ホスト / 履歴＝Supabase / 問題＝各端末ローカル。**
- 別端末（スマホ等）での初期設定:
  1. 上記URLを開く（PWAとして「ホーム画面に追加」可）。
  2. 画面上部フォームから自分のメール＋パスワードでサインイン → 履歴が端末間で合算同期。
  3. 本物の過去問を解くなら「問題データ → 取り込み / 差し替え」で自分の `questions.json` を取り込む
     （その端末の IndexedDB にだけ保存・サーバーには送らない）。未取り込みならサンプルで動く。

## ディレクトリ構成

```
012_scrivener/
├── CLAUDE.md                 # Claude Code 用の前提・禁止事項・設計（最初に読む）
├── README.md                 # これ
├── data/
│   ├── pipeline/
│   │   ├── parse_gyosei.py   # 問題PDFテキスト → 問題JSON
│   │   ├── add_answers.py    # 正解HTML → answer 付与
│   │   └── requirements.txt
│   └── processed/            # 生成物（r7_full.json 等）を置く。問題本文を含むのでローカル限定
├── web/                      # Vite + React + PWA アプリ
│   ├── src/GyoseiQuiz.jsx     # 出題UI（3型 / ○×変換 / 累積履歴）
│   ├── src/lib/               # history.js(IndexedDB+同期) / supabase.js
│   ├── src/data/             # 問題ローダー / 自作サンプル問題
│   ├── public/data/          # 実問題JSONの手動配置先（gitignore）
│   └── supabase/schema.sql   # 履歴テーブル + 加算RPC
└── docs/
    └── KICKSTART.md          # Claude Code に最初に貼るプロンプト
```

## セットアップ（データ生成）

```bash
cd data/pipeline
pip install -r requirements.txt

# 例: 令和7年度
curl -L -o r7_mondai.pdf https://gyosei-shiken.or.jp/pdf/r7_mondai.pdf
python -c "import pdfplumber;print('\n'.join(p.extract_text() or '' for p in pdfplumber.open('r7_mondai.pdf').pages))" > r7.txt
python parse_gyosei.py r7.txt --year R7 -o ../processed/r7.json

curl -L -o r7ans.html https://gyosei-shiken.or.jp/doc/exam/r7ans.html
python add_answers.py ../processed/r7.json r7ans.html -o ../processed/r7_full.json
```

→ `data/processed/r7_full.json`（問題59問＋正解）が完成。検証ポイントは CLAUDE.md 参照。

## フロント（`web/` — Vite + React + PWA）

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ に PWA をビルド
```

- 起動するとまず **自作サンプル問題** で動く（実過去問はリポジトリに含めない）。
- **実過去問は各端末ローカルに置く（サーバーには載せない）。** 2通り:
  - **アプリ内で取り込み**（公開デプロイ／別端末向けの本筋）: 画面上部「問題データ → 取り込み / 差し替え」から
    自分の `questions.json` を選ぶと、その端末の **IndexedDB にだけ**保存される（Supabase・公開ホストには送らない）。
  - **ローカル開発で手動配置**: `web/public/data/questions.json` に置く（`.gitignore` 済み・公開ビルドには含めない）。
  形式は [web/public/data/README.md](web/public/data/README.md)。読み込み優先順位は IndexedDB → ローカルファイル → サンプル。
- 履歴は **IndexedDB** に永続化（リロードで消えない）。
- **Supabase 同期（任意 / 個人用プロジェクト・非公開）**:
  1. `web/.env`（`.env.example` 参照）に **個人用プロジェクトの** URL・anon key を入れる（公開用プロジェクトのキーと混在させない）。
  2. `web/supabase/migrations/` の SQL を Supabase の SQL Editor で実行（手動・順番に）。
     - [0001_scrivener_history.sql](web/supabase/migrations/0001_scrivener_history.sql) … 履歴（解答回数・正答数）
     - [0002_scrivener_prefs.sql](web/supabase/migrations/0002_scrivener_prefs.sql) … 出題フィルタ等のUI設定をデバイス間で同期
  3. **Supabase ダッシュボード → Settings → API → Exposed schemas に `scrivener` を追加する**（anon は権限ゼロなのでアクセスできるのは本人だけ）。
  4. アプリ画面のフォームからメール＋パスワードでサインインすると同期が有効になる。

  schema=`scrivener` / RLS は `auth.uid() = user_id`（本人の行だけ・anon 全拒否）。
  同期内容は履歴（question_id と集計値）と出題フィルタ設定のみ（**問題本文は送らない**）。

## 状態

- ✅ データパイプライン（3型対応・欠番処理・検証付き）
- ✅ 出題UI（3型 / ○×変換 / 累積履歴）
- ✅ IndexedDB 永続化
- ✅ Supabase 履歴同期（履歴のみ・問題本文は送らない）
- ✅ PWA化（manifest + Service Worker、問題JSONは runtime キャッシュ）
- ⬜ 出題順ロジック（ランダム / 分野別 / 正答率順 / 間違い再出題） … CLAUDE.md の TODO 参照
