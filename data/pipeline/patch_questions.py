#!/usr/bin/env python3
"""
questions.json への局所パッチ（生成済みの解説を保持したまま補修）。

- C-3: 選択肢が未抽出の組合せ問題（r2-7 / r4-49 / r5-57）に、各 *_full.json の raw 末尾から
       「1 ア・イ」形式の5択を復元して付与する。
       （原因: parse_gyosei が（注）以降を選択肢でなく脚注として拾ったため choices が空だった）
- C-2: R6-34（公式「全員正解」の没問）を参考収録する（all_correct=true）。

＊問題本文はこのスクリプトに書かない。すべてローカルの *_full.json（.gitignore）から取得する。
  出力 questions.json も端末ローカル限定（同期・公開しない）。
"""
import re
import os
import sys
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_field import classify_field  # 追加問題に分野を付与

CHOICE_RE = re.compile(r"^([1-5])[ 　]+(\S.*)$")

# C-3 対象（id と元データの年度ファイル）
C3 = {"r2-7": "r2", "r4-49": "r4", "r5-57": "r5"}


def load_full(processed, year):
    with open(f"{processed}/{year}_full.json", encoding="utf-8") as f:
        return {q["id"]: q for q in json.load(f)}


def extract_combo_choices(raw):
    """raw 末尾の連続する『N 本文』(N=1..5) を抽出。1〜5が揃えば dict、無ければ None。"""
    choices, start = {}, None
    lines = (raw or "").split("\n")
    for i, line in enumerate(lines):
        m = CHOICE_RE.match(line.strip())
        if not m:
            continue
        n = m.group(1)
        if n == "1":
            choices, start = {}, i   # 新しい塊の起点
        choices[n] = m.group(2).strip()
    if start is None or not all(str(k) in choices for k in range(1, 6)):
        return None
    return {str(k): choices[str(k)] for k in range(1, 6)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="questions.json（{年度:[...]} 形式・上書き）")
    ap.add_argument("--processed", default="../processed", help="*_full.json のあるディレクトリ")
    args = ap.parse_args()

    with open(args.path, encoding="utf-8") as f:
        data = json.load(f)
    index = {q["id"]: q for v in data.values() for q in v}

    fulls = {}  # year -> {id: q}
    def full(year):
        if year not in fulls:
            fulls[year] = load_full(args.processed, year)
        return fulls[year]

    log = []

    # C-3: 選択肢を復元
    for qid, year in C3.items():
        q = index.get(qid)
        if not q:
            log.append(f"C-3 {qid}: questions.json に無し（スキップ）"); continue
        if q.get("choices"):
            log.append(f"C-3 {qid}: 既に選択肢あり（スキップ）"); continue
        raw = (full(year).get(qid) or {}).get("raw")
        ch = extract_combo_choices(raw)
        if not ch:
            log.append(f"C-3 {qid}: raw から5択を復元できず（要手動）"); continue
        q["choices"] = ch
        log.append(f"C-3 {qid}: 選択肢5個を復元（answer={q.get('answer')}）")

    # C-2: R6-34 を参考収録（既収録なら分野欠落だけ補修）
    existing = index.get("r6-34")
    if existing is not None:
        if not existing.get("field"):
            existing["field"] = classify_field(existing)
            log.append(f"C-2 r6-34: 分野を補修（{existing['field']}）")
        else:
            log.append("C-2 r6-34: 既に収録済み（スキップ）")
    else:
        src = full("r6").get("r6-34")
        if not src:
            log.append("C-2 r6-34: r6_full.json に無し（スキップ）")
        else:
            q = dict(src)
            q.pop("raw", None)
            q["all_correct"] = True
            q["answer"] = None
            q["field"] = classify_field(q)
            q["explanation"] = ("この問題は公式に「全員正解」とされた没問（正解が一つに定まらず"
                                "全受験者が正解扱い）。参考として収録。どの肢を選んでも正解になる。")
            r6 = data.get("R6", [])
            r6.append(q)
            r6.sort(key=lambda x: x.get("number", 0))
            data["R6"] = r6
            log.append(f"C-2 r6-34: all_correct で参考収録（分野 {q['field']}）")

    with open(args.path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print("\n".join(log))
    total = sum(len(v) for v in data.values())
    print(f"[書き込み] {args.path}（合計 {total}問）")


if __name__ == "__main__":
    main()
