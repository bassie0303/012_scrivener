-- 行政書士アプリ 履歴同期スキーマ
-- ------------------------------------------------------------------
-- Supabase の SQL Editor に貼って実行する。
-- 保存するのは「履歴」だけ。問題本文・選択肢・正解例の列は作らない（私的使用の前提）。

create table if not exists public.history (
  user_id      text        not null,
  question_id  text        not null,   -- 例: "r7-2"、○×一問一答は "r7-2-3"
  attempts     int         not null default 0,
  correct_count int        not null default 0,
  last_result  boolean,
  last_chosen  text,                    -- "4" / "○" / '{"ア":"5",...}' / "self:maru" 等（問題本文は入れない）
  updated_at   timestamptz not null default now(),
  primary key (user_id, question_id)
);

-- 解答1件を加算する。INSERT or （競合時に）+1 加算。複数端末の合算はここで行われる。
create or replace function public.bump_history(
  p_user_id text,
  p_question_id text,
  p_correct boolean,
  p_chosen text
) returns void
language sql
as $$
  insert into public.history (user_id, question_id, attempts, correct_count, last_result, last_chosen, updated_at)
  values (p_user_id, p_question_id, 1, case when p_correct then 1 else 0 end, p_correct, p_chosen, now())
  on conflict (user_id, question_id) do update set
    attempts      = public.history.attempts + 1,
    correct_count = public.history.correct_count + case when p_correct then 1 else 0 end,
    last_result   = excluded.last_result,
    last_chosen   = excluded.last_chosen,
    updated_at    = now();
$$;

-- RLS: 単一ユーザー個人利用の最小設定。anon キーで読み書きを許可する。
-- ＊anon キー＋URL を知る人は誰でも書ける点に注意。強固にするなら Supabase Auth を導入し
--   user_id = auth.uid()::text で絞る policy に置き換えること。
alter table public.history enable row level security;

drop policy if exists "personal full access" on public.history;
create policy "personal full access" on public.history
  for all using (true) with check (true);

grant execute on function public.bump_history(text, text, boolean, text) to anon, authenticated;
