-- タスクデスク: Googleカレンダー連携用テーブル
-- task-calendarと同じSupabaseプロジェクト(ylvvjqwbhfggwjivkgvr)に追加する。
-- Supabaseダッシュボード > SQL Editor に貼り付けて実行してください。
-- https://supabase.com/dashboard/project/ylvvjqwbhfggwjivkgvr/sql/new

create table if not exists taskdesk_google_accounts (
  id text primary key, -- タスクデスクの同期コード(taskdesk_state.idと同じ値)
  refresh_token text not null,
  calendar_id text not null, -- 「タスクデスク」専用カレンダーのID
  connected_at timestamptz not null default now()
);

alter table taskdesk_google_accounts enable row level security;

-- taskdesk_stateと同じ考え方: 同期コードを知っている端末だけが読み書きできる。
-- refresh_tokenが入るテーブルなので、anon keyでの直接readはクライアントからは行わず
-- (Edge Function経由のservice roleアクセスのみ使う想定)、RLSはあくまで保険。
drop policy if exists "anon full access to taskdesk_google_accounts" on taskdesk_google_accounts;
create policy "anon full access to taskdesk_google_accounts"
  on taskdesk_google_accounts
  for all
  to anon
  using (true)
  with check (true);
