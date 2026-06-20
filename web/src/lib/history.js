import { get, set } from "idb-keyval";
import { supabase, isSupabaseConfigured, USER_ID } from "./supabase.js";

/**
 * 解答履歴の永続化と複数端末同期。
 * ------------------------------------------------------------------
 * - ローカルは IndexedDB（localStorage は使わない＝CLAUDE.md の指示）。
 *   `history` … { [question_id]: {attempts, correct_count, last_result, last_chosen, updated_at} }
 *   `outbox`  … 未送信の加算リクエスト（オフライン時に貯めて後で flush）
 * - サーバー（Supabase）は加算を集約する真実のソース。
 *   解答時:   ローカルを楽観的に +1 し、outbox に積んで送信を試みる。
 *   起動/復帰時: outbox を flush → サーバー値で集約を上書き（端末間合算）。
 * - 送信内容は question_id と集計のみ。問題本文は一切含めない。
 */
const HISTORY_KEY = "history";
const OUTBOX_KEY = "outbox";

export async function loadLocalHistory() {
  return (await get(HISTORY_KEY)) || {};
}

/** 解答1件を記録。ローカルを即時更新し、更新後の history マップを返す。 */
export async function recordAnswer(questionId, correct, chosen) {
  const history = await loadLocalHistory();
  const prev = history[questionId] || { attempts: 0, correct_count: 0 };
  history[questionId] = {
    attempts: prev.attempts + 1,
    correct_count: prev.correct_count + (correct === true ? 1 : 0),
    last_result: correct,
    last_chosen: serializeChosen(chosen),
    updated_at: new Date().toISOString(),
  };
  await set(HISTORY_KEY, history);

  // 送信キューに積む（問題本文は含めない）
  const outbox = (await get(OUTBOX_KEY)) || [];
  outbox.push({ question_id: questionId, correct: correct === true, chosen: serializeChosen(chosen) });
  await set(OUTBOX_KEY, outbox);

  // 送信は待たない（オフラインでも UI を止めない）
  flushOutbox().catch(() => {});

  return history;
}

/** 溜まった加算をサーバーへ送る。成功した分だけキューから外す。 */
export async function flushOutbox() {
  if (!isSupabaseConfigured || !navigator.onLine) return;
  let outbox = (await get(OUTBOX_KEY)) || [];
  if (outbox.length === 0) return;

  const remaining = [];
  for (const item of outbox) {
    const { error } = await supabase.rpc("bump_history", {
      p_user_id: USER_ID,
      p_question_id: item.question_id,
      p_correct: item.correct,
      p_chosen: item.chosen,
    });
    if (error) remaining.push(item); // 失敗分は残して次回再送
  }
  await set(OUTBOX_KEY, remaining);
}

/**
 * サーバーの集約値でローカルを上書きして返す（端末間の合算を反映）。
 * 先に outbox を flush してからでないと自分の最新加算が欠けるので順序に注意。
 */
export async function syncFromServer() {
  if (!isSupabaseConfigured || !navigator.onLine) return null;
  await flushOutbox();

  const { data, error } = await supabase
    .from("history")
    .select("question_id, attempts, correct_count, last_result, last_chosen, updated_at")
    .eq("user_id", USER_ID);
  if (error || !data) return null;

  const history = {};
  for (const row of data) {
    history[row.question_id] = {
      attempts: row.attempts,
      correct_count: row.correct_count,
      last_result: row.last_result,
      last_chosen: row.last_chosen,
      updated_at: row.updated_at,
    };
  }
  await set(HISTORY_KEY, history);
  return history;
}

function serializeChosen(chosen) {
  if (chosen == null) return null;
  return typeof chosen === "string" ? chosen : JSON.stringify(chosen);
}
