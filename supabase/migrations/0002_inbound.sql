-- Phase 1: 受信メールの取り込みロジック（SQL関数）
-- 受信箱(宛先) → 組織解決、コンタクト名寄せ、スレッド連結、メッセージ作成を1トランザクションで。
-- 呼び出しは inbound webhook（service_role）からのみ。authenticated/anon は実行不可。

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
  v_inbox      inboxes;
  v_contact_id uuid;
  v_ticket_id  uuid;
  v_refs       text[];
begin
  -- 宛先アドレスから受信箱（＝組織）を解決
  select * into v_inbox from inboxes where inbound_address = lower(p_to) limit 1;
  if v_inbox.id is null then
    return null;  -- 対応する受信箱なし。呼び出し側で 200 を返し無視する。
  end if;

  -- コンタクト名寄せ（org内で email 一意）
  insert into contacts (org_id, email, name)
  values (v_inbox.org_id, lower(p_from), p_from_name)
  on conflict (org_id, email) do update
    set name = coalesce(contacts.name, excluded.name)
  returning id into v_contact_id;

  -- スレッド連結: in_reply_to / references が既存メッセージの message_id に一致すれば同チケット
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
    v_inbox.org_id, v_ticket_id, 'inbound', 'email', lower(p_from), array[lower(p_to)],
    p_subject, p_text, p_html, p_message_id, p_in_reply_to, coalesce(p_references, '{}')
  );
  -- tickets.last_message_at / is_read はトリガで更新される

  return v_ticket_id;
end;
$$;

-- 実行権限は service_role のみ（webhook専用）
revoke execute on function public.ingest_inbound_email(text,text,text,text,text,text,text,text,text[])
  from public, anon, authenticated;
grant execute on function public.ingest_inbound_email(text,text,text,text,text,text,text,text,text[])
  to service_role;
