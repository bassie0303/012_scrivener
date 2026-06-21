# 012_scrivener — 行政書士試験 過去問アプリ

自分専用の行政書士試験 過去問学習アプリ。**公開・販売はしない**（私的使用の範囲で成立させる）。
複数端末で使い、解答履歴・進捗だけをオンライン同期する。

---

## 絶対に守ること (IMPORTANT / YOU MUST)

このアプリは「私的使用のための複製（著作権法30条）」の範囲だから成立している。
試験問題の著作権は行政書士試験研究センターに帰属し、書籍・HP等への掲載には許諾が必要。
**以下を破る実装は、その法的前提を崩すので絶対にしない。**

- **問題本文を絶対にオンラインに置かない。**
  - 問題JSON（問題文・選択肢・語群・記述の正解例）は端末ローカル / アプリ同梱のみ。
  - public バケットや「問題を返す API エンドポイント」を作らない。
  - 各端末へは「アプリにバンドル」or「自分で手動配置」。サーバーから配信する形にしない。
- **同期するのは履歴だけ。** 同期ペイロードに問題本文・選択肢・正解例テキストを含めない。
  送るのは `question_id` と集計値（attempts / correct_count など）のみ。
- **配布・公開しない。** アプリや問題データを他人に渡した瞬間に「私的使用」を外れる。常に1ユーザー（本人）想定。
- **欠番（非掲載問題）を公式から無理に取得しない。** これらは第三者著作物が素材のためセンターも非掲載＝入手不可。
  典型は問題1・58〜60だが、**年度により追加で非掲載がある**（実績: R2-5 / R3-7 / R5-6 / R5-56）。
  判定法: 正解HTMLには非掲載問題の正解も載るので、`add_answers.py` の「欠番正解(orphan)」に出れば非掲載＝正常。
  スキップするか、条文・判例ベースの**自作問題**（自分の著作物）で補完する。
- **原本（公式PDF・正解HTML）と生成JSONはコミットしない。** `data/QA/`（原本）・`data/processed/*.json`・
  `web/public/data/*.json` は `.gitignore` 済み。公開リポジトリ／公開ビルドに問題本文を入れない。
- **秘密情報はハードコードしない。** Supabase等のキーは `.env` に置く（`.gitignore` 済みにする）。

---

## これは何か（データの出所）

実施団体「行政書士試験研究センター」が直近6年分（R2〜R7）を公開している。

- 問題PDF: `https://gyosei-shiken.or.jp/pdf/r7_mondai.pdf`（`r6_`, `r5_` … と続く）
- 正解HTML: `https://gyosei-shiken.or.jp/doc/exam/r7ans.html`（`r6ans.html` …）
- 一覧: `https://gyosei-shiken.or.jp/doc/exam/index.html`

問題は **3つの型**：
- `tantou5` … 5肢択一（正解は "1"〜"5"）
- `tashi` … 多肢選択（空欄ア〜エ × 語群1〜20。正解は {ア,イ,ウ,エ}）
- `kijutsu` … 記述式（40字程度。自動採点不可＝自己採点。正解例＋字数を保持）

---

## データパイプライン（`data/pipeline/`）

原本（公式PDF・正解HTML）は `data/QA/r{2..7}_mondai.pdf` / `r{2..7}ans.html` に置く（gitignore）。
venv: `python3 -m venv venv && ./venv/bin/pip install -r requirements.txt`（pdfplumber / beautifulsoup4）。
崩れPDF対策の `pdftotext -layout` は poppler 導入済み（`/opt/homebrew`）。

スクリプトは4本:
- `parse_gyosei.py` … PDF抽出テキスト → 問題JSON（型別構造化・ニセ問題/ページ番号/見出し除去・欠番レポート）
- `add_answers.py` … 正解HTML → answer 付与（型別・字数チェックサム・欠番正解は `_orphan_answers.json` へ退避）
- `classify_field.py` … 分野分類（番号レンジ主軸＋設問文の明示キーワードで補正。9分野）
- `build_questions.py` … 全年度を一括処理して結合・記述の正解例整形・分野付与・`raw`除去 → 1ファイル出力

```bash
cd data/pipeline
# 全年度(R2〜R7)を一括生成 → 端末取り込み用 questions.json（と開発用コピー）
./venv/bin/python build_questions.py -o ../processed/questions.json -o ../../web/public/data/questions.json
```

成果物 = `data/processed/questions.json`（`{ "R2":[…], …, "R7":[…] }` 形式・**331問**）。

**生成後の検証ポイント:**
- 欠番が `[1, 58, 59, 60]` ＋ その年度の追加非掲載のみか（それ以外が混じれば分割失敗）。
  追加非掲載は `add_answers.py` の orphan に出ているか（出ていれば正常）で判定する。
- `tashi` 各問の `word_bank` が20個ある
- `[型整合] OK` / 記述式の `len(model) == length`（字数チェックサム一致）
- R6-34 は公式「全員正解」（没問・単一正解なし）のため自動で除外される（正常）

---

## データスキーマ

問題（`questions.json` の各要素）:
```jsonc
{
  "id": "r7-2", "year": "R7", "number": 2,
  "type": "tantou5" | "tashi" | "kijutsu",
  "field": "憲法",               // 分野（classify_field.py が必ず付与。下記9分野）
  "stem": "…設問文…",
  "choices": { "1": "…", "5": "…" },          // tantou5
  "word_bank": { "1": "…", "20": "…" },        // tashi
  "reference": "建築基準法82条…",              // kijutsu（参照条文がある場合）
  "answer": "4"                                // tantou5
         |  { "ア": "5", "イ": "10", "ウ": "19", "エ": "13" }   // tashi
         |  { "model": "…正解例…", "length": 36 },              // kijutsu
  "note": null
}
```
分野（`field`）: 基礎法学 / 憲法 / 行政法 / 民法 / 商法・会社法 / 政治・経済・社会 /
情報通信・個人情報保護 / 行政書士法等 / 文章理解。
＊`raw`（原文）は `build_questions.py` が端末配布版で除去する（容量・本文露出を減らす）。

