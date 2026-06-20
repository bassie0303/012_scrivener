#!/usr/bin/env python3
"""
行政書士試験 過去問PDF → JSON 変換パーサー（叩き台）

使い方:
  1) PDFからテキスト抽出（ローカルで実行。どちらか）
       pip install pdfplumber
       python -c "import pdfplumber,sys; print('\n'.join(p.extract_text() or '' for p in pdfplumber.open('r7_mondai.pdf').pages))" > r7.txt
     または:
       pdftotext -layout r7_mondai.pdf r7.txt      # popplerユーティリティ

  2) このパーサーにかける
       python parse_gyosei.py r7.txt --year R7 -o r7.json

出力: 設問ごとに id / number / type / stem / choices / note / raw を持つJSON配列。
欠番（著作権で非掲載の問題）は自動で検出してレポートします。
"""
import re
import sys
import json
import argparse

TOTAL_QUESTIONS = 60  # 行政書士試験は全60問

# 本物の問題が始まる目印（注意事項のニセ問題を除外するため）。
# このタイトル行より後ろだけをパース対象にする。
BODY_ANCHOR = "行政書士試験問題"

# 行頭の「問題 N」を検出（全角/半角スペースの有無を吸収）
Q_HEAD = re.compile(r"^問題\s*([0-9０-９]+)[　 ]*(.*)$")
# 選択肢行「1　…」〜「5　…」
CHOICE = re.compile(r"^([1-5１-５])[　 ]+(.*)$")
# 裸のページ番号行
PAGE_NO = re.compile(r"^\s*[0-9０-９]+\s*$")
# 脚注
NOTE = re.compile(r"^（注）")
# セクション見出し（法令等 / 一般知識 など、［問題…］を含む行）
SECTION = re.compile(r"［問題")

Z2H = str.maketrans("０１２３４５６７８９", "0123456789")


def to_int(s: str) -> int:
    return int(s.translate(Z2H))


# 語群20番の存在検出（行頭 or 区切り直後の「20　…」。複数行対応）
HAS_20 = re.compile(r"(?:^|[　 ])20[　 ]", re.M)
# 語群エントリ「N　語句」（1行に複数入る場合あり）
WB_ENTRY = re.compile(r"(\d{1,2})[　 ]+")
# 下書用マス目など、数字とスペースだけの行
MASUME = re.compile(r"^[\d０-９　 ]+$")


def pre_classify(body: str) -> str:
    """選択肢パース前に raw 本文だけで型を判定する。
    ※「次の記述のうち」は5肢択一の定番句なので "記述" 単独では記述式にしない。"""
    if re.search(r"記述しなさい|[四4]０?字|40\s*字", body):
        return "kijutsu"
    if "空欄" in body and "枠内の選択肢" in body and HAS_20.search(body):
        return "tashi"
    return "tantou5"          # 既定（5肢択一・組合せ・空欄補充の5択）


def extract_word_bank(lines):
    """多肢選択式の語群（1〜20）を抽出。グリッド型（問題41/42）と
    奇数→偶数＋折り返し型（問題43）の両方に対応。"""
    start = None
    for i, l in enumerate(lines):
        if re.match(r"^\s*1[ 　]+\S", l) and any(HAS_20.search(x) for x in lines[i:]):
            start = i  # 本文中の1を避けるため最後の候補を採用
    if start is None:
        return {}, lines
    passage, bank_lines = lines[:start], lines[start:]

    entries, cur = {}, None
    for line in bank_lines:
        ms = list(WB_ENTRY.finditer(line))
        if not ms:                      # 番号なし＝前エントリの折り返し
            if cur is not None:
                entries[cur] += line.strip()
            continue
        for j, m in enumerate(ms):
            num = int(m.group(1))
            s = m.end()
            e = ms[j + 1].start() if j + 1 < len(ms) else len(line)
            entries[num] = line[s:e].strip().rstrip("　 ")
            cur = num
    word_bank = {str(n): entries[n] for n in range(1, 21) if n in entries}
    return word_bank, passage


