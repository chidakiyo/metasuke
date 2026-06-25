import { useEffect, useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';

// アカウント設定モーダル（白テーマ・両アプリ共通の見た目）。
// 表示名 = profiles を本人のみ更新。メール/パスワード = Supabase Auth。
export function ProfileModal({ email, onClose }: { email: string; onClose: () => void }) {
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
    setPw(''); setPw2('');
    setBusy(false);
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.headerRow}>
          <strong style={{ fontSize: 18 }}>アカウント設定</strong>
          <button style={s.close} onClick={onClose}>閉じる</button>
        </div>

        <div style={s.section}>プロフィール</div>
        <label style={s.label}>表示名</label>
        <input style={s.input} placeholder="表示名" value={name} onChange={(e) => setName(e.target.value)} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label style={s.label}>メール（ログイン用）</label>
          {!emailEditing && <button style={s.linkBtn} onClick={() => setEmailEditing(true)}>変更</button>}
        </div>
        <input
          style={emailEditing ? s.input : s.inputRO}
          value={newEmail}
          readOnly={!emailEditing}
          onChange={(e) => setNewEmail(e.target.value)}
        />
        {emailEditing && <p style={s.hint}>※ 変更すると新しいアドレスに確認メールが届きます。</p>}

        <button style={s.primary} disabled={busy} onClick={saveProfile}>プロフィールを保存</button>

        <div style={s.divider} />

        <div style={s.section}>パスワード変更</div>
        <label style={s.label}>新しいパスワード</label>
        <input style={s.input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <label style={s.label}>新しいパスワード（確認）</label>
        <input style={s.input} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        <button style={s.primary} disabled={busy || !pw} onClick={changePassword}>パスワードを変更</button>

        {msg && <p style={{ fontSize: 13, marginTop: 12, color: msg.kind === 'err' ? '#dc2626' : '#16a34a' }}>{msg.text}</p>}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 64, zIndex: 200 },
  modal: { background: '#fff', color: '#0f172a', borderRadius: 12, padding: 24, width: '100%', maxWidth: 460, boxShadow: '0 10px 40px rgba(0,0,0,0.3)', maxHeight: '85vh', overflowY: 'auto' },
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
