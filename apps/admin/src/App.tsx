import { useEffect, useState, type CSSProperties } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, adminApi, adminApiPost } from './lib/supabase';

interface ImperSession { id: string; target_org_id: string; reason: string; expires_at: string }
interface Imper { session: ImperSession; org_name: string }
interface ImperTicket { id: string; subject: string | null; status: string; is_read: boolean; last_message_at: string | null; contact: { name: string | null; email: string } | null }
interface ImperMessage { id: string; direction: string; from_addr: string | null; subject: string | null; body_text: string | null; created_at: string }

interface TenantSummary {
  id: string; name: string; plan: string; ai_enabled: boolean; created_at: string;
  member_count: number; inbox_count: number; ticket_count: number; last_activity: string | null;
}
interface Member { user_id: string; display_name: string | null; email: string | null; role: string }
interface Inbox { name: string; inbound_address: string; dkim_verified: boolean }
interface TenantDetail {
  tenant: TenantSummary; members: Member[]; inboxes: Inbox[];
  usage: { inboundThisMonth: number; outboundThisMonth: number; aiDraftsThisMonth: number };
}
interface AuditEvent { action: string; reason: string | null; payload: { ticket_id?: string } | null; created_at: string; actor: string | null; org_name: string | null }

const ACTION_LABELS: Record<string, string> = {
  'tenant.view': 'テナント閲覧',
  'impersonate.start': '代理開始',
  'impersonate.view_ticket': '代理: スレッド閲覧',
  'impersonate.end': '代理終了',
};
function actionLabel(a: string): string { return ACTION_LABELS[a] ?? a; }
function auditDetail(e: AuditEvent): string {
  if (e.action === 'impersonate.view_ticket' && e.payload?.ticket_id) return `ticket ${e.payload.ticket_id.slice(0, 8)}…`;
  return e.reason ?? '';
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string | null | 'forbidden'>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setRole(null); return; }
    adminApi<{ role: string }>('/whoami')
      .then((r) => setRole(r.role))
      .catch(() => setRole('forbidden'));
  }, [session]);

  return (
    <div style={{ fontFamily: 'system-ui', background: '#0f172a', minHeight: '100vh', color: '#e2e8f0' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: 20, margin: '0 0 16px' }}>metasuke <span style={{ color: '#60a5fa' }}>運営コンソール</span></h1>
        {loading ? <p>読み込み中…</p>
          : !session ? <Login />
          : role === null ? <p>権限を確認中…</p>
          : role === 'forbidden' ? <Forbidden email={session.user.email ?? ''} />
          : <Console role={role} email={session.user.email ?? ''} />}
      </div>
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function signin() {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMsg(error.message);
  }
  return (
    <section style={card}>
      <h2 style={h2}>運営者ログイン</h2>
      <input style={input} placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input style={input} type="password" placeholder="パスワード" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button style={button} onClick={signin}>ログイン</button>
      {msg && <p style={{ color: '#f87171' }}>{msg}</p>}
    </section>
  );
}

function Forbidden({ email }: { email: string }) {
  return (
    <section style={card}>
      <p>このアカウント（{email}）には運営権限がありません。</p>
      <button style={buttonGhost} onClick={() => supabase.auth.signOut()}>ログアウト</button>
    </section>
  );
}

