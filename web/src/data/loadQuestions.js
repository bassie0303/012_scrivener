import { SAMPLE_QUESTIONS } from "./sampleQuestions.js";

/**
 * 問題データの読み込み。
 * ------------------------------------------------------------------
 * 過去問の本文はリポジトリに含めない（私的使用の前提）。実データは
 *   web/public/data/questions.json  （.gitignore 済み・手動配置）
 * に置く。配置されていればそれを使い、無ければ自作サンプルにフォールバックする。
 *
 * questions.json の形式は2通り受け付ける:
 *   - 配列そのまま:           [ {id,...}, ... ]
 *   - パイプライン出力をまとめたもの: { "R7": [...], "R6": [...] } / { questions: [...] }
 */
export async function loadQuestions() {
  try {
    const res = await fetch("/data/questions.json", { cache: "no-cache" });
    if (res.ok) {
      const json = await res.json();
      const list = normalize(json);
      if (list.length > 0) return { questions: list, source: "local" };
    }
  } catch {
    // ネットワーク/未配置 → サンプルへ
  }
  return { questions: SAMPLE_QUESTIONS, source: "sample" };
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
