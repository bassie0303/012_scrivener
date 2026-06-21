-- 出題フィルタなどのUI設定を端末間で同期するテーブル（個人用・非公開プロジェクト）
-- ------------------------------------------------------------------
-- 実行は手動（Supabase ダッシュボードの SQL Editor に貼って Run）。
--
-- 保存するのは年度/分野/学習対象などの「設定」だけ（問題本文・選択肢・正解例は入れない）。
-- 単一ユーザー / anon 全拒否。RLS は auth.uid() = user_id（本人の行だけ）。

create table if not exists scrivener.prefs (
  user_id uuid not null default auth.uid() references auth.users(id),
  data jsonb not null default '{}'::jsonb,   -- 例: {"mode":"tantou5","fields":["憲法"],"years":["R7"],"studyFilter":"all"}
  updated_at timestamptz not null default now(),
  primary key (user_id)
);
alter table scrivener.prefs enable row level security;
create policy "own prefs" on scrivener.prefs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant all on scrivener.prefs to authenticated;
