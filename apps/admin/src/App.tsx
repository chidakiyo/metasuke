import { useEffect, useState, type CSSProperties } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, adminApi } from './lib/supabase';

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
interface AuditEvent { actor_id: string | null; action: string; target_org_id: string | null; reason: string | null; created_at: string }

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

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: '#94a3b8' }}>{email}・権限: <b style={{ color: '#e2e8f0' }}>{role}</b></span>
        <button style={buttonGhost} onClick={() => supabase.auth.signOut()}>ログアウト</button>
      </div>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #334155', marginBottom: 16 }}>
        <Tab active={tab === 'tenants'} onClick={() => { setTab('tenants'); setSelected(null); }}>テナント</Tab>
        <Tab active={tab === 'audit'} onClick={() => { setTab('audit'); setSelected(null); }}>監査ログ</Tab>
      </div>
      {tab === 'audit' ? <AuditView />
        : selected ? <TenantDetailView id={selected} onBack={() => setSelected(null)} />
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

function TenantDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<TenantDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    adminApi<TenantDetail>(`/tenants/${id}`).then(setD).catch((e) => setErr(String(e)));
  }, [id]);

  if (err) return <section style={card}><button style={buttonGhost} onClick={onBack}>← 戻る</button><p style={{ color: '#f87171' }}>{err}</p></section>;
  if (!d) return <section style={card}>読み込み中…</section>;

  return (
    <section style={card}>
      <button style={buttonGhost} onClick={onBack}>← 一覧へ戻る</button>
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
          <th style={th}>日時</th><th style={th}>操作</th><th style={th}>対象org</th><th style={th}>実行者</th>
        </tr></thead>
        <tbody>{events.map((e, i) => (
          <tr key={i} style={{ borderTop: '1px solid #1e293b' }}>
            <td style={td}>{new Date(e.created_at).toLocaleString()}</td>
            <td style={td}>{e.action}</td>
            <td style={td}>{e.target_org_id?.slice(0, 8) ?? '—'}</td>
            <td style={td}>{e.actor_id?.slice(0, 8) ?? '—'}</td>
          </tr>
        ))}</tbody>
      </table>
      {events.length === 0 && <p style={{ color: '#64748b' }}>まだ記録がありません。</p>}
    </section>
  );
}

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
