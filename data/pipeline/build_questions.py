#!/usr/bin/env python3
"""
各年度の *_full.json を1つの questions.json に結合する（端末取り込み用）。

- 出力形式は { "R2": [...], ..., "R7": [...] }（アプリ側で平坦化して読む）。
- 自動補正:
    (1) 多肢選択(41〜43想定)が tantou5 に誤分類され answer が {ア..} の場合、
        type=tashi に直し、raw から語群(1〜20)を再抽出する。
    (2) answer が無い（None）問題は採点できないため除外し、レポートに出す。
- 問題本文はここにしか無い（サーバーには載せない）。出力JSONはすべて .gitignore 済み。
"""
import re
import sys
import json
import argparse

sys.path.insert(0, ".")
from parse_gyosei import extract_word_bank  # 語群再抽出を流用

YEARS = ["R2", "R3", "R4", "R5", "R6", "R7"]
TOTAL = 60
NONPUBLISHED = {58, 59, 60}  # 文章理解（第三者著作物素材）。公式も非掲載


def is_example(q):
    """注意事項の『記入例』の見本問題（実問題ではない）を判定して除外するため。"""
    stem = q.get("stem", "") or ""
    choices = q.get("choices") or {}
    word_bank = q.get("word_bank") or {}
    # 5肢択一の記入例: 「日本の首都」/ 選択肢に「（正解）」を明記
    if "日本の首都" in stem:
        return True
    if any("（正解）" in (v or "") for v in choices.values()):
        return True
    # 多肢選択の記入例: 本文・語群が「…………」のプレースホルダ
    blob = stem + "".join(str(v) for v in word_bank.values())
    if "…………" in blob:
        return True
    if word_bank and all(set(str(v)) <= set("…・ 　") for v in word_bank.values()):
        return True
    return False


def clean_kijutsu_answer(q):
    """記述式の正解例を整形。「正解例1/正解例2」等のラベルを除去し、
    表示する正解例と length（字数）を自己整合させる。
    ＊複数正解例が併記される問題があり、抽出が別の正解例を拾う場合があるが、
      いずれも公式の正解例なので本文はそのまま採用し、length を実字数に合わせる。"""
    if q.get("type") != "kijutsu":
        return False
    a = q.get("answer")
    if not isinstance(a, dict) or "model" not in a:
        return False
    model = re.sub(r"正解例\s*\d+\s*", "", a["model"]).strip()
    changed = (model != a["model"]) or (a.get("length") != len(model))
    a["model"] = model
    a["length"] = len(model)
    return changed


def fix_tashi_misclass(q):
    """tantou5 だが answer が {ア..} のものを tashi に補正し語群を再抽出。"""
    ans = q.get("answer")
    if q["type"] == "tantou5" and isinstance(ans, dict) and "ア" in ans:
        raw_lines = (q.get("raw") or "").split("\n")
        word_bank, passage = extract_word_bank(raw_lines)
        q["type"] = "tashi"
        q["stem"] = "".join(passage)
        q["word_bank"] = word_bank
        q.pop("choices", None)
        return True, len(word_bank)
    return False, 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--processed", default="../processed", help="*_full.json のあるディレクトリ")
    ap.add_argument("-o", "--out", action="append", required=True,
                    help="出力先（複数指定可）")
    args = ap.parse_args()

    result = {}
    fixed, dropped, tashi_warn = [], [], []
    total = 0

    for y in YEARS:
        path = f"{args.processed}/{y.lower()}_full.json"
        try:
            with open(path, encoding="utf-8") as f:
                qs = json.load(f)
        except FileNotFoundError:
            print(f"[skip] {path} なし", file=sys.stderr)
            continue

        by_num = {}  # number -> 採用する1問（重複時は本文が長い方）
        for q in qs:
            if is_example(q):
                continue  # 記入例の見本は捨てる
            ok, n = fix_tashi_misclass(q)
            if ok:
                fixed.append((q["id"], n))
            clean_kijutsu_answer(q)
            if q.get("answer") is None:
                dropped.append(q["id"])
                continue
            q.pop("raw", None)  # raw は端末に不要（容量・余計な本文露出を減らす）
            num = q["number"]
            # 同番号が複数残ったら本文が長い方を実問題として採用
            if num not in by_num or len(q.get("stem", "")) > len(by_num[num].get("stem", "")):
                by_num[num] = q

        out_qs = sorted(by_num.values(), key=lambda q: q["number"])
        for q in out_qs:
            if q["type"] == "tashi" and len(q.get("word_bank", {})) != 20:
                tashi_warn.append((q["id"], f"語群{len(q.get('word_bank', {}))}個"))

        # 欠番レポート（非掲載58-60を除く 1..57 の不足）
        present = {q["number"] for q in out_qs}
        miss = [n for n in range(1, TOTAL + 1) if n not in present and n not in NONPUBLISHED]
        if miss:
            print(f"[{y}] 欠番(要確認): {miss}", file=sys.stderr)

        result[y] = out_qs
        total += len(out_qs)
        by_type = {}
        for q in out_qs:
            by_type[q["type"]] = by_type.get(q["type"], 0) + 1
        print(f"[{y}] {len(out_qs)}問  {by_type}", file=sys.stderr)

    body = json.dumps(result, ensure_ascii=False, indent=2)
    for o in args.out:
        with open(o, "w", encoding="utf-8") as f:
            f.write(body)
        print(f"[書き込み] {o}", file=sys.stderr)

    print(f"\n[合計] {total}問", file=sys.stderr)
    print(f"[多肢補正] {fixed}", file=sys.stderr)
    print(f"[除外(answer無)] {dropped}", file=sys.stderr)
    # 重複除去して警告
    uniq_warn = sorted(set(tashi_warn))
    print(f"[語群が20でない多肢] {uniq_warn}", file=sys.stderr)


if __name__ == "__main__":
    main()
