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
- **欠番（問題1・58〜60）を公式から無理に取得しない。** これらは第三者著作物が素材のためセンターも非掲載＝入手不可。
  スキップするか、条文・判例ベースの**自作問題**（自分の著作物）で補完する。
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

```bash
# 1) 問題PDF → テキスト抽出（pdfplumber 推奨。多肢の語群が崩れる年度は pdftotext -layout を試す）
curl -L -o r7_mondai.pdf https://gyosei-shiken.or.jp/pdf/r7_mondai.pdf
python -c "import pdfplumber;print('\n'.join(p.extract_text() or '' for p in pdfplumber.open('r7_mondai.pdf').pages))" > r7.txt

# 2) テキスト → 問題JSON（型別に構造化、欠番レポート）
python parse_gyosei.py r7.txt --year R7 -o ../processed/r7.json

# 3) 正解HTML → answer 付与（型別、字数チェックサム、欠番正解は別ファイルに退避）
curl -L -o r7ans.html https://gyosei-shiken.or.jp/doc/exam/r7ans.html
python add_answers.py ../processed/r7.json r7ans.html -o ../processed/r7_full.json
```

成果物 = `data/processed/r7_full.json`（問題59問＋正解）。他年度は `--year R6` 等で同じ処理。

**生成後の検証ポイント:**
- `[欠番]` が `[1, 58, 59, 60]` のみ → パース成功（他番号が混じれば分割失敗）
- `tashi` 各問の `word_bank` が20個ある
- `[型整合] OK` / 記述式の字数チェックサム一致

---

## データスキーマ

問題（`*_full.json` の各要素）:
```jsonc
{
  "id": "r7-2", "year": "R7", "number": 2,
  "type": "tantou5" | "tashi" | "kijutsu",
  "field": "基礎法学",            // 分野（任意。UI表示用）
  "stem": "…設問文…",
  "choices": { "1": "…", "5": "…" },          // tantou5
  "word_bank": { "1": "…", "20": "…" },        // tashi
  "reference": "建築基準法82条…",              // kijutsu（参照条文がある場合）
  "answer": "4"                                // tantou5
         |  { "ア": "5", "イ": "10", "ウ": "19", "エ": "13" }   // tashi
         |  { "model": "…正解例…", "length": 36 },              // kijutsu
  "note": null, "raw": "…原文…"
}
```

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

- フロント: React。雛形は `web/GyoseiQuiz.jsx`。**PWA**（オフライン・ホーム追加・ストア審査不要で複数端末）か Next.js。
  問題JSONはバンドル。`GyoseiQuiz.jsx` の `QUESTIONS` 定数を `r7_full.json` の import に差し替える。
- 履歴同期: Supabase（無料枠で1ユーザーぶんは充分）。`history` は上記の集計型で upsert（attempts/correct_count を +1 加算）。
- デザイン: 「答案用紙」メタファー。藍墨(#1c2c4c)＋朱(#c43d2b)、設問は明朝・UIはゴシック、
  採点は○×の朱印スタンプ、記述式はマス目、択一はマークシート円。トークンは `GyoseiQuiz.jsx` 上部の `C` を参照。

---

## 実装済み / TODO

**実装済み**
- パイプライン2本（`parse_gyosei.py` / `add_answers.py`）— 3型対応・欠番処理・各種検証
- Web アプリ `web/`（Vite + React + PWA）— 3型出題 / 5択→○×一問一答 変換器 / 累積履歴
  - 問題は `web/src/data/loadQuestions.js` が読む。実過去問は `web/public/data/questions.json`（gitignore）
    に手動配置、無ければ自作サンプル（`web/src/data/sampleQuestions.js`）で動く。
    ＊`web/src/` に過去問本文を書かない（public リポジトリ事故防止）。
  - 履歴は **IndexedDB** に永続化（`web/src/lib/history.js`。localStorage は使わない）。
  - **Supabase 同期**（`web/src/lib/supabase.js` + `web/supabase/schema.sql`）。
    `bump_history` RPC で attempts/correct_count をサーバー側 +1 加算（複数端末で合算）。
    送るのは question_id と集計値のみ。オフライン時は outbox に貯めて再送。
  - **PWA化**（`vite-plugin-pwa`）。問題JSONは runtime キャッシュ（同梱しない）。

**TODO（おすすめ順）**
1. フルPDFで `r7_full.json` を生成し精度確認（多肢の語群20個 / 記述の字数一致 / 欠番[1,58,59,60]）
2. 全年度 R2〜R7 を生成し `web/public/data/questions.json` にまとめて配置
3. 出題順ロジック（ランダム / 分野別 / 正答率の低い順 / 間違えた問題の再出題）
4. ○×変換の取りこぼしログ（極性判定できない5択を検出して一覧化）

---

## やってはいけないこと（再掲・要点）

- 問題本文・選択肢・正解例を **クラウド/同期/公開エンドポイント** に出す
- 問題データを **配布・公開** する
- 欠番を公式から無理に取得しようとする
- キーをハードコードする
- 実機PWAで `localStorage` 前提のデータ設計にする（永続化は IndexedDB 等を使う）
