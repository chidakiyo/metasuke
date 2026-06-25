import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Inbox, Message, TicketStatus } from '@metasuke/shared';
import { TICKET_STATUSES, TICKET_STATUS_LABELS } from '@metasuke/shared';
import { supabase } from '../lib/supabase';
import { card, h2, input, button, buttonGhost, statusBadge } from '../styles';
import { MessageBody } from './MessageBody';

const FUNCTIONS_URL = import.meta.env.VITE_FUNCTIONS_URL ?? 'http://127.0.0.1:54321/functions/v1';

interface Member {
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: string;
}
interface TicketRow {
  id: string;
  subject: string | null;
  status: TicketStatus;
  is_read: boolean;
  assignee_id: string | null;
  last_message_at: string | null;
  contact: { name: string | null; email: string } | null;
}
interface TicketFull {
  id: string;
  subject: string | null;
  status: TicketStatus;
  assignee_id: string | null;
}
interface EventRow {
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
  actor_id: string | null;
}

function memberLabel(members: Member[], userId: string | null): string {
  if (!userId) return '未割当';
  const m = members.find((x) => x.user_id === userId);
  return m?.display_name || m?.email || userId.slice(0, 8);
}

export function Workspace({ orgId }: { orgId: string }) {
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [uid, setUid] = useState<string | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUid(data.user?.id ?? null));
  }, []);

  const loadInboxes = useCallback(async () => {
    const { data } = await supabase.from('inboxes').select('*').eq('org_id', orgId).order('created_at');
    setInboxes((data ?? []) as Inbox[]);
  }, [orgId]);

  const loadMembers = useCallback(async () => {
    const { data } = await supabase.from('v_org_members').select('user_id,display_name,email,role').eq('org_id', orgId);
    setMembers((data ?? []) as Member[]);
  }, [orgId]);

  const loadTickets = useCallback(async () => {
    const { data } = await supabase
      .from('tickets')
      .select('id,subject,status,is_read,assignee_id,last_message_at,contact:contacts(name,email)')
      .eq('org_id', orgId)
      .order('last_message_at', { ascending: false, nullsFirst: false });
    setTickets((data ?? []) as unknown as TicketRow[]);
  }, [orgId]);

  useEffect(() => {
    setSelectedTicket(null);
    void loadInboxes();
    void loadMembers();
    void loadTickets();
  }, [loadInboxes, loadMembers, loadTickets]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16, alignItems: 'start' }}>
      <div>
        <InboxPanel inboxes={inboxes} orgId={orgId} onChange={loadInboxes} onReceived={loadTickets} />
        <TicketListPanel tickets={tickets} members={members} selected={selectedTicket} onSelect={setSelectedTicket} onRefresh={loadTickets} />
      </div>
      <div>
        {selectedTicket ? (
          <TicketDetail
            ticketId={selectedTicket}
            inbox={inboxes[0] ?? null}
            members={members}
            currentUid={uid}
            onChanged={loadTickets}
          />
        ) : (
          <section style={card}>
            <p style={{ color: '#888' }}>左の一覧からチケットを選択してください。</p>
          </section>
        )}
      </div>
    </div>
  );
}

