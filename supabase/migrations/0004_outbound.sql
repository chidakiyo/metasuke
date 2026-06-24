-- Phase 2b: 返信（outbound）の記録を1トランザクションで行うRPC
-- outboundメッセージ作成 ＋ tickets更新(replied/既読) ＋ events('sent') を原子的に。
-- 実際のメール送信は send Edge Function（Mailgun or dry-run）が担い、成功後に本RPCを呼ぶ。

create or replace function public.record_outbound_message(
  p_ticket_id   uuid,
  p_from        text,
  p_to          text,
  p_subject     text,
  p_body_text   text,
  p_message_id  text,
  p_in_reply_to text default null,
  p_references  text[] default '{}'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket tickets;
  v_uid    uuid;
  v_msg_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select * into v_ticket from tickets where id = p_ticket_id;
  if v_ticket.id is null then
    raise exception 'ticket not found';
  end if;
  if not is_org_member(v_ticket.org_id) then
    raise exception 'forbidden';
  end if;

  insert into messages (
    org_id, ticket_id, direction, channel, from_addr, to_addrs,
    subject, body_text, message_id, in_reply_to, mail_references, sent_by
  ) values (
    v_ticket.org_id, p_ticket_id, 'outbound', 'email', p_from, array[p_to],
    p_subject, p_body_text, p_message_id, p_in_reply_to, coalesce(p_references, '{}'), v_uid
  ) returning id into v_msg_id;

  -- 返信したので replied フラグを立て、既読化（status はユーザーが管理）
  update tickets set replied = true, is_read = true where id = p_ticket_id;

  insert into events (org_id, ticket_id, actor_id, type, payload)
  values (v_ticket.org_id, p_ticket_id, v_uid, 'sent',
          jsonb_build_object('message_id', p_message_id, 'to', p_to));

  return v_msg_id;
end;
$$;

-- メンバーが呼べる（内部で所属チェック）。anon は所属チェックで弾かれる。
grant execute on function public.record_outbound_message(uuid,text,text,text,text,text,text,text[]) to authenticated;
