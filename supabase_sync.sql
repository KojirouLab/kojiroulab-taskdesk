-- タスクデスク: 端末間同期用テーブル
-- task-calendar と同じSupabaseプロジェクト(ylvvjqwbhfggwjivkgvr)に追加する。
-- Supabaseダッシュボード > SQL Editor に貼り付けて実行してください。
-- https://supabase.com/dashboard/project/ylvvjqwbhfggwjivkgvr/sql/new

create table if not exists taskdesk_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table taskdesk_state enable row level security;

-- 他のプロジェクト(order-system/task-calendar)と同じ考え方:
-- ログイン機能はなく、「同期コード(id)を知っている端末だけが読み書きできる」設計。
-- anon keyでの読み書きを全開放する。
drop policy if exists "anon full access to taskdesk_state" on taskdesk_state;
create policy "anon full access to taskdesk_state"
  on taskdesk_state
  for all
  to anon
  using (true)
  with check (true);
