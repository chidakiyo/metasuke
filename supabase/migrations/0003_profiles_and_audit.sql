-- Phase 2a: メンバー表示用の profiles、メンバー一覧ビュー、チケット変更の監査トリガ

-- =========================================================
-- profiles: auth.users の表示用情報（email/表示名）を public に持つ
-- （authenticated は auth.users を直接読めないため）
-- =========================================================
create table profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now()
);
alter table profiles enable row level security;
grant select, insert, update, delete on profiles to authenticated, service_role;

-- 同じ組織に所属しているか（profiles参照の可視性判定。RLS再帰回避に SECURITY DEFINER）
create or replace function public.shares_org_with(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
    from memberships m1
    join memberships m2 on m1.org_id = m2.org_id
    where m1.user_id = auth.uid()
      and m2.user_id = p_user
      and m1.status = 'active'
      and m2.status = 'active'
  );
$$;

-- 自分のプロフィール or 同じ組織のメンバーのプロフィールを参照可
create policy profiles_select on profiles
  for select using (user_id = auth.uid() or shares_org_with(user_id));
-- 表示名は本人のみ更新可
create policy profiles_update on profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 新規 auth ユーザー作成時に profiles を自動作成
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- 既存ユーザーをバックフィル
insert into public.profiles (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;

-- =========================================================
-- メンバー一覧ビュー（org_id でメンバーと表示名を引く）
-- security_invoker=on で、参照者自身のRLS（memberships/profiles）が適用される
-- =========================================================
create view v_org_members
with (security_invoker = on) as
  select m.org_id, m.user_id, m.role, p.display_name, p.email
  from memberships m
  join profiles p on p.user_id = m.user_id
  where m.status = 'active';

grant select on v_org_members to authenticated, service_role;

-- =========================================================
-- 監査トリガ: tickets のステータス/担当者変更を events に自動記録
-- actor は auth.uid()（PostgREST経由のユーザー操作で取得できる）
-- =========================================================
create or replace function public.log_ticket_changes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into events (org_id, ticket_id, actor_id, type, payload)
    values (new.org_id, new.id, auth.uid(), 'status_changed',
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into events (org_id, ticket_id, actor_id, type, payload)
    values (new.org_id, new.id, auth.uid(), 'assigned',
            jsonb_build_object('from', old.assignee_id, 'to', new.assignee_id));
  end if;
  return new;
end;
$$;

create trigger trg_log_ticket_changes
after update on tickets
for each row execute function public.log_ticket_changes();
