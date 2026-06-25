import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { Organization } from '@metasuke/shared';
import { supabase } from './lib/supabase';
import { Auth } from './views/Auth';
import { Workspace } from './views/Workspace';
import { MembersView } from './views/Members';
import { InboxesView } from './views/Inboxes';
import { ProfileModal } from './views/Profile';
import { card, h2, input, button } from './styles';

const inviteToken = new URLSearchParams(window.location.search).get('invite');

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui', background: '#f7f7f8', minHeight: '100vh' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: 22, margin: '0 0 16px' }}>metasuke</h1>
        {loading ? (
          <p>読み込み中…</p>
        ) : session ? (
          <SignedIn session={session} />
        ) : (
          <>
            {inviteToken && (
              <div style={{ ...card, background: '#eef6ff' }}>招待を受けています。ログイン／新規登録すると組織に参加します。</div>
            )}
            <Auth />
          </>
        )}
      </div>
    </div>
  );
}

function SignedIn({ session }: { session: Session }) {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'inbox' | 'members' | 'settings'>('inbox');
  const [notice, setNotice] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [myName, setMyName] = useState<string | null>(null);

  async function loadMyName() {
    const { data } = await supabase.from('profiles').select('display_name').eq('user_id', session.user.id).maybeSingle();
    setMyName((data?.display_name as string | null) ?? null);
  }
  useEffect(() => { void loadMyName(); }, []);

  async function loadOrgs(): Promise<Organization[]> {
    const { data } = await supabase.from('organizations').select('*').order('created_at');
    const list = (data ?? []) as Organization[];
    setOrgs(list);
    setOrgId((cur) => cur ?? list[0]?.id ?? null);
    return list;
  }
  useEffect(() => {
    void loadOrgs();
  }, []);

  // 招待の受諾（?invite=token）
  useEffect(() => {
    if (!inviteToken) return;
    (async () => {
      const { data, error } = await supabase.rpc('accept_invitation', { p_token: inviteToken });
      window.history.replaceState({}, '', window.location.pathname);
      if (error) {
        setNotice(`招待の受諾に失敗: ${error.message}`);
      } else {
        setNotice('組織に参加しました。');
        await loadOrgs();
        if (typeof data === 'string') setOrgId(data);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createOrg() {
    if (!name.trim()) return;
    setBusy(true);
    const { data } = await supabase.rpc('create_organization', { p_name: name.trim() });
    setName('');
    await loadOrgs();
    if (data?.id) setOrgId(data.id);
    setBusy(false);
  }

  const navLink = (v: 'inbox' | 'members' | 'settings', label: string) => (
    <button
      onClick={() => setView(v)}
      style={{
        padding: '6px 12px',
        border: 'none',
        background: 'transparent',
        borderBottom: view === v ? '2px solid #2563eb' : '2px solid transparent',
        color: view === v ? '#2563eb' : '#555',
        fontWeight: view === v ? 700 : 400,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {orgs.length === 1 && <strong style={{ fontSize: 14 }}>{orgs[0].name}</strong>}
          {orgs.length > 1 && (
            <select value={orgId ?? ''} onChange={(e) => setOrgId(e.target.value)} style={{ padding: 6, borderRadius: 6 }}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
          <span title={session.user.email ?? ''} style={{ color: '#555', fontSize: 13 }}>{myName ?? session.user.email}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ ...button, background: '#fff', color: '#333', border: '1px solid #ccc' }} onClick={() => setShowProfile(true)}>
            プロフィール
          </button>
          <button style={{ ...button, background: '#fff', color: '#333', border: '1px solid #ccc' }} onClick={() => supabase.auth.signOut()}>
            ログアウト
          </button>
        </div>
      </div>
      {showProfile && <ProfileModal email={session.user.email ?? ''} onClose={() => { setShowProfile(false); void loadMyName(); }} />}

      {notice && (
        <div style={{ ...card, background: '#f0fdf4', color: '#166534' }}>
          {notice} <button style={{ marginLeft: 8 }} onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      {orgs.length === 0 ? (
        <section style={card}>
          <h2 style={h2}>最初の組織を作成</h2>
          <p style={{ color: '#888' }}>まず組織を作りましょう（あなたが管理者になります）。</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ ...input, marginBottom: 0 }} placeholder="組織名" value={name} onChange={(e) => setName(e.target.value)} />
            <button style={button} disabled={busy} onClick={createOrg}>
              作成
            </button>
          </div>
        </section>
      ) : orgId ? (
        <>
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e3e3e3', marginBottom: 16 }}>
            {navLink('inbox', '受信箱')}
            {navLink('members', 'メンバー')}
            {navLink('settings', '受信箱設定')}
          </div>
          {view === 'inbox' ? (
            <Workspace orgId={orgId} />
          ) : view === 'members' ? (
            <MembersView orgId={orgId} currentUid={session.user.id} />
          ) : (
            <InboxesView orgId={orgId} currentUid={session.user.id} />
          )}
        </>
      ) : null}
    </>
  );
}
