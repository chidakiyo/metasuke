import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { card, h2, h3, input, button, buttonGhost, overlay } from '../styles';

// アカウントのプロフィール変更（名前・メール・パスワード）。
// 名前は profiles を直接更新（RLSで本人のみ）。メール/パスワードは Supabase Auth。
export function ProfileModal({ email, onClose }: { email: string; onClose: () => void }) {
  const [uid, setUid] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [newEmail, setNewEmail] = useState(email);
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
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

  async function saveName() {
    if (!uid) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase.from('profiles').update({ display_name: name.trim() || null }).eq('user_id', uid);
    setMsg(error ? `エラー: ${error.message}` : '名前を保存しました。');
    setBusy(false);
  }
  async function changeEmail() {
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.updateUser({ email: newEmail.trim() });
    setMsg(error ? `エラー: ${error.message}` : '確認メールを送信しました。新しいアドレス宛のリンクを開くと変更が確定します。');
    setBusy(false);
  }
  async function changePassword() {
    if (pw.length < 6) { setMsg('パスワードは6文字以上にしてください。'); return; }
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setMsg(error ? `エラー: ${error.message}` : 'パスワードを変更しました。');
    setPw('');
    setBusy(false);
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...card, maxWidth: 460, width: '100%', marginBottom: 0 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={h2}>プロフィール</h2>
          <button style={buttonGhost} onClick={onClose}>閉じる</button>
        </div>

        <h3 style={h3}>名前</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...input, marginBottom: 0 }} placeholder="表示名" value={name} onChange={(e) => setName(e.target.value)} />
          <button style={button} disabled={busy} onClick={saveName}>保存</button>
        </div>

        <h3 style={h3}>メールアドレス</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...input, marginBottom: 0 }} value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <button style={button} disabled={busy || !newEmail.trim() || newEmail.trim() === email} onClick={changeEmail}>変更</button>
        </div>
        <p style={{ fontSize: 11, color: '#999', margin: '4px 0 0' }}>※ 変更には新しいアドレスでの確認が必要です（確認メールが届きます）。</p>

        <h3 style={h3}>パスワード</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...input, marginBottom: 0 }} type="password" placeholder="新しいパスワード（6文字以上）" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button style={button} disabled={busy || !pw} onClick={changePassword}>変更</button>
        </div>

        {msg && <p style={{ fontSize: 13, color: msg.startsWith('エラー') ? '#b00' : '#16a34a', marginTop: 12 }}>{msg}</p>}
      </div>
    </div>
  );
}