履歴（Supabase `history` テーブル。**問題本文は含めない**）:
```jsonc
{
  "user_id": "…",
  "question_id": "r7-2",     // ○×一問一答は "r7-2-3" のように肢単位
  "attempts": 5,             // 解くたび +1
  "correct_count": 3,        // 正解で +1
  "last_result": true,
  "last_chosen": "4",
  "updated_at": "…"
}
```

---

## 技術スタック（暫定）

- フロント: `web/`（Vite + React + **PWA**）。本体は `web/src/GyoseiQuiz.jsx`。
  - **公開デプロイ = GitHub Pages**（プロジェクトページ＝サブパス `/012_scrivener/`）。`vite.config.js` が
    本番ビルド時だけ `base="/012_scrivener/"` にする（dev はルート）。URL: https://bassie0303.github.io/012_scrivener/
  - 問題は各端末で取り込む（バンドルしない）。出題は 年度 × 分野 × 学習対象（未挑戦/間違えた/正答率低/すべて）で絞れる。
  - 本文の文字サイズ調整あり（CSS変数 `--rs`、小/中/大/特大、localStorage 保存）。集計（分野別の習得状況）画面あり。
- 履歴同期: Supabase（無料枠で1ユーザーぶんは充分）。`history` は上記の集計型で upsert（attempts/correct_count を +1 加算）。
  - **個人用プロジェクト（非公開）** を使う。公開用プロジェクトのキーと混在させない。
  - **schema = `scrivener`**（public に置かない）。supabase-js は `createClient(..., { db: { schema: "scrivener" } })` で初期化。
  - **単一ユーザー / anon は全拒否。** RLS で `auth.uid() = user_id`（＝Supabase Auth でサインインした本人の行だけ）。
    anon には schema usage を revoke 済みなので、Exposed schemas に出しても anon からは何も見えない。
  - 接続情報（URL・anon key）は **`.env` から読む**（ハードコード禁止・`.gitignore` 済み）。env 変数は Vite 規約の `VITE_` プレフィックス。
  - 不変条件は維持: **問題本文を同期しない。** `history` に送るのは `question_id` と集計値（attempts/correct_count/last_result/last_chosen）のみ。
- デザイン: 「答案用紙」メタファー。藍墨(#1c2c4c)＋朱(#c43d2b)、設問は明朝・UIはゴシック、
  採点は○×の朱印スタンプ、記述式はマス目、択一はマークシート円。トークンは `GyoseiQuiz.jsx` 上部の `C` を参照。

---

## 実装済み / TODO

**実装済み**
- パイプライン4本（`parse_gyosei.py` / `add_answers.py` / `classify_field.py` / `build_questions.py`）
  — 3型対応・欠番処理・分野分類・各種検証。**全年度R2〜R7をJSON化済み（331問）**。
- 分野分類（9分野）・出題の年度/分野/学習対象フィルタ・集計画面・文字サイズ調整
- Web アプリ `web/`（Vite + React + PWA）— 3型出題 / 5択→○×一問一答 変換器 / 累積履歴
  - **公開構成の原則: フロント＝公開ホスト / 履歴＝Supabase / 問題＝各端末ローカル。**
  - 問題は `web/src/data/loadQuestions.js` が読む。優先順位 ①IndexedDB 取り込み済み（画面の取り込みUI＝
    `importQuestions()`／各端末ローカルに保存・サーバーに送らない）→ ②`web/public/data/questions.json`
    （ローカル開発の手動配置・gitignore・公開ビルドに含めない）→ ③自作サンプル（`sampleQuestions.js`）。
    ＊`web/src/` に過去問本文を書かない。公開デプロイのビルドにも実問題を含めない。
  - 履歴は **IndexedDB** に永続化（`web/src/lib/history.js`。localStorage は使わない）。
  - **Supabase 同期**（`web/src/lib/supabase.js` + `web/supabase/migrations/0001_scrivener_history.sql`）。
    schema=`scrivener` / RLS `auth.uid()=user_id`（anon全拒否）。同期は「取得→+1→upsert」、
    送るのは question_id と集計値のみ。未サインイン/オフラインは outbox に貯めて再送。
  - **PWA化**（`vite-plugin-pwa`）。問題JSONは同梱せず、各端末で取り込む。

**TODO（おすすめ順）**
1. 出題順の追加（ランダム出題 / 行間調整など）。※分野・年度・学習対象の絞り込みは実装済み
2. 分野分類の精度向上（`classify_field.py`。例: 「裁判制度／簡易裁判所」で "代理" 等の語に誤発火する稀ケース）
3. ○×変換の取りこぼしログ（極性判定できない5択を検出して一覧化）
4. R6-34（全員正解の没問）を「常に正解＋注記」で参考収録するか検討（既定は除外）

---

## やってはいけないこと（再掲・要点）

- 問題本文・選択肢・正解例を **クラウド/同期/公開エンドポイント** に出す
- 問題データを **配布・公開** する
- 欠番を公式から無理に取得しようとする
- キーをハードコードする
- **データ**（問題・履歴）の永続化を `localStorage` 前提で設計する（→ IndexedDB を使う）。
  ＊文字サイズ等の軽量なUI設定だけは `localStorage` 可（データではないため）。
