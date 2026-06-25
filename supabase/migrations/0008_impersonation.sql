-- 運営 Phase B: 代理ログイン（impersonation・読み取り専用）
-- 設計 docs/06 PA-06。テナントの資格情報は使わず、サーバ(admin関数/service_role)が
-- 当該orgに限定してデータを返す。理由必須・時間制限・専用監査・既定読み取り専用。

create table impersonation_sessions (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references auth.users(id) on delete cascade,
  target_org_id uuid not null references organizations(id) on delete cascade,
  reason        text not null,
  readonly      boolean not null default true,
  started_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '30 minutes'),
  ended_at      timestamptz
);
alter table impersonation_sessions enable row level security;
revoke all on impersonation_sessions from anon, authenticated;  -- 一般ロールから不可視
grant select, insert, update on impersonation_sessions to service_role;
create index on impersonation_sessions (admin_id, ended_at);
