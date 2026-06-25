-- 受信箱の運用停止（アーカイブ）。
-- 受信箱は履歴（tickets）を持つため物理削除できない（FK on delete restrict）。
-- 「使わなくなった受信箱」は archived_at を立てて運用停止する。履歴は保持。
-- 受信(ingest)は停止後も取りこぼし防止のため引き続きマッチさせる（UI上で停止表示するだけ）。

alter table inboxes add column if not exists archived_at timestamptz;

-- 一覧で停止済みを判別しやすいよう部分インデックス（アクティブのみ）
create index if not exists inboxes_active_idx on inboxes (org_id) where archived_at is null;
