import { get, set } from "idb-keyval";
import { supabase, isSupabaseConfigured, getCurrentUser } from "./supabase.js";

/**
 * 解答履歴の永続化と同期。
 * ------------------------------------------------------------------
 * - ローカルは IndexedDB（localStorage は使わない＝CLAUDE.md の指示）。
 *   `history` … { [question_id]: {attempts, correct_count, last_result, last_chosen, updated_at} }
 *   `outbox`  … 未送信の加算（オフライン/未サインイン時に貯めて後で flush）
 * - サーバー（Supabase / schema=scrivener / table=history）は本人のセッションでのみ読み書き。
 *   解答時:   ローカルを楽観的に +1 し、outbox に積んで送信を試みる。
 *   送信:     1件ごとに「取得→加算→upsert」で attempts/correct_count を +1 する。
 *   起動/復帰時: outbox を flush → サーバー値でローカルを上書き（端末間で揃える）。
 * - 送るのは question_id と集計値のみ。問題本文・選択肢・正解例は一切含めない。
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

  // 送信は待たない（オフライン/未サインインでも UI を止めない）
  flushOutbox().catch(() => {});

  return history;
}

/**
 * 溜まった加算をサーバーへ送る（要サインイン）。
 * 1件ずつ「取得 → +1 → upsert」。成功した分だけキューから外す。
 * ＊単一ユーザー前提のため取得→加算→upsert で十分（複数端末で同時オフライン書き込みが
 *   重なった場合のみ取りこぼし得るが、本人1人なので実害なし）。
 */
export async function flushOutbox() {
  if (!isSupabaseConfigured || !navigator.onLine) return;
  const user = await getCurrentUser();
  if (!user) return; // 未サインインなら送らない（anon は RLS で全拒否）

  let outbox = (await get(OUTBOX_KEY)) || [];
  if (outbox.length === 0) return;

  const remaining = [];
  for (const item of outbox) {
    const ok = await bumpRemote(user.id, item);
    if (!ok) remaining.push(item); // 失敗分は残して次回再送
  }
  await set(OUTBOX_KEY, remaining);
}

/** scrivener.history の1行を取得→加算→upsert（attempts/correct_count を +1）。 */
async function bumpRemote(userId, item) {
  // 取得（RLS で本人の行のみ。無ければ null）
  const { data: cur, error: selErr } = await supabase
    .from("history")
    .select("attempts, correct_count")
    .eq("user_id", userId)
    .eq("question_id", item.question_id)
    .maybeSingle();
  if (selErr) return false;

  const attempts = (cur?.attempts ?? 0) + 1;
  const correct_count = (cur?.correct_count ?? 0) + (item.correct ? 1 : 0);

  // upsert（主キー user_id,question_id で衝突したら更新）
  const { error: upErr } = await supabase
    .from("history")
    .upsert(
      {
        user_id: userId,
        question_id: item.question_id,
        attempts,
        correct_count,
        last_result: item.correct,
        last_chosen: item.chosen,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,question_id" }
    );
  return !upErr;
}

/**
 * サーバーの値でローカルを上書きして返す（端末間で揃える / 要サインイン）。
 * 先に outbox を flush してからでないと自分の最新加算が欠けるので順序に注意。
 */
export async function syncFromServer() {
  if (!isSupabaseConfigured || !navigator.onLine) return null;
  const user = await getCurrentUser();
  if (!user) return null;

  await flushOutbox();

  const { data, error } = await supabase
    .from("history")
    .select("question_id, attempts, correct_count, last_result, last_chosen, updated_at")
    .eq("user_id", user.id);
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
