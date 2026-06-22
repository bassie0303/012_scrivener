#!/usr/bin/env python3
"""
各問にAI解説を生成して questions.json に追記する（A-1）。

- 解説はAI生成の独自コメント＝著作権上問題なし。保存先は端末ローカルの questions.json
  （.gitignore 済み・同期も公開もしない）。問題本文をサーバーに送るのは「解説生成のための
  Anthropic API 呼び出し」だけで、生成結果はローカルに保存する。
- 5択(tantou5): explanation（総合）＋ choice_explanations（肢別）
- 多肢(tashi)/記述(kijutsu): explanation（総合）のみ
- 1問1コール・構造化出力で総合と肢別を一括取得（整合性のため）。
- 既に explanation がある問題はスキップ（中断しても再開できる／--force で再生成）。
- 失敗・拒否(refusal)はスキップしてログ。途中保存するので Ctrl+C しても安全。

使い方:
  export ANTHROPIC_API_KEY=sk-ant-...
  pip install -r requirements.txt        # anthropic を含む
  # まず数問で試す
  python generate_explanations.py ../processed/questions.json --limit 3
  # 本番（全問）。web 側にも反映するなら両方に書く
  python generate_explanations.py ../processed/questions.json
  cp ../processed/questions.json ../../web/public/data/questions.json
"""
import os
import sys
import json
import time
import argparse

MODEL = "claude-opus-4-8"

SYSTEM = """あなたは行政書士試験の指導講師です。受験生向けに、正確で簡潔な日本語の解説を書きます。

出力ルール:
- 総合解説(summary): その問題のテーマ・論点、選択肢を見比べてどこで正誤が分かれるか、正解肢が際立つ理由、引っかけの注意点を100〜150字で。設問文をそのまま繰り返さない。
- 肢別解説(choices): 各肢が正しいか誤りかを冒頭で示し、その根拠を条文番号や判例でピンポイントに50〜80字で。
- 条文・判例は正確に。不確かな場合は条文番号を断定せず一般的な原則で説明する。
- 事実誤認を避ける。誤った断定はしない。
- 敬体は使わず、簡潔な常体（〜である／〜する）で書く。"""


def build_schema(q):
    """型に応じた構造化出力スキーマを作る。"""
    if q["type"] == "tantou5":
        keys = list(q.get("choices", {}).keys())
        return {
            "type": "object",
            "additionalProperties": False,
            "required": ["summary", "choices"],
            "properties": {
                "summary": {"type": "string"},
                "choices": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": keys,
                    "properties": {k: {"type": "string"} for k in keys},
                },
            },
        }
    # tashi / kijutsu は総合のみ
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["summary"],
        "properties": {"summary": {"type": "string"}},
    }


def build_user_text(q):
    """問題内容を生成用に整形（解説に必要な情報だけ）。"""
    lines = [f"【種別】{q['type']}　【分野】{q.get('field','')}", f"【設問】{q['stem']}"]
    if q["type"] == "tantou5":
        for n, t in q.get("choices", {}).items():
            lines.append(f"  {n}. {t}")
        lines.append(f"【正解】{q.get('answer')}")
        lines.append("各肢の正誤と根拠（choices）、および総合解説（summary）を書いてください。")
    elif q["type"] == "tashi":
        wb = "／".join(f"{n}:{t}" for n, t in q.get("word_bank", {}).items())
        lines.append(f"【語群】{wb}")
        lines.append(f"【正解】{q.get('answer')}")
        lines.append("空欄に入る語の理由を含む総合解説（summary）を書いてください。")
    else:  # kijutsu
        ans = q.get("answer") or {}
        if q.get("reference"):
            lines.append(f"【参照条文】{q['reference']}")
        lines.append(f"【正解例】{ans.get('model','')}")
        lines.append("解答の法的筋道を示す総合解説（summary）を書いてください。")
    return "\n".join(lines)


def generate_one(client, q):
    schema = build_schema(q)
    resp = client.messages.create(
        model=MODEL,
        max_tokens=4000,  # adaptive thinking のぶんも含め余裕を持たせる
        thinking={"type": "adaptive"},
        system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": build_user_text(q)}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("refusal")
    text = next((b.text for b in resp.content if b.type == "text"), None)
    if not text:
        raise RuntimeError("no text block")
    data = json.loads(text)
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="questions.json（{年度:[...]} 形式）。上書き追記する")
    ap.add_argument("--limit", type=int, default=0, help="先頭N問だけ処理（試運転用）")
    ap.add_argument("--force", action="store_true", help="既存の解説も再生成する")
    args = ap.parse_args()

    try:
        import anthropic
    except ImportError:
        sys.exit("anthropic 未インストール: pip install -r requirements.txt")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY を環境変数に設定してください")

    client = anthropic.Anthropic()

    with open(args.path, encoding="utf-8") as f:
        data = json.load(f)

    # {年度:[...]} を順に処理
    flat = [(y, i, q) for y, qs in data.items() for i, q in enumerate(qs)]
    todo = [t for t in flat if args.force or not t[2].get("explanation")]
    if args.limit:
        todo = todo[: args.limit]

    print(f"対象 {len(todo)} 問 / 全 {len(flat)} 問", file=sys.stderr)
    done, failed = 0, []
    for k, (y, i, q) in enumerate(todo, 1):
        out, err = None, None
        for attempt in range(4):  # 接続エラー/JSON途中切れに自前リトライ（指数バックオフ）
            try:
                out = generate_one(client, q)
                break
            except Exception as e:
                err = e
                time.sleep(2 * (2 ** attempt))  # 2,4,8,16秒
        if out is not None:
            data[y][i]["explanation"] = out["summary"].strip()
            if q["type"] == "tantou5" and isinstance(out.get("choices"), dict):
                data[y][i]["choice_explanations"] = {n: v.strip() for n, v in out["choices"].items()}
            done += 1
            print(f"  [{k}/{len(todo)}] {q['id']} ✓", file=sys.stderr)
        else:
            failed.append((q["id"], str(err)))
            print(f"  [{k}/{len(todo)}] {q['id']} ✗ {err}", file=sys.stderr)
        # 5問ごとに途中保存（中断しても再開できる）
        if k % 5 == 0:
            with open(args.path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

    with open(args.path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n完了: {done} 問に解説を付与 / 失敗 {len(failed)}", file=sys.stderr)
    if failed:
        print(f"失敗: {failed}", file=sys.stderr)
    print(f"書き込み: {args.path}", file=sys.stderr)


if __name__ == "__main__":
    main()
