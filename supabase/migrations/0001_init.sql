-- metasuke 初期スキーマ（Phase 0/1 中核）
-- マルチテナント SaaS。全テーブルに org_id を持たせ、RLS でテナント分離を強制する。
-- 認証は Supabase Auth（auth.users）。アプリ上のユーザー所属は memberships で表現。
--
-- 設計メモ:
--  - テナント判定は SECURITY DEFINER 関数 is_org_member / is_org_admin で行い、
--    memberships への RLS 再帰を避ける。
--  - 副作用のある書き込みは Edge Functions(Hono) 経由でも、RLS は常に有効。
--  - 組織作成は create_organization() RPC（作成者を admin として登録）で行う。

-- =========================================================
-- 拡張
-- =========================================================
create extension if not exists pgcrypto;  -- gen_random_uuid()

-- =========================================================
-- 列挙型
-- =========================================================
create type membership_role   as enum ('admin', 'member');
create type ticket_status      as enum ('unassigned', 'open', 'pending', 'resolved');
create type message_direction  as enum ('inbound', 'outbound');
create type message_channel     as enum ('email', 'form');
create type ai_suggestion_type as enum ('draft', 'summary', 'classification');
create type presence_kind       as enum ('viewing', 'editing');

-- =========================================================
-- テーブル
-- =========================================================

-- 組織（テナント）
create table organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  plan       text not null default 'free',
  ai_enabled boolean not null default true,   -- 組織単位の AI ON/OFF
  created_at timestamptz not null default now()
);

-- 所属（auth.users と organizations の多対多 ＋ ロール）
create table memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id)    on delete cascade,
  role       membership_role not null default 'member',
  status     text not null default 'active',            -- active / invited / disabled
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on memberships (user_id);
create index on memberships (org_id);

-- 共有受信箱（例: support@）
create table inboxes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  name            text not null,
  inbound_address text not null unique,  -- 受信用アドレス
  from_domain     text,                  -- 送信時の From ドメイン
  signature       text,
  dkim_verified   boolean not null default false,
  created_at      timestamptz not null default now()
);
create index on inboxes (org_id);

-- 顧客（コンタクト）
create table contacts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  email      text not null,
  name       text,
  company    text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, email)               -- 同一メールは1コンタクトに名寄せ
);
create index on contacts (org_id);

-- チケット（対応案件）
create table tickets (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  inbox_id        uuid not null references inboxes(id)   on delete restrict,
  contact_id      uuid not null references contacts(id)  on delete restrict,
  assignee_id     uuid references auth.users(id) on delete set null,
  subject         text,
  status          ticket_status not null default 'unassigned',
  replied         boolean not null default false,  -- 最後にこちらが返信した（内部フラグ）
  is_read         boolean not null default false,
  priority        smallint,                        -- 将来用
  thread_key      text,                            -- Message-ID ベースのスレッド連結キー
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  closed_at       timestamptz
);
create index on tickets (org_id, status);
create index on tickets (org_id, assignee_id);
create index on tickets (org_id, last_message_at desc);
create index on tickets (org_id, thread_key);

-- メッセージ（各通）
create table messages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  ticket_id   uuid not null references tickets(id) on delete cascade,
  direction   message_direction not null,
  channel     message_channel not null default 'email',
  from_addr   text,
  to_addrs    text[] not null default '{}',
  cc_addrs    text[] not null default '{}',
  subject     text,
  body_text   text,
  body_html   text,
  message_id  text,            -- メールの Message-ID
  in_reply_to text,
  mail_references text[] not null default '{}',  -- References ヘッダ（references は予約語のため改名）
  attachments jsonb not null default '[]'::jsonb,  -- [{name,size,storage_path,content_type}]
  sent_by     uuid references auth.users(id) on delete set null,  -- outbound の送信者
  created_at  timestamptz not null default now()
);
create index on messages (ticket_id, created_at);
create index on messages (org_id);
create index on messages (message_id);

