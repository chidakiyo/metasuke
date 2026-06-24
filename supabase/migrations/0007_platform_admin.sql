-- Phase A: 事業管理者（プラットフォーム運営）サーフェスの土台
-- 設計: docs/06-platform-admin-design.md
-- 原則: これらは一般テナント(anon/authenticated)から完全に不可視。
--       アクセスは admin Edge Function（service_role）経由のみ。

-- =========================================================
-- 運営者（platform_admins）
-- =========================================================
create table platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'readonly'
             check (role in ('superadmin', 'support', 'billing', 'readonly')),
  status     text not null default 'active',
  created_at timestamptz not null default now()
);
alter table platform_admins enable row level security;
-- 一般ロールからは完全に遮断（0001の既定付与を打ち消す）。service_role のみ。
revoke all on platform_admins from anon, authenticated;
grant select, insert, update, delete on platform_admins to service_role;

-- =========================================================
-- 運営操作の監査ログ（追記専用・service_role限定）
-- =========================================================
create table platform_audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references auth.users(id) on delete set null,
  action        text not null,
  target_org_id uuid,
  target_user_id uuid,
  reason        text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
alter table platform_audit_log enable row level security;
revoke all on platform_audit_log from anon, authenticated;
grant select, insert on platform_audit_log to service_role;  -- 追記専用（update/deleteは付与しない）
create index on platform_audit_log (created_at desc);

-- =========================================================
-- テナント横断サマリ（service_role限定。一般ロールからは不可視）
-- =========================================================
create view v_admin_tenant_summary as
select
  o.id, o.name, o.plan, o.ai_enabled, o.created_at,
  (select count(*) from memberships m where m.org_id = o.id and m.status = 'active') as member_count,
  (select count(*) from inboxes  i where i.org_id = o.id)                            as inbox_count,
  (select count(*) from tickets  t where t.org_id = o.id)                            as ticket_count,
  (select max(t.last_message_at) from tickets t where t.org_id = o.id)               as last_activity
from organizations o;
revoke all on v_admin_tenant_summary from public, anon, authenticated;
grant select on v_admin_tenant_summary to service_role;
