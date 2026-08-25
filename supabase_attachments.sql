-- タスクデスク: チケットへの添付ファイル用 Storage バケットとアクセスポリシー
--
-- Supabaseダッシュボード(KojirouLab's Project) → 左メニューの「SQL Editor」→
-- このファイルの中身を全部貼り付けて「Run」してください。
--
-- taskdesk_state と同じ信頼モデル(このアプリはログイン機能を持たず、anon keyだけで
-- 動く前提。「同期コードを知っている端末だけが使う」という運用上の約束事だけが保護)。
-- そのためバケットへの読み書き・削除はanon keyに広く許可する。ファイルパスの先頭に
-- 同期コードを入れる運用にして、少なくとも別の同期グループのファイルとは
-- 名前空間だけは分ける。

insert into storage.buckets (id, name, public, file_size_limit)
values ('taskdesk-attachments', 'taskdesk-attachments', true, 26214400) -- 25MB/ファイル
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

drop policy if exists "taskdesk_attachments anon select" on storage.objects;
create policy "taskdesk_attachments anon select"
on storage.objects for select
to anon
using (bucket_id = 'taskdesk-attachments');

drop policy if exists "taskdesk_attachments anon insert" on storage.objects;
create policy "taskdesk_attachments anon insert"
on storage.objects for insert
to anon
with check (bucket_id = 'taskdesk-attachments');

drop policy if exists "taskdesk_attachments anon delete" on storage.objects;
create policy "taskdesk_attachments anon delete"
on storage.objects for delete
to anon
using (bucket_id = 'taskdesk-attachments');
