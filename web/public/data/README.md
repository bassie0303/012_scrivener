# public/data

実際の過去問JSONを **手動で** 置く場所。

- ここに `questions.json` を置くと、アプリが自動でそれを読み込む（無ければ自作サンプルで動く）。
- このフォルダの `*.json` は `.gitignore` 済み。**問題本文を含むため絶対にコミット・公開しない。**

## 置き方

データパイプライン（`../../data/pipeline/`）で生成した `r7_full.json` 等を、配列として
まとめて `questions.json` に保存する。次のいずれの形式でも読み込める:

```jsonc
// 1) 配列そのまま
[ { "id": "r7-2", "year": "R7", "number": 2, "type": "tantou5", ... }, ... ]

// 2) 年度ごと（自動で平坦化される）
{ "R7": [ ... ], "R6": [ ... ] }
```

例:
```bash
# data/processed/ に各年度を生成済みとして
cp ../../data/processed/r7_full.json questions.json
# 複数年度をまとめたい場合は jq などで結合する
```
