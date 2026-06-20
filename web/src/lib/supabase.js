import { createClient } from "@supabase/supabase-js";

/**
 * Supabase クライアント。
 * ------------------------------------------------------------------
 * 同期するのは「履歴」だけ。送るのは question_id と集計値（attempts / correct_count）
 * および last_result / last_chosen のみ。問題本文・選択肢・正解例は絶対に送らない。
 *
 * 設定は .env（VITE_ プレフィックス、.gitignore 済み）から読む。
 * 未設定なら同期は無効化され、IndexedDB のローカル保存のみで動く。
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// 全端末で同じ値にすると履歴が合算される（単一ユーザー前提）。
export const USER_ID = import.meta.env.VITE_USER_ID || "me";

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, { auth: { persistSession: false } })
  : null;