def clean_kijutsu(lines):
    """記述式ブロックを stem と reference に分離し、下書用マス目を除去。"""
    body = []
    for l in lines:
        if "（下書用）" in l:
            break
        body.append(l)
    ref_idx = next((i for i, l in enumerate(body) if l.startswith("（参照条文）")), None)
    if ref_idx is not None:
        reference = "\n".join(body[ref_idx + 1:]).strip() or None
        body = body[:ref_idx]
    else:
        reference = None
    body = [l for l in body if not MASUME.match(l)]
    return "".join(body), reference


def parse(text: str, year: str):
    # 1) 注意事項（ニセ問題）を捨てる: タイトル行以降だけ使う
    idx = text.rfind(BODY_ANCHOR)
    if idx != -1:
        text = text[idx + len(BODY_ANCHOR):]

    # 2) ノイズ行（ページ番号・セクション見出し）を除去
    lines = []
    for ln in text.splitlines():
        s = ln.rstrip()
        if not s:
            continue
        if PAGE_NO.match(s):
            continue
        if SECTION.search(s):
            continue
        lines.append(s)

    # 3) 「問題 N」で塊に分割
    blocks = []           # (number, [lines])
    cur_no, cur = None, []
    for s in lines:
        m = Q_HEAD.match(s)
        if m:
            if cur_no is not None:
                blocks.append((cur_no, cur))
            cur_no = to_int(m.group(1))
            cur = [m.group(2)] if m.group(2) else []
        elif cur_no is not None:
            cur.append(s)
    if cur_no is not None:
        blocks.append((cur_no, cur))

    # 4) 各塊を型ごとに構造化
    questions = []
    for number, body_lines in blocks:
        raw = "\n".join(body_lines)
        qtype = pre_classify(raw)

        rec = {
            "id": f"{year.lower()}-{number}",
            "year": year,
            "number": number,
            "type": qtype,
            "stem": "",
            "choices": {},
            "note": None,
            "raw": raw,
        }

        if qtype == "kijutsu":
            # 記述式: 事例＋問い / 参照条文 に分離、マス目除去
            stem, reference = clean_kijutsu(body_lines)
            rec["stem"] = stem
            rec["reference"] = reference

        elif qtype == "tashi":
            # 多肢選択式: 語群(1〜20)を分離
            word_bank, passage = extract_word_bank(body_lines)
            rec["stem"] = "".join(passage)
            rec["word_bank"] = word_bank

        else:
            # 5肢択一（組合せ・空欄補充の5択を含む）
            stem_parts, choices, note_parts = [], {}, []
            in_note, cur_choice = False, None
            for s in body_lines:
                if NOTE.match(s):
                    in_note = True
                    note_parts.append(re.sub(r"^（注）[　 ]*", "", s))
                    continue
                if in_note:
                    note_parts.append(s)
                    continue
                cm = CHOICE.match(s)
                if cm:
                    cur_choice = cm.group(1).translate(Z2H)
                    choices[cur_choice] = cm.group(2)
                elif cur_choice:               # 選択肢の折り返し行
                    choices[cur_choice] += s
                else:                          # 問題文の折り返し行
                    stem_parts.append(s)
            rec["stem"] = "".join(stem_parts)
            rec["choices"] = choices
            rec["note"] = "".join(note_parts) or None

        questions.append(rec)

    questions.sort(key=lambda q: q["number"])
    return questions


def missing_report(questions):
    present = {q["number"] for q in questions}
    return [n for n in range(1, TOTAL_QUESTIONS + 1) if n not in present]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("textfile", help="PDFから抽出したテキストファイル")
    ap.add_argument("--year", required=True, help="年度ラベル 例: R7")
    ap.add_argument("-o", "--out", help="出力JSONパス（省略時は標準出力）")
    args = ap.parse_args()

    with open(args.textfile, encoding="utf-8") as f:
        text = f.read()

    qs = parse(text, args.year)
    missing = missing_report(qs)

    print(f"[抽出結果] {len(qs)} 問を取得", file=sys.stderr)
    print(f"[欠番]     {missing}  ← 著作権で非掲載 or 抽出漏れ。要・自作問題で補完判断", file=sys.stderr)
    by_type = {}
    for q in qs:
        by_type[q["type"]] = by_type.get(q["type"], 0) + 1
    print(f"[タイプ別] {by_type}", file=sys.stderr)

    out = json.dumps(qs, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out)
        print(f"[書き込み] {args.out}", file=sys.stderr)
    else:
        print(out)


if __name__ == "__main__":
    main()