function Console({ role, email }: { role: string; email: string }) {
  const [tab, setTab] = useState<'tenants' | 'audit'>('tenants');
  const [selected, setSelected] = useState<string | null>(null);
  const [imper, setImper] = useState<Imper | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [myName, setMyName] = useState<string | null>(null);

  async function loadMyName() {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { data } = await supabase.from('profiles').select('display_name').eq('user_id', u.user.id).maybeSingle();
    setMyName((data?.display_name as string | null) ?? null);
  }
  useEffect(() => { void loadMyName(); }, []);

  // 代理セッションの復元（リロードしてもバナーを維持）
  useEffect(() => {
    adminApi<{ session: ImperSession | null; org_name: string | null }>('/impersonate/active')
      .then((r) => { if (r.session) setImper({ session: r.session, org_name: r.org_name ?? '' }); })
      .catch(() => {});
  }, []);

  if (imper) return <ImpersonationView imper={imper} onEnd={() => setImper(null)} />;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span title={email} style={{ fontSize: 13, color: '#94a3b8' }}>{myName ?? email}・権限: <b style={{ color: '#e2e8f0' }}>{role}</b></span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={buttonGhost} onClick={() => setShowProfile(true)}>プロフィール</button>
          <button style={buttonGhost} onClick={() => supabase.auth.signOut()}>ログアウト</button>
        </div>
      </div>
      {showProfile && <ProfileModalAdmin email={email} onClose={() => { setShowProfile(false); void loadMyName(); }} />}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #334155', marginBottom: 16 }}>
        <Tab active={tab === 'tenants'} onClick={() => { setTab('tenants'); setSelected(null); }}>テナント</Tab>
        <Tab active={tab === 'audit'} onClick={() => { setTab('audit'); setSelected(null); }}>監査ログ</Tab>
      </div>
      {tab === 'audit' ? <AuditView />
        : selected ? <TenantDetailView id={selected} onBack={() => setSelected(null)} onImpersonate={setImper} />
        : <TenantsView onSelect={setSelected} />}
    </>
  );
}

