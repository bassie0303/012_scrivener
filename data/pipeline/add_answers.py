#!/usr/bin/env python3
"""
正解HTML（例: r7ans.html）から正解を抽出し、parse_gyosei.py の出力JSONに answer を付与する。

使い方:
  1) 正解HTMLをローカルに取得
       curl -L -o r7ans.html https://gyosei-shiken.or.jp/doc/exam/r7ans.html
  2) 問題JSON（parse_gyosei.py の出力）に正解を結合
       python add_answers.py r7.json r7ans.html -o r7_full.json

  ※ テキストファイル（get_text 済み）を直接渡すことも可:
       python add_answers.py r7.json r7ans.txt -o r7_full.json

付与される answer:
  - 5肢択一(tantou5): "3" のような単一の番号文字列
  - 多肢選択(tashi)  : {"ア":"5","イ":"10","ウ":"19","エ":"13"}
  - 記述式(kijutsu)  : {"model":"…正解例本文…","length":36}

欠番（問題1・58〜60など）の正解は questions に対応問がないため
「orphan（問題なし正解あり）」としてレポートのみ行う（自作問題の答え合わせ用）。
"""
import re
import sys
import json
import argparse

Z2H = str.maketrans("０１２３４５６７８９ＡＢＣＤＥＸＹＺ", "0123456789ABCDEXYZ")

# 多肢選択(41〜43): 問題N ア n イ n ウ n エ n
RE_TASHI = re.compile(
    r"問題\s*(4[1-3])\s*ア\s*(\d+)\s*イ\s*(\d+)\s*ウ\s*(\d+)\s*エ\s*(\d+)"
)
# 記述式(44〜46): 問題N …正解例の文字… （NN字）
# ※途中に別の「問題N」をまたがない（正解表の「問題44 …別紙」誤マッチを防ぐ）
RE_KIJUTSU = re.compile(
    r"問題\s*(4[4-6])\s*((?:(?!問題\s*\d).)*?)（\s*(\d+)\s*字）", re.S
)
# 5肢択一: 問題N d（dは1〜5、直後に数字が続かない）
RE_TANTOU = re.compile(r"問題\s*(\d+)\s*([1-5])(?!\d)")


def load_text(path: str) -> str:
    """HTMLなら get_text(separator=' ')、それ以外はそのまま読む。"""
    with open(path, encoding="utf-8") as f:
        data = f.read()
    if "<" in data and (".htm" in path.lower() or "<table" in data or "<body" in data):
        from bs4 import BeautifulSoup
        return BeautifulSoup(data, "html.parser").get_text(separator=" ")
    return data


def parse_answers(text: str):
    """正解テキストから {番号: 正解} を返す。番号は int。"""
    text = text.translate(Z2H)
    answers = {}

    # 1) 記述式（先に抜いて本文領域から除去：番号衝突を防ぐ）
    def _kijutsu(m):
        num = int(m.group(1))
        body = re.sub(r"[|\-\s　]", "", m.group(2))   # 表の罫線・空白を除去
        answers[num] = {"model": body, "length": int(m.group(3))}
        return " "  # 抜き取った箇所は空白化
    text = RE_KIJUTSU.sub(_kijutsu, text)

    # 2) 多肢選択
    def _tashi(m):
        num = int(m.group(1))
        answers[num] = {k: m.group(i + 2) for i, k in enumerate("アイウエ")}
        return " "
    text = RE_TASHI.sub(_tashi, text)

    # 3) 5肢択一（41〜46は上で処理済みなので拾わない）
    for m in RE_TANTOU.finditer(text):
        num = int(m.group(1))
        if 41 <= num <= 46:
            continue
        answers.setdefault(num, m.group(2))

    return answers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("questions_json", help="parse_gyosei.py の出力JSON")
    ap.add_argument("answers_file", help="正解HTML または get_text済みテキスト")
    ap.add_argument("-o", "--out", help="出力JSON（省略時は標準出力）")
    args = ap.parse_args()

    with open(args.questions_json, encoding="utf-8") as f:
        questions = json.load(f)

    answers = parse_answers(load_text(args.answers_file))

    # 結合
    q_nums = {q["number"] for q in questions}
    filled, type_mismatch = 0, []
    for q in questions:
        ans = answers.get(q["number"])
        if ans is None:
            q["answer"] = None
            continue
        q["answer"] = ans
        filled += 1
        # 型と正解の整合チェック（ヒント）
        t = q["type"]
        if t == "tantou5" and not isinstance(ans, str):
            type_mismatch.append((q["number"], t, "非単一番号"))
        if t == "tashi" and not (isinstance(ans, dict) and "ア" in ans):
            type_mismatch.append((q["number"], t, "アイウエ無し"))
        if t == "kijutsu" and not (isinstance(ans, dict) and "model" in ans):
            type_mismatch.append((q["number"], t, "正解例無し"))

    orphans = sorted(set(answers) - q_nums)   # 正解はあるが問題なし＝欠番

    print(f"[正解抽出] {len(answers)} 件", file=sys.stderr)
    print(f"[付与]     {filled}/{len(questions)} 問に answer を付与", file=sys.stderr)
    print(f"[欠番正解] {orphans}  ← 問題は非掲載だが正解あり（自作問題用に保存推奨）",
          file=sys.stderr)
    if type_mismatch:
        print(f"[型不一致] {type_mismatch}  ← 要確認", file=sys.stderr)
    else:
        print("[型整合]   OK（全問 type と answer 形式が一致）", file=sys.stderr)

    out = json.dumps(questions, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out)
        # 欠番正解も別ファイルに保存（自作問題の答え合わせ用）
        if orphans:
            orphan_path = args.out.replace(".json", "_orphan_answers.json")
            with open(orphan_path, "w", encoding="utf-8") as f:
                json.dump({str(n): answers[n] for n in orphans}, f,
                          ensure_ascii=False, indent=2)
            print(f"[書き込み] {args.out} / 欠番正解: {orphan_path}", file=sys.stderr)
        else:
            print(f"[書き込み] {args.out}", file=sys.stderr)
    else:
        print(out)


if __name__ == "__main__":
    main()
