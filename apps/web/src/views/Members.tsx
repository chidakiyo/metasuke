import { useCallback, useEffect, useState } from 'react';
import type { MembershipRole } from '@metasuke/shared';
import { supabase } from '../lib/supabase';
import { card, h2, input, button, buttonGhost } from '../styles';

interface Member {
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: MembershipRole;
}
interface Invitation {
  id: string;
  email: string;
  role: MembershipRole;
  token: string;
  status: string;
  created_at: string;
}

function inviteUrl(token: string) {
  return `${window.location.origin}/?invite=${token}`;
}

export function MembersView({ orgId, currentUid }: { orgId: string; currentUid: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MembershipRole>('member');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const isAdmin = members.find((m) => m.user_id === currentUid)?.role === 'admin';

  const loadMembers = useCallback(async () => {
    const { data } = await supabase.from('v_org_members').select('user_id,display_name,email,role').eq('org_id', orgId);
    setMembers((data ?? []) as Member[]);
  }, [orgId]);

  const loadInvites = useCallback(async () => {
    // admin のみ参照可（非adminは空が返る）
    const { data } = await supabase
      .from('invitations')
      .select('id,email,role,token,status,created_at')
      .eq('org_id', orgId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    setInvites((data ?? []) as Invitation[]);
  }, [orgId]);

  useEffect(() => {
    void loadMembers();
    void loadInvites();
  }, [loadMembers, loadInvites]);

  async function invite() {
    if (!email.trim()) return;
    setBusy(true);
    setErr(null);
    const { error } = await supabase.from('invitations').insert({
      org_id: orgId,
      email: email.trim().toLowerCase(),
      role,
    });
    if (error) setErr(error.message);
    else {
      setEmail('');
      await loadInvites();
    }
    setBusy(false);
  }

  async function revoke(id: string) {
    await supabase.from('invitations').update({ status: 'revoked' }).eq('id', id);
    await loadInvites();
  }

  async function copyLink(token: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(token));
      setCopied(token);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setErr('クリップボードにコピーできませんでした。リンクを手動で選択してください。');
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <section style={card}>
        <h2 style={h2}>メンバー（{members.length}）</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {members.map((m) => (
            <li key={m.user_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <span>{m.display_name || m.email}{m.user_id === currentUid && <span style={{ color: '#999' }}>（あなた）</span>}</span>
              <span style={{ fontSize: 12, color: '#666' }}>{m.role === 'admin' ? '管理者' : 'メンバー'}</span>
            </li>
          ))}
        </ul>
      </section>

      {isAdmin && (
        <section style={card}>
          <h2 style={h2}>メンバーを招待</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input style={{ ...input, marginBottom: 0 }} placeholder="招待するメールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select value={role} onChange={(e) => setRole(e.target.value as MembershipRole)} style={{ padding: 8, borderRadius: 6 }}>
              <option value="member">メンバー</option>
              <option value="admin">管理者</option>
            </select>
            <button style={button} disabled={busy} onClick={invite}>
              招待
            </button>
          </div>
          {err && <p style={{ color: '#b00', fontSize: 13 }}>{err}</p>}
          <p style={{ color: '#888', fontSize: 12, marginTop: 8 }}>
            ※ 現在はメール送信未設定のため、発行された招待リンクを相手に共有してください（招待相手が同じメールでログインして開くと参加）。
          </p>

          {invites.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13, color: '#666' }}>保留中の招待</strong>
              <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
                {invites.map((inv) => (
                  <li key={inv.id} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13 }}>
                        {inv.email} <span style={{ color: '#999', fontSize: 12 }}>({inv.role === 'admin' ? '管理者' : 'メンバー'})</span>
                      </span>
                      <span style={{ display: 'flex', gap: 6 }}>
                        <button style={{ ...buttonGhost, padding: '2px 8px', fontSize: 12 }} onClick={() => copyLink(inv.token)}>
                          {copied === inv.token ? 'コピー済' : 'リンクをコピー'}
                        </button>
                        <button style={{ ...buttonGhost, padding: '2px 8px', fontSize: 12, color: '#b00', borderColor: '#b00' }} onClick={() => revoke(inv.id)}>
                          取消
                        </button>
                      </span>
                    </div>
                    <code style={{ fontSize: 11, color: '#999', wordBreak: 'break-all' }}>{inviteUrl(inv.token)}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