function TenantsView({ onSelect }: { onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function load(query = '') {
    setErr(null);
    try {
      const r = await adminApi<{ tenants: TenantSummary[] }>(`/tenants${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      setTenants(r.tenants);
    } catch (e) { setErr(String(e)); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <section style={card}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input style={{ ...input, marginBottom: 0 }} placeholder="テナント名で検索" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(q)} />
        <button style={button} onClick={() => load(q)}>検索</button>
      </div>
      {err && <p style={{ color: '#f87171' }}>{err}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead><tr style={{ color: '#94a3b8', textAlign: 'left' }}>
          <th style={th}>テナント</th><th style={th}>プラン</th><th style={th}>メンバー</th>
          <th style={th}>チケット</th><th style={th}>最終活動</th>
        </tr></thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id} onClick={() => onSelect(t.id)} style={{ cursor: 'pointer', borderTop: '1px solid #1e293b' }}>
              <td style={td}>{t.name}</td>
              <td style={td}>{t.plan}{t.ai_enabled ? '' : ' / AI停止'}</td>
              <td style={td}>{t.member_count}</td>
              <td style={td}>{t.ticket_count}</td>
              <td style={td}>{t.last_activity ? new Date(t.last_activity).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tenants.length === 0 && !err && <p style={{ color: '#64748b' }}>テナントがありません。</p>}
    </section>
  );
}

function TenantDetailView({ id, onBack, onImpersonate }: { id: string; onBack: () => void; onImpersonate: (i: Imper) => void }) {
  const [d, setD] = useState<TenantDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    adminApi<TenantDetail>(`/tenants/${id}`).then(setD).catch((e) => setErr(String(e)));
  }, [id]);

  async function startImpersonation() {
    const reason = window.prompt('代理閲覧の理由を入力してください（必須・監査ログに記録されます）');
    if (!reason || !reason.trim()) return;
    try {
      const r = await adminApiPost<{ session: ImperSession; org_name: string }>('/impersonate', { org_id: id, reason: reason.trim() });
      onImpersonate({ session: r.session, org_name: r.org_name });
    } catch (e) { alert(String(e)); }
  }

  if (err) return <section style={card}><button style={buttonGhost} onClick={onBack}>← 戻る</button><p style={{ color: '#f87171' }}>{err}</p></section>;
  if (!d) return <section style={card}>読み込み中…</section>;

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button style={buttonGhost} onClick={onBack}>← 一覧へ戻る</button>
        <button style={{ ...buttonGhost, borderColor: '#f59e0b', color: '#f59e0b' }} onClick={startImpersonation}>🔍 代理閲覧（読み取り専用）</button>
      </div>
      <h2 style={{ ...h2, marginTop: 12 }}>{d.tenant.name}</h2>
      <p style={{ color: '#94a3b8', fontSize: 13 }}>
        プラン: {d.tenant.plan}・AI: {d.tenant.ai_enabled ? 'ON' : 'OFF'}・作成: {new Date(d.tenant.created_at).toLocaleString()}
      </p>

      <h3 style={h3}>今月の利用状況</h3>
      <div style={{ display: 'flex', gap: 16 }}>
        <Stat label="受信" value={d.usage.inboundThisMonth} />
        <Stat label="送信" value={d.usage.outboundThisMonth} />
        <Stat label="AI下書き" value={d.usage.aiDraftsThisMonth} />
        <Stat label="チケット累計" value={d.tenant.ticket_count} />
      </div>

      <h3 style={h3}>メンバー（{d.members.length}）</h3>
      <ul style={ul}>{d.members.map((m) => <li key={m.user_id}>{m.display_name || m.email} <span style={{ color: '#64748b' }}>({m.role})</span></li>)}</ul>

      <h3 style={h3}>受信箱（{d.inboxes.length}）</h3>
      <ul style={ul}>{d.inboxes.map((i) => <li key={i.inbound_address}><code>{i.inbound_address}</code> {i.dkim_verified ? '✓DKIM' : ''}</li>)}</ul>
    </section>
  );
}

function AuditView() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  useEffect(() => { adminApi<{ events: AuditEvent[] }>('/audit?limit=100').then((r) => setEvents(r.events)).catch(() => {}); }, []);
  return (
    <section style={card}>
      <h2 style={h2}>監査ログ</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ color: '#94a3b8', textAlign: 'left' }}>
          <th style={th}>日時</th><th style={th}>操作</th><th style={th}>対象テナント</th><th style={th}>実行者</th><th style={th}>詳細</th>
        </tr></thead>
        <tbody>{events.map((e, i) => (
          <tr key={i} style={{ borderTop: '1px solid #1e293b' }}>
            <td style={td}>{new Date(e.created_at).toLocaleString()}</td>
            <td style={{ ...td, color: e.action.startsWith('impersonate') ? '#fbbf24' : '#e2e8f0' }}>{actionLabel(e.action)}</td>
            <td style={td}>{e.org_name ?? '—'}</td>
            <td style={td}>{e.actor ?? '—'}</td>
            <td style={{ ...td, color: '#94a3b8' }}>{auditDetail(e)}</td>
          </tr>
        ))}</tbody>
      </table>
      {events.length === 0 && <p style={{ color: '#64748b' }}>まだ記録がありません。</p>}
    </section>
  );
}

function ImpersonationView({ imper, onEnd }: { imper: Imper; onEnd: () => void }) {
  const { session, org_name } = imper;
  const [tickets, setTickets] = useState<ImperTicket[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [messages, setMessages] = useState<ImperMessage[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi<{ tickets: ImperTicket[] }>(`/impersonate/${session.id}/tickets`)
      .then((r) => setTickets(r.tickets)).catch((e) => setErr(String(e)));
  }, [session.id]);

  useEffect(() => {
    if (!sel) { setMessages([]); return; }
    adminApi<{ messages: ImperMessage[] }>(`/impersonate/${session.id}/tickets/${sel}`)
      .then((r) => setMessages(r.messages)).catch((e) => setErr(String(e)));
  }, [sel, session.id]);

  async function end() {
    try { await adminApiPost(`/impersonate/${session.id}/end`); } catch { /* noop */ }
    onEnd();
  }

  return (
    <>
      {/* 常時バナー */}
      <div style={{ background: '#7c2d12', border: '1px solid #f59e0b', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 13 }}>
          ⚠ <b>サポートとして「{org_name}」を代理閲覧中（読み取り専用）</b><br />
          <span style={{ color: '#fed7aa' }}>理由: {session.reason} ・ 期限: {new Date(session.expires_at).toLocaleTimeString()}</span>
        </div>
        <button style={{ ...buttonGhost, borderColor: '#fbbf24', color: '#fde68a' }} onClick={end}>代理を終了</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, alignItems: 'start' }}>
        <section style={card}>
          <h3 style={{ ...h3, marginTop: 0 }}>チケット（{tickets.length}）</h3>
          {err && <p style={{ color: '#f87171', fontSize: 12 }}>{err}</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {tickets.map((t) => (
              <li key={t.id} onClick={() => setSel(t.id)} style={{ padding: '8px 6px', borderTop: '1px solid #1e293b', cursor: 'pointer', background: sel === t.id ? '#0f172a' : 'transparent' }}>
                <div style={{ fontSize: 13 }}>{t.contact?.name ?? t.contact?.email ?? '不明'}</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>{t.subject ?? '(件名なし)'} ・ {t.status}</div>
              </li>
            ))}
          </ul>
        </section>
        <section style={card}>
          <h3 style={{ ...h3, marginTop: 0 }}>スレッド（読み取り専用）</h3>
          {!sel ? <p style={{ color: '#64748b' }}>左のチケットを選択してください。</p>
            : messages.length === 0 ? <p style={{ color: '#64748b' }}>メッセージがありません。</p>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {messages.map((m) => (
                  <div key={m.id} style={{ border: '1px solid #334155', borderRadius: 8, padding: 10, background: m.direction === 'inbound' ? '#0f172a' : '#1e293b' }}>
                    <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{m.direction === 'inbound' ? '受信' : '送信'} · {m.from_addr}</span>
                      <span>{new Date(m.created_at).toLocaleString()}</span>
                    </div>
                    {m.subject && <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0' }}>{m.subject}</div>}
                    <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.body_text}</div>
                  </div>
                ))}
              </div>}
        </section>
      </div>
    </>
  );
}

function ProfileModalAdmin({ email, onClose }: { email: string; onClose: () => void }) {
  const [uid, setUid] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [emailEditing, setEmailEditing] = useState(false);
  const [newEmail, setNewEmail] = useState(email);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      const id = data.user?.id ?? null;
      setUid(id);
      if (id) {
        const { data: p } = await supabase.from('profiles').select('display_name').eq('user_id', id).maybeSingle();
        setName((p?.display_name as string | null) ?? '');
      }
    });
  }, []);

  async function saveProfile() {
    if (!uid) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase.from('profiles').update({ display_name: name.trim() || null }).eq('user_id', uid);
    if (error) { setMsg({ kind: 'err', text: error.message }); setBusy(false); return; }
    if (emailEditing && newEmail.trim() && newEmail.trim() !== email) {
      const { error: e2 } = await supabase.auth.updateUser({ email: newEmail.trim() });
      if (e2) { setMsg({ kind: 'err', text: e2.message }); setBusy(false); return; }
      setMsg({ kind: 'ok', text: 'プロフィールを保存しました。メール変更は確認メールのリンクで確定します。' });
    } else {
      setMsg({ kind: 'ok', text: 'プロフィールを保存しました。' });
    }
    setBusy(false);
  }
  async function changePassword() {
    if (pw.length < 6) { setMsg({ kind: 'err', text: 'パスワードは6文字以上にしてください。' }); return; }
    if (pw !== pw2) { setMsg({ kind: 'err', text: '確認用パスワードが一致しません。' }); return; }
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setMsg(error ? { kind: 'err', text: error.message } : { kind: 'ok', text: 'パスワードを変更しました。' });
    setPw(''); setPw2(''); setBusy(false);
  }

  return (
    <div style={pa.overlay} onClick={onClose}>
      <div style={pa.modal} onClick={(e) => e.stopPropagation()}>
        <div style={pa.headerRow}>
          <strong style={{ fontSize: 18 }}>アカウント設定</strong>
          <button style={pa.close} onClick={onClose}>閉じる</button>
        </div>
        <div style={pa.section}>プロフィール</div>
        <label style={pa.label}>表示名</label>
        <input style={pa.input} placeholder="表示名" value={name} onChange={(e) => setName(e.target.value)} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label style={pa.label}>メール（ログイン用）</label>
          {!emailEditing && <button style={pa.linkBtn} onClick={() => setEmailEditing(true)}>変更</button>}
        </div>
        <input style={emailEditing ? pa.input : pa.inputRO} value={newEmail} readOnly={!emailEditing} onChange={(e) => setNewEmail(e.target.value)} />
        {emailEditing && <p style={pa.hint}>※ 変更すると新しいアドレスに確認メールが届きます。</p>}
        <button style={pa.primary} disabled={busy} onClick={saveProfile}>プロフィールを保存</button>

        <div style={pa.divider} />

        <div style={pa.section}>パスワード変更</div>
        <label style={pa.label}>新しいパスワード</label>
        <input style={pa.input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <label style={pa.label}>新しいパスワード（確認）</label>
        <input style={pa.input} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        <button style={pa.primary} disabled={busy || !pw} onClick={changePassword}>パスワードを変更</button>

        {msg && <p style={{ fontSize: 13, marginTop: 12, color: msg.kind === 'err' ? '#dc2626' : '#16a34a' }}>{msg.text}</p>}
      </div>
    </div>
  );
}

const pa: Record<string, CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 64, zIndex: 200 },
  modal: { background: '#fff', color: '#0f172a', borderRadius: 12, padding: 24, width: '100%', maxWidth: 460, boxShadow: '0 10px 40px rgba(0,0,0,0.4)', maxHeight: '85vh', overflowY: 'auto' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  close: { background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14 },
  section: { fontSize: 15, fontWeight: 700, margin: '8px 0 12px' },
  label: { display: 'block', fontSize: 12, color: '#64748b', margin: '10px 0 4px' },
  input: { display: 'block', width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box', fontSize: 14, background: '#fff', color: '#0f172a' },
  inputRO: { display: 'block', width: '100%', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, boxSizing: 'border-box', fontSize: 14, background: '#f1f5f9', color: '#475569' },
  linkBtn: { background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12 },
  hint: { fontSize: 11, color: '#94a3b8', margin: '4px 0 0' },
  primary: { marginTop: 14, padding: '10px 16px', background: '#1e293b', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 },
  divider: { borderTop: '1px solid #e5e7eb', margin: '24px 0' },
};

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} style={{ padding: '6px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
    color: active ? '#60a5fa' : '#94a3b8', borderBottom: active ? '2px solid #60a5fa' : '2px solid transparent', fontWeight: active ? 700 : 400 }}>{children}</button>;
}
function Stat({ label, value }: { label: string; value: number }) {
  return <div style={{ background: '#1e293b', borderRadius: 8, padding: '10px 16px', minWidth: 90 }}>
    <div style={{ fontSize: 12, color: '#94a3b8' }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
  </div>;
}

const card: CSSProperties = { background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 16, marginBottom: 16 };
const h2: CSSProperties = { fontSize: 16, marginTop: 0 };
const h3: CSSProperties = { fontSize: 13, color: '#94a3b8', marginTop: 18, marginBottom: 6 };
const input: CSSProperties = { display: 'block', width: '100%', padding: '8px 10px', marginBottom: 8, border: '1px solid #334155', borderRadius: 6, boxSizing: 'border-box', background: '#0f172a', color: '#e2e8f0' };
const button: CSSProperties = { padding: '8px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' };
const buttonGhost: CSSProperties = { padding: '6px 12px', background: 'transparent', color: '#60a5fa', border: '1px solid #3b82f6', borderRadius: 6, cursor: 'pointer' };
const th: CSSProperties = { padding: '6px 8px', fontWeight: 600 };
const td: CSSProperties = { padding: '6px 8px' };
const ul: CSSProperties = { margin: '4px 0', paddingLeft: 18, fontSize: 13 };
