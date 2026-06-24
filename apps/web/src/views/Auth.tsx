import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { card, h2, input, button, buttonGhost } from '../styles';

export function Auth() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(mode: 'signin' | 'signup') {
    setBusy(true);
    setMsg(null);
    const res =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    if (res.error) setMsg(`エラー: ${res.error.message}`);
    else if (mode === 'signup') setMsg('登録しました。');
    setBusy(false);
  }

  return (
    <section style={card}>
      <h2 style={h2}>ログイン / 新規登録</h2>
      <input style={input} placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        style={input}
        type="password"
        placeholder="パスワード"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={button} disabled={busy} onClick={() => handle('signin')}>
          ログイン
        </button>
        <button style={buttonGhost} disabled={busy} onClick={() => handle('signup')}>
          新規登録
        </button>
      </div>
      {msg && <p style={{ color: '#b00' }}>{msg}</p>}
    </section>
  );
}
