-- 返信トークンによる堅牢なスレッド連結。
-- 送信時 Reply-To を「localpart+t-<token>@domain」のサブアドレスにし、顧客の返信先に
-- チケットを識別するトークンを埋め込む。In-Reply-To/References が欠落・改変されても
-- 宛先アドレスのトークンで確実に同チケットへ連結できる（競合準拠の堅牢化）。

-- 1) チケットに不変の返信トークンを付与（opaque・gen_random_bytes はクラウドの search_path に無いため uuid で代替）
alter table tickets add column if not exists reply_token text;
update tickets set reply_token = replace(gen_random_uuid()::text, '-', '') where reply_token is null;
alter table tickets alter column reply_token set default replace(gen_random_uuid()::text, '-', '');
alter table tickets alter column reply_token set not null;
create unique index if not exists tickets_reply_token_idx on tickets (reply_token);

-- 2) 受信取り込みを「サブアドレス(+tag)対応」に更新
--    - 受信箱解決は +tag を除いたベースアドレスで行う
--    - tag が "t-<token>" なら、そのトークンのチケットへ直接連結（ヘッダーより優先）
create or replace function public.ingest_inbound_email(
  p_to         text,
  p_from       text,
  p_from_name  text default null,
  p_subject    text default null,
  p_text       text default null,
  p_html       text default null,
  p_message_id text default null,
  p_in_reply_to text default null,
  p_references text[] default '{}'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_addr       text := lower(p_to);
  v_base       text;        -- +tag を除いたベース宛先
  v_tag        text;        -- + と @ の間（例: t-xxxx）
  v_token      text;        -- tag が t- 始まりのときのトークン
  v_inbox      inboxes;
  v_contact_id uuid;
  v_ticket_id  uuid;
  v_refs       text[];
begin
  -- サブアドレス分解: "name+tag@domain" → base="name@domain", tag="tag"
  v_tag  := substring(v_addr from '\+([^@]+)@');
  v_base := regexp_replace(v_addr, '\+[^@]*@', '@');

  -- 宛先（ベース）から受信箱（＝組織）を解決
  select * into v_inbox from inboxes where inbound_address = v_base limit 1;
  if v_inbox.id is null then
    return null;  -- 対応する受信箱なし。呼び出し側で 200 を返し無視する。
  end if;

  -- コンタクト名寄せ（org内で email 一意）
  insert into contacts (org_id, email, name)
  values (v_inbox.org_id, lower(p_from), p_from_name)
  on conflict (org_id, email) do update
    set name = coalesce(contacts.name, excluded.name)
  returning id into v_contact_id;

  -- ① 返信トークンによる直接連結（最優先）
  if v_tag is not null and v_tag like 't-%' then
    v_token := substring(v_tag from 3);
    select id into v_ticket_id
    from tickets
    where org_id = v_inbox.org_id and reply_token = v_token
    limit 1;
  end if;

  -- ② ヘッダー(in_reply_to/references)による連結（トークン未一致時）
  if v_ticket_id is null then
    v_refs := coalesce(p_references, '{}')
              || case when p_in_reply_to is null then '{}'::text[] else array[p_in_reply_to] end;
    if array_length(v_refs, 1) is not null then
      select t.id into v_ticket_id
      from messages m
      join tickets t on t.id = m.ticket_id
      where m.org_id = v_inbox.org_id
        and m.message_id = any(v_refs)
      order by m.created_at desc
      limit 1;
    end if;
  end if;

  if v_ticket_id is null then
    insert into tickets (org_id, inbox_id, contact_id, subject, status, thread_key)
    values (v_inbox.org_id, v_inbox.id, v_contact_id, p_subject, 'unassigned',
            coalesce(p_message_id, gen_random_uuid()::text))
    returning id into v_ticket_id;
  else
    -- 既存スレッドに着信 → resolved なら再オープン
    update tickets set status = case when status = 'resolved' then 'open' else status end
    where id = v_ticket_id;
  end if;

  insert into messages (
    org_id, ticket_id, direction, channel, from_addr, to_addrs,
    subject, body_text, body_html, message_id, in_reply_to, mail_references
  ) values (
    v_inbox.org_id, v_ticket_id, 'inbound', 'email', lower(p_from), array[v_base],
    p_subject, p_text, p_html, p_message_id, p_in_reply_to, coalesce(p_references, '{}')
  );

  return v_ticket_id;
end;
$$;

revoke execute on function public.ingest_inbound_email(text,text,text,text,text,text,text,text,text[])
  from public, anon, authenticated;
grant execute on function public.ingest_inbound_email(text,text,text,text,text,text,text,text,text[])
  to service_role;
