-- Phase 4a: AI下書きの組織別エンタイトルメント（上限）
-- AI ON/OFF は organizations.ai_enabled（既存）を使う。
-- 月次の下書き生成回数の上限をここで持つ（未設定なら既定値）。

create table org_entitlements (
  org_id              uuid primary key references organizations(id) on delete cascade,
  monthly_draft_limit integer not null default 100,
  created_at          timestamptz not null default now()
);
alter table org_entitlements enable row level security;

-- メンバーは参照（上限の表示用）、admin が変更
create policy ent_select on org_entitlements for select using (is_org_member(org_id));
create policy ent_write  on org_entitlements for all    using (is_org_admin(org_id)) with check (is_org_admin(org_id));
