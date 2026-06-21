import { createClient } from "@supabase/supabase-js";

/**
 * Supabase クライアント（個人用プロジェクト・非公開）。
 * ------------------------------------------------------------------
 * - schema = "scrivener"（public には置かない）。db.schema で指定。
 * - 単一ユーザー / anon 全拒否。RLS は auth.uid() = user_id なので、
 *   サインイン（Supabase Auth）した本人のセッションでのみ読み書きできる。
 * - 接続情報は .env から読む（ハードコード禁止・.gitignore 済み・Vite 規約の VITE_ プレフィックス）。
 *   ＊個人用プロジェクト側のキーを入れること（公開用プロジェクトのキーと混在させない）。
 * - 同期するのは履歴だけ。question_id と集計値のみ。問題本文は絶対に送らない。
 *
 * 未設定ならクライアントは null（同期無効＝IndexedDB のローカル保存のみで動く）。
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      db: { schema: "scrivener" },
      // セッションはローカルに保持（端末ごとに一度サインインすれば以後は自動。
      // ＊保持されるのは認証トークンのみで、問題・履歴データではない）
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

/* ─────────── 認証ヘルパー（anon を使わせず本人だけに絞るため） ─────────── */

/** 現在サインイン中のユーザー（未サインイン/未設定なら null）。 */
export async function getCurrentUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

/** メール＋パスワードでサインイン。 */
export async function signIn(email, password) {
  if (!supabase) return { error: new Error("Supabase 未設定") };
  return supabase.auth.signInWithPassword({ email, password });
}

/** サインアウト。 */
export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** 認証状態の変化を購読。unsubscribe 関数を返す。 */
export function onAuthChange(cb) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    cb(session?.user ?? null);
  });
  return () => data.subscription.unsubscribe();
}
