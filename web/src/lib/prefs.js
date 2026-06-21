import { supabase, isSupabaseConfigured, getCurrentUser } from "./supabase.js";

/**
 * 出題フィルタなどのUI設定をデバイス間で同期する（要サインイン）。
 * ------------------------------------------------------------------
 * 送る/受け取るのは年度・分野・学習対象などの「設定」だけ。
 * 問題本文・選択肢・正解例は一切含めない（私的使用の前提を維持）。
 * 未設定/未サインイン/オフラインなら何もしない（端末ローカル保存のみで動く）。
 */
export async function loadRemotePrefs() {
  if (!isSupabaseConfigured || !navigator.onLine) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("prefs")
    .select("data")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !data) return null;
  return data.data ?? null;
}

export async function saveRemotePrefs(prefs) {
  if (!isSupabaseConfigured || !navigator.onLine) return;
  const user = await getCurrentUser();
  if (!user) return;
  await supabase
    .from("prefs")
    .upsert(
      { user_id: user.id, data: prefs, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
}