-- 内部メモ（顧客には見えない）
create table notes (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  ticket_id  uuid not null references tickets(id) on delete cascade,
  author_id  uuid references auth.users(id) on delete set null,
  body       text not null,
  mentions   uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index on notes (ticket_id);

-- タグ
create table tags (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name   text not null,
  color  text,
  unique (org_id, name)
);

-- チケット×タグ（org_id を非正規化して RLS を単純化）
create table ticket_tags (
  ticket_id uuid not null references tickets(id) on delete cascade,
  tag_id    uuid not null references tags(id)    on delete cascade,
  org_id    uuid not null references organizations(id) on delete cascade,
  primary key (ticket_id, tag_id)
);
create index on ticket_tags (org_id);

-- テンプレート
create table templates (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  subject    text,
  body       text not null,
  inbox_id   uuid references inboxes(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on templates (org_id);

-- AI 提案（下書き・要約・分類）。採否を蓄積して品質改善とコスト把握に使う。
create table ai_suggestions (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  ticket_id  uuid not null references tickets(id) on delete cascade,
  type       ai_suggestion_type not null,
  input_hash text,
  output     jsonb,        -- 下書き本文 / 要約 / {category,tags,priority,sentiment}
  model      text,
  accepted   boolean,      -- null=未判定
  created_at timestamptz not null default now()
);
create index on ai_suggestions (ticket_id);
create index on ai_suggestions (org_id);

-- 操作履歴・監査ログ（誰がいつ何をしたか）
create table events (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  ticket_id  uuid references tickets(id) on delete cascade,
  actor_id   uuid references auth.users(id) on delete set null,
  type       text not null,   -- assigned / status_changed / sent / note_added ...
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on events (org_id, created_at desc);
create index on events (ticket_id);

-- 在席（二重対応防止）。揮発的に扱ってよい。TTL で失効。
-- ※ MVP では Supabase Realtime の Presence を主に使うため、本テーブルは補助。
create table ticket_presence (
  ticket_id  uuid not null references tickets(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  kind       presence_kind not null default 'viewing',
  expires_at timestamptz not null,
  primary key (ticket_id, user_id)
);
create index on ticket_presence (org_id);

-- =========================================================
-- テナント判定ヘルパ（SECURITY DEFINER で memberships の RLS 再帰を回避）
-- =========================================================
create or replace function public.is_org_member(p_org uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  );
$$;

-- =========================================================
-- 組織作成 RPC（作成者を admin として登録）
-- =========================================================
create or replace function public.create_organization(p_name text)
returns organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org organizations;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into organizations (name) values (p_name) returning * into v_org;

  insert into memberships (org_id, user_id, role, status)
  values (v_org.id, auth.uid(), 'admin', 'active');

  return v_org;
end;
$$;

-- =========================================================
-- トリガ: メッセージ追加時に tickets.last_message_at を更新
-- =========================================================
create or replace function public.bump_ticket_on_message()
returns trigger
language plpgsql
as $$
begin
  update tickets
     set last_message_at = new.created_at,
         is_read = case when new.direction = 'inbound' then false else is_read end
   where id = new.ticket_id;
  return new;
end;
$$;

create trigger trg_bump_ticket_on_message
after insert on messages
for each row execute function public.bump_ticket_on_message();

-- =========================================================
-- RLS 有効化
-- =========================================================
alter table organizations  enable row level security;
alter table memberships    enable row level security;
alter table inboxes        enable row level security;
alter table contacts       enable row level security;
alter table tickets        enable row level security;
alter table messages       enable row level security;
alter table notes          enable row level security;
alter table tags           enable row level security;
alter table ticket_tags    enable row level security;
alter table templates      enable row level security;
alter table ai_suggestions enable row level security;
alter table events         enable row level security;
alter table ticket_presence enable row level security;

-- =========================================================
-- RLS ポリシー
-- 方針:
--  - 参照: 当該組織のメンバーのみ
--  - 一般データの書き込み: 当該組織のメンバー
--  - 組織・所属・受信箱など管理系: admin のみ
-- =========================================================

-- organizations: メンバーは参照、admin は更新。作成は RPC 経由（直接 insert 不可）。
create policy org_select on organizations
  for select using (is_org_member(id));
create policy org_update on organizations
  for update using (is_org_admin(id)) with check (is_org_admin(id));

-- memberships: メンバーは同組織の所属を参照、admin が管理。
create policy mem_select on memberships
  for select using (is_org_member(org_id));
create policy mem_insert on memberships
  for insert with check (is_org_admin(org_id));
create policy mem_update on memberships
  for update using (is_org_admin(org_id)) with check (is_org_admin(org_id));
create policy mem_delete on memberships
  for delete using (is_org_admin(org_id));

-- inboxes: メンバー参照、admin 管理。
create policy inbox_select on inboxes
  for select using (is_org_member(org_id));
create policy inbox_write on inboxes
  for all using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- 汎用データ（メンバーが CRUD 可能）テーブル群に同型ポリシーを付与
do $$
declare t text;
begin
  foreach t in array array[
    'contacts','tickets','messages','notes','tags','ticket_tags',
    'templates','ai_suggestions','events','ticket_presence'
  ]
  loop
    execute format($f$
      create policy %1$s_select on %1$s
        for select using (is_org_member(org_id));
    $f$, t);
    execute format($f$
      create policy %1$s_insert on %1$s
        for insert with check (is_org_member(org_id));
    $f$, t);
    execute format($f$
      create policy %1$s_update on %1$s
        for update using (is_org_member(org_id)) with check (is_org_member(org_id));
    $f$, t);
    execute format($f$
      create policy %1$s_delete on %1$s
        for delete using (is_org_member(org_id));
    $f$, t);
  end loop;
end $$;

-- =========================================================
-- ロール権限（GRANT）
-- RLS は「どの行か」を制御するが、テーブルへの基本権限は別途必要。
-- authenticated ロールに CRUD を許可し、実際の可否は RLS ポリシーで絞る。
-- anon（未ログイン）はアプリ用テーブルへアクセス不可（認証は GoTrue が担う）。
-- =========================================================
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated;

-- 今後追加されるテーブル/関数にも既定で権限を付与
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to authenticated;

-- 備考:
--  - events は監査ログのため、運用上は UPDATE/DELETE を将来禁止する案もある（MVPでは許可）。
--  - Edge Functions が service_role で動く処理（inbound webhook 等）は RLS を迂回するため、
--    アプリ側で必ず org スコープを明示すること（02-architecture.md §3）。
