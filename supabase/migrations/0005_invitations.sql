-- メンバー招待: 管理者が招待を作成 → 招待リンク(token)を共有 →
-- 招待された人がログインして accept_invitation(token) で参加。
-- メール送信は将来Mailgunに載せる（今はリンクを手動共有）。

create table invitations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  email      text not null,
  role       membership_role not null default 'member',
  token      text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  status     text not null default 'pending',  -- pending / accepted / revoked
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days')
);
create unique index invitations_pending_uniq on invitations (org_id, lower(email)) where status = 'pending';
create index on invitations (org_id);

alter table invitations enable row level security;

-- 管理は admin のみ（参照・作成・取消）。招待された本人は受諾RPC経由（直接SELECTしない）。
create policy inv_select on invitations for select using (is_org_admin(org_id));
create policy inv_insert on invitations for insert with check (is_org_admin(org_id));
create policy inv_update on invitations for update using (is_org_admin(org_id)) with check (is_org_admin(org_id));
create policy inv_delete on invitations for delete using (is_org_admin(org_id));

-- 受諾: token から招待を引き、ログインユーザーのメールと一致すれば membership 作成
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid;
  v_email text;
  v_inv   invitations;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select email into v_email from auth.users where id = v_uid;

  select * into v_inv from invitations where token = p_token;
  if v_inv.id is null then
    raise exception 'invitation not found';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'invitation is not pending';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'invitation expired';
  end if;
  if lower(v_inv.email) <> lower(v_email) then
    raise exception 'invitation email does not match the signed-in user';
  end if;

  insert into memberships (org_id, user_id, role, status)
  values (v_inv.org_id, v_uid, v_inv.role, 'active')
  on conflict (org_id, user_id) do update set status = 'active';

  update invitations set status = 'accepted' where id = v_inv.id;

  return v_inv.org_id;
end;
$$;

grant execute on function public.accept_invitation(text) to authenticated;
