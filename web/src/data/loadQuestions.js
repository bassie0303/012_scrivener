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
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.questions)) return json.questions;
  if (json && typeof json === "object") {
    // { "R7": [...], "R6": [...] } を平坦化
    return Object.values(json)
      .filter(Array.isArray)
      .flat();
  }
  return [];
}