function InboxPanel({
  inboxes,
  orgId,
  onChange,
  onReceived,
}: {
  inboxes: Inbox[];
  orgId: string;
  onChange: () => void;
  onReceived: () => void;
}) {
  const [name, setName] = useState('サポート');
  const [addr, setAddr] = useState(`support-${Math.floor(Math.random() * 1e4)}@inbound.local`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function createInbox() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.from('inboxes').insert({
      org_id: orgId,
      name: name.trim(),
      inbound_address: addr.trim().toLowerCase(),
      from_domain: addr.split('@')[1] ?? null,
    });
    if (error) setErr(error.message);
    else {
      setAddr(`support-${Math.floor(Math.random() * 1e4)}@inbound.local`);
      onChange();
    }
    setBusy(false);
  }

  async function simulateInbound(inbox: Inbox) {
    setBusy(true);
    setErr(null);
    const res = await fetch(`${FUNCTIONS_URL}/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: inbox.inbound_address,
        from: 'taro.kanda@example.com',
        from_name: '神田 太郎',
        subject: `お問い合わせ（${new Date().toLocaleTimeString()}）`,
        text: '注文した商品がまだ届きません。状況を確認していただけますか？',
        message_id: `<cust.${Date.now()}@test.local>`,
      }),
    });
    if (!res.ok) setErr(`受信失敗: ${res.status}`);
    else onReceived();
    setBusy(false);
  }

  return (
    <section style={card}>
      <h2 style={h2}>受信箱</h2>
      {inboxes.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>受信箱を作成すると、その宛先へのメールを受け取れます。</p>
      ) : (
        <ul style={{ paddingLeft: 18, margin: '4px 0 8px' }}>
          {inboxes.map((ib) => (
            <li key={ib.id} style={{ fontSize: 13, marginBottom: 4 }}>
              <code>{ib.inbound_address}</code>{' '}
              <button style={{ ...buttonGhost, padding: '2px 8px', fontSize: 12 }} disabled={busy} onClick={() => simulateInbound(ib)}>
                テスト受信
              </button>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13, color: '#555' }}>受信箱を追加</summary>
        <div style={{ marginTop: 8 }}>
          <input style={input} placeholder="名前" value={name} onChange={(e) => setName(e.target.value)} />
          <input style={input} placeholder="受信アドレス" value={addr} onChange={(e) => setAddr(e.target.value)} />
          <button style={button} disabled={busy} onClick={createInbox}>
            作成
          </button>
        </div>
      </details>
      {err && <p style={{ color: '#b00', fontSize: 13 }}>{err}</p>}
    </section>
  );
}

function TicketListPanel({
  tickets,
  members,
  selected,
  onSelect,
  onRefresh,
}: {
  tickets: TicketRow[];
  members: Member[];
  selected: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={h2}>受信箱（チケット {tickets.length}）</h2>
        <button style={{ ...buttonGhost, padding: '4px 10px', fontSize: 12 }} onClick={onRefresh}>
          更新
        </button>
      </div>
      {tickets.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>まだチケットがありません。「テスト受信」で受信を試せます。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {tickets.map((t) => (
            <li
              key={t.id}
              onClick={() => onSelect(t.id)}
              style={{
                padding: '10px 8px',
                borderBottom: '1px solid #eee',
                cursor: 'pointer',
                background: selected === t.id ? '#eef4ff' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 13, fontWeight: t.is_read ? 400 : 700 }}>
                  {!t.is_read && <span style={{ color: '#2563eb' }}>● </span>}
                  {t.contact?.name ?? t.contact?.email ?? '不明'}
                </strong>
                <span style={statusBadge(t.status)}>{TICKET_STATUS_LABELS[t.status]}</span>
              </div>
              <div style={{ fontSize: 13, color: '#333', marginTop: 2 }}>{t.subject ?? '(件名なし)'}</div>
              <div style={{ fontSize: 11, color: '#999', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
                <span>担当: {memberLabel(members, t.assignee_id)}</span>
                <span>{t.last_message_at ? new Date(t.last_message_at).toLocaleString() : ''}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TicketDetail({
  ticketId,
  inbox,
  members,
  currentUid,
  onChanged,
}: {
  ticketId: string;
  inbox: Inbox | null;
  members: Member[];
  currentUid: string | null;
  onChanged: () => void;
}) {
  const [ticket, setTicket] = useState<TicketFull | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [sendInfo, setSendInfo] = useState<string | null>(null);
  const [present, setPresent] = useState<{ user_id: string; kind: string }[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Realtime Presence: このチケットを開いている/編集中のユーザーを共有（二重対応防止）
  useEffect(() => {
    if (!currentUid) return;
    const ch = supabase.channel(`ticket:${ticketId}`, { config: { presence: { key: currentUid } } });
    channelRef.current = ch;
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState<{ user_id: string; kind: string }>();
      const list: { user_id: string; kind: string }[] = [];
      for (const key of Object.keys(state)) {
        const metas = state[key];
        const meta = metas[metas.length - 1];
        if (meta) list.push({ user_id: meta.user_id, kind: meta.kind });
      }
      setPresent(list);
    });
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') void ch.track({ user_id: currentUid, kind: 'viewing' });
    });
    return () => {
      void ch.untrack();
      void supabase.removeChannel(ch);
      channelRef.current = null;
      setPresent([]);
    };
  }, [ticketId, currentUid]);

  // 返信に入力があれば「編集中」を在席に反映
  const editing = reply.trim().length > 0;
  useEffect(() => {
    if (channelRef.current && currentUid) {
      void channelRef.current.track({ user_id: currentUid, kind: editing ? 'editing' : 'viewing' });
    }
  }, [editing, currentUid]);

  const load = useCallback(async () => {
    const [tRes, mRes, eRes] = await Promise.all([
      supabase.from('tickets').select('id,subject,status,assignee_id').eq('id', ticketId).single(),
      supabase.from('messages').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true }),
      supabase.from('events').select('type,payload,created_at,actor_id').eq('ticket_id', ticketId).order('created_at', { ascending: false }).limit(20),
    ]);
    setTicket((tRes.data as TicketFull) ?? null);
    setMessages((mRes.data ?? []) as Message[]);
    setEvents((eRes.data ?? []) as EventRow[]);
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchTicket(patch: Partial<Pick<TicketFull, 'status' | 'assignee_id'>>) {
    setBusy(true);
    await supabase.from('tickets').update(patch).eq('id', ticketId);
    await load();
    onChanged();
    setBusy(false);
  }

  async function simulateReplyInThread() {
    if (!inbox || messages.length === 0) return;
    setBusy(true);
    const last = messages[messages.length - 1];
    const inbound = messages.find((m) => m.direction === 'inbound');
    await fetch(`${FUNCTIONS_URL}/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: inbox.inbound_address,
        from: inbound?.from_addr ?? 'taro.kanda@example.com',
        subject: messages[0]?.subject ?? '追記',
        text: 'やはり急いでいるので、できるだけ早めにお願いします。',
        message_id: `<reply.${Date.now()}@test.local>`,
        in_reply_to: last.message_id ?? undefined,
        references: last.message_id ? [last.message_id] : [],
      }),
    });
    await load();
    onChanged();
    setBusy(false);
  }

  async function sendReply() {
    if (!reply.trim()) return;
    setBusy(true);
    setSendInfo(null);

    // 送信前の競合検知: 読み込み後に新しいメッセージが届いていないか
    const { data: latest } = await supabase
      .from('messages')
      .select('created_at')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: false })
      .limit(1);
    const serverLatest = latest?.[0]?.created_at;
    const localLatest = messages[messages.length - 1]?.created_at;
    if (serverLatest && localLatest && serverLatest > localLatest) {
      const ok = window.confirm('このチケットに新しいメッセージが届いています。最新を確認せずに送信しますか？');
      if (!ok) {
        await load();
        setBusy(false);
        return;
      }
    }

    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    const res = await fetch(`${FUNCTIONS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify({ ticket_id: ticketId, body_text: reply.trim() }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSendInfo(`送信失敗: ${json.error ?? res.status}`);
    } else {
      setReply('');
      setSendInfo(json.dry_run ? '記録しました（dry-run：Mailgun未設定のため実送信なし）' : '送信しました');
      await load();
      onChanged();
    }
    setBusy(false);
  }

  async function generateDraft() {
    setBusy(true);
    setSendInfo(null);
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    const res = await fetch(`${FUNCTIONS_URL}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify({ ticket_id: ticketId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSendInfo(`下書き失敗: ${json.error ?? res.status}`);
    } else {
      setReply(json.draft ?? '');
      setSendInfo(`AI下書きを挿入しました${json.dry_run ? '（dry-run）' : ''}（${json.model}・${json.used}/${json.limit}）`);
    }
    setBusy(false);
  }

  function eventText(e: EventRow): string {
    if (e.type === 'status_changed') {
      const from = e.payload.from as TicketStatus;
      const to = e.payload.to as TicketStatus;
      return `ステータス: ${TICKET_STATUS_LABELS[from] ?? from} → ${TICKET_STATUS_LABELS[to] ?? to}`;
    }
    if (e.type === 'assigned') {
      return `担当: ${memberLabel(members, (e.payload.from as string) ?? null)} → ${memberLabel(members, (e.payload.to as string) ?? null)}`;
    }
    if (e.type === 'sent') return '返信を送信';
    return e.type;
  }

  return (
    <section style={card}>
      {/* ヘッダ: ステータス・担当者 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ ...h2, marginRight: 'auto' }}>{ticket?.subject ?? 'スレッド'}</h2>
        <label style={{ fontSize: 13, color: '#555' }}>
          ステータス{' '}
          <select
            value={ticket?.status ?? 'unassigned'}
            disabled={busy || !ticket}
            onChange={(e) => patchTicket({ status: e.target.value as TicketStatus })}
            style={{ padding: 4, borderRadius: 6 }}
          >
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TICKET_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13, color: '#555' }}>
          担当{' '}
          <select
            value={ticket?.assignee_id ?? ''}
            disabled={busy || !ticket}
            onChange={(e) => patchTicket({ assignee_id: e.target.value || null })}
            style={{ padding: 4, borderRadius: 6 }}
          >
            <option value="">未割当</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.display_name || m.email}
              </option>
            ))}
          </select>
        </label>
        {currentUid && ticket?.assignee_id !== currentUid && (
          <button style={{ ...buttonGhost, padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => patchTicket({ assignee_id: currentUid, status: 'open' })}>
            自分にアサイン
          </button>
        )}
      </div>

      {/* 在席表示（二重対応防止） */}
      {(() => {
        const others = present.filter((p) => p.user_id !== currentUid);
        if (others.length === 0) return null;
        const editingOthers = others.filter((p) => p.kind === 'editing');
        return (
          <div
            style={{
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 6,
              marginBottom: 10,
              background: editingOthers.length > 0 ? '#fef3c7' : '#f1f5f9',
              color: editingOthers.length > 0 ? '#92400e' : '#475569',
            }}
          >
            👁 {others.map((o) => memberLabel(members, o.user_id)).join(', ')} が閲覧中
            {editingOthers.length > 0 && (
              <span style={{ fontWeight: 700 }}>　⚠ {editingOthers.map((o) => memberLabel(members, o.user_id)).join(', ')} が返信を作成中です</span>
            )}
          </div>
        );
      })()}

      {/* スレッド */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: '#666' }}>やり取り</strong>
        <button style={{ ...buttonGhost, padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={simulateReplyInThread}>
          このスレッドに追加受信
        </button>
      </div>
      {messages.length === 0 ? (
        <p style={{ color: '#888' }}>メッセージがありません。</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                border: '1px solid #eee',
                borderRadius: 8,
                padding: 12,
                background: m.direction === 'inbound' ? '#fff' : '#f0f7ff',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#666' }}>
                <span>
                  {m.direction === 'inbound' ? '受信' : '送信'} · {m.from_addr}
                </span>
                <span>{new Date(m.created_at).toLocaleString()}</span>
              </div>
              {m.subject && <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0' }}>{m.subject}</div>}
              <MessageBody bodyHtml={m.body_html} bodyText={m.body_text} />
            </div>
          ))}
        </div>
      )}

      {/* 操作履歴 */}
      {events.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <strong style={{ fontSize: 13, color: '#666' }}>操作履歴</strong>
          <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', fontSize: 12, color: '#777' }}>
            {events.map((e, i) => (
              <li key={i} style={{ padding: '3px 0' }}>
                {new Date(e.created_at).toLocaleString()} · {memberLabel(members, e.actor_id)} · {eventText(e)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 返信エディタ */}
      <div style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 13, color: '#666' }}>返信</strong>
          <button style={{ ...buttonGhost, padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={generateDraft}>
            ✨ AIで下書き
          </button>
        </div>
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="顧客への返信を入力…"
          rows={5}
          style={{ ...input, marginTop: 6, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button style={button} disabled={busy || !reply.trim()} onClick={sendReply}>
            送信
          </button>
          {sendInfo && <span style={{ fontSize: 12, color: sendInfo.startsWith('送信失敗') ? '#b00' : '#16a34a' }}>{sendInfo}</span>}
        </div>
      </div>
    </section>
  );
}
