-- 行政書士アプリ 履歴同期スキーマ（個人用プロジェクト・非公開）
-- ------------------------------------------------------------------
-- 実行は手動（Supabase ダッシュボードの SQL Editor に貼って Run）。
--
-- 設計:
--   - schema = scrivener（public に置かない）
--   - 単一ユーザー / anon は全拒否。RLS で auth.uid() = user_id（本人の行だけ）
--   - 保存するのは履歴だけ。問題本文・選択肢・正解例の列は作らない（私的使用の前提）
--
-- 実行後、ダッシュボードの Settings → API → Exposed schemas に `scrivener` を追加すること。
--   （anon には schema usage を revoke 済みなので、Exposed にしても本人以外はアクセス不可）

create schema if not exists scrivener;
revoke all on schema scrivener from anon;
grant usage on schema scrivener to authenticated, service_role;
alter default privileges in schema scrivener grant all on tables to authenticated, service_role;

create table if not exists scrivener.history (
  user_id uuid not null default auth.uid() references auth.users(id),
  question_id text not null,        -- 例: "r7-2"、○×一問一答は "r7-2-3"
  attempts int not null default 0,
  correct_count int not null default 0,
  last_result boolean,
  last_chosen text,                 -- "4" / "○" / '{"ア":"5",...}' / "self:maru" 等（問題本文は入れない）
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id)
);
alter table scrivener.history enable row level security;
create policy "own rows" on scrivener.history for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant all on scrivener.history to authenticated;
