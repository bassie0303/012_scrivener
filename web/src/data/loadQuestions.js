import { get, set, del } from "idb-keyval";
import { SAMPLE_QUESTIONS } from "./sampleQuestions.js";

/**
 * 問題データの読み込み（各端末ローカル保存）。
 * ------------------------------------------------------------------
 * 過去問の本文はサーバー（Supabase / 公開ホスト）に一切置かない（私的使用の前提）。
 * 実データは各端末の IndexedDB にだけ持つ。読み込み優先順位:
 *
 *   1. IndexedDB に取り込み済みの問題（端末ローカル。公開アプリ＋各自取り込みの本筋）
 *   2. /<base>data/questions.json（ローカル開発で手動配置した場合のみ。公開ビルドには含めない）
 *   3. 自作サンプル（未取り込みのフォールバック）
 *
 * questions.json の形式は2通り受け付ける:
 *   - 配列そのまま:           [ {id,...}, ... ]
 *   - 年度ごと/ラップ:        { "R7": [...], "R6": [...] } / { questions: [...] }
 */
const QUESTIONS_KEY = "questions"; // IndexedDB に保存する取り込み済み問題

export async function loadQuestions() {
  // 1) 端末に取り込み済み（IndexedDB）
  try {
    const saved = await get(QUESTIONS_KEY);
    const list = normalize(saved);
    if (list.length > 0) return { questions: list, source: "imported" };
  } catch {
    // 取り込みなし → 次へ
  }

  // 2) ローカル開発時の手動配置ファイル（公開ビルドには無いので 404 → サンプルへ）
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/questions.json`, { cache: "no-cache" });
    if (res.ok) {
      const list = normalize(await res.json());
      if (list.length > 0) return { questions: list, source: "local-file" };
    }
  } catch {
    // 未配置/ネットワーク → サンプルへ
  }

  // 3) 自作サンプル
  return { questions: SAMPLE_QUESTIONS, source: "sample" };
}

/**
 * 端末にこの問題データを取り込む（IndexedDB に保存。サーバーには送らない）。
 * 取り込んだ件数を返す。形式が不正なら例外。
 */
export async function importQuestions(json) {
  const list = normalize(json);
  if (list.length === 0) throw new Error("問題が0件です（形式を確認してください）");
  await set(QUESTIONS_KEY, list);
  return list.length;
}

/** 取り込み済み問題を端末から削除（サンプルに戻す）。 */
export async function clearImportedQuestions() {
  await del(QUESTIONS_KEY);
}

function normalize(json) {
  let list = [];
  if (Array.isArray(json)) list = json;
  else if (json && Array.isArray(json.questions)) list = json.questions;
  else if (json && typeof json === "object") {
    // { "R7": [...], "R6": [...] } を平坦化
    list = Object.values(json).filter(Array.isArray).flat();
  }
  return list.map(sanitize);
}

// 印刷用の版面情報ノイズ（InDesignのトンボ。R7のPDFで選択肢末尾に混入）を除去。
//   例: "…。8029_01_SHIKEN01_M.indd 2 2025/09/27 1:40"
// ".indd" は正規の問題文に出ないので、そのトークン以降を末尾ごと削る。
// ＊取り込み済みの古いデータも読込時にここで除去される＝再取り込み不要。
const PRINT_MARK = /\s*\d[\w]*\.indd\b[\s\S]*/;
function scrub(s) {
  return typeof s === "string" ? s.replace(PRINT_MARK, "").trimEnd() : s;
}
function scrubMap(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const k of Object.keys(obj)) out[k] = scrub(obj[k]);
  return out;
}
function sanitize(q) {
  if (!q || typeof q !== "object") return q;
  const next = { ...q };
  if (typeof next.stem === "string") next.stem = scrub(next.stem);
  if (next.choices) next.choices = scrubMap(next.choices);
  if (next.word_bank) next.word_bank = scrubMap(next.word_bank);
  if (typeof next.reference === "string") next.reference = scrub(next.reference);
  return next;
}
