import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { card, h2, input, button, buttonGhost } from '../styles';

interface Inbox {
  id: string;
  name: string;
  inbound_address: string;
  from_domain: string | null;
  signature: string | null;
  dkim_verified: boolean;
  archived_at: string | null;
  created_at: string;
}

export function InboxesView({ orgId, currentUid }: { orgId: string; currentUid: string }) {
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 新規作成フォーム
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [fromDomain, setFromDomain] = useState('');

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('inboxes')
      .select('id,name,inbound_address,from_domain,signature,dkim_verified,archived_at,created_at')
      .eq('org_id', orgId)
      .order('created_at');
    setInboxes((data ?? []) as Inbox[]);
    const { data: me } = await supabase.from('v_org_members').select('role').eq('org_id', orgId).eq('user_id', currentUid).maybeSingle();
    setIsAdmin((me?.role as string | undefined) === 'admin');
  }, [orgId, currentUid]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    const addr = address.trim().toLowerCase();
    if (!name.trim() || !addr) return;
    setBusy(true);
    setErr(null);
    // from_domain 未入力なら受信アドレスのドメインを既定にする
    const dom = fromDomain.trim().toLowerCase() || addr.split('@')[1] || null;
    const { error } = await supabase.from('inboxes').insert({
      org_id: orgId,
      name: name.trim(),
      inbound_address: addr,
      from_domain: dom,
    });
    if (error) setErr(error.message);
    else {
      setName('');
      setAddress('');
      setFromDomain('');
      await load();
    }
    setBusy(false);
  }

  async function toggleDkim(ib: Inbox) {
    await supabase.from('inboxes').update({ dkim_verified: !ib.dkim_verified }).eq('id', ib.id);
    await load();
  }

  async function saveSignature(ib: Inbox, signature: string) {
    await supabase.from('inboxes').update({ signature }).eq('id', ib.id);
    await load();
  }

  async function setArchived(ib: Inbox, archived: boolean) {
    setErr(null);
    const { error } = await supabase
      .from('inboxes')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', ib.id);
    if (error) setErr(error.message);
    else await load();
  }

  async function remove(ib: Inbox) {
    if (!confirm(`受信箱「${ib.name}」を完全に削除します。よろしいですか？（対応履歴が残っていると削除できません）`)) return;
    setErr(null);
    const { error } = await supabase.from('inboxes').delete().eq('id', ib.id);
    if (error) {
      // 23503 = foreign_key_violation（チケットが紐づいている）
      if (error.code === '23503' || /foreign key/i.test(error.message)) {
        setErr(`受信箱「${ib.name}」には対応履歴（チケット）が残っているため完全削除はできません。代わりに「運用停止」で停止してください（履歴は保持されます）。`);
      } else {
        setErr(error.message);
      }
    } else {
      await load();
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <section style={card}>
        <h2 style={h2}>受信箱（メール接続）</h2>
        <p style={{ color: '#888', fontSize: 12, marginTop: 0 }}>
          顧客からのメールを受け取るアドレスです。受信アドレスのドメインを Mailgun に向け（MXレコード）、
          そのドメイン宛を webhook に転送する Route を設定すると、ここに届いたメールがチケット化されます。
        </p>
        {inboxes.length === 0 ? (
          <p style={{ color: '#999' }}>受信箱はまだありません。</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {inboxes.map((ib) => (
              <li key={ib.id} style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0', opacity: ib.archived_at ? 0.6 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div>
                    <strong>{ib.name}</strong>
                    {ib.archived_at && (
                      <span style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 999, marginLeft: 6 }}>停止中</span>
                    )}
                    <div style={{ fontSize: 13, color: '#444' }}>
                      受信: <code>{ib.inbound_address}</code>
                    </div>
                    <div style={{ fontSize: 12, color: '#777' }}>
                      送信From: {ib.from_domain ? <code>{ib.from_domain}</code> : <span style={{ color: '#999' }}>未設定（metasukeドメインで送信）</span>}
                      {' · '}
                      <span style={{ color: ib.dkim_verified ? '#16a34a' : '#999' }}>
                        {ib.dkim_verified ? 'DKIM認証済（ブランド送信）' : 'DKIM未認証'}
                      </span>
                    </div>
                  </div>
                  {isAdmin && (
                    <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {ib.archived_at ? (
                        <button style={{ ...buttonGhost, padding: '2px 8px', fontSize: 12 }} onClick={() => setArchived(ib, false)}>
                          再開
                        </button>
                      ) : (
                        <button style={{ ...buttonGhost, padding: '2px 8px', fontSize: 12 }} onClick={() => toggleDkim(ib)}>
                          {ib.dkim_verified ? 'DKIM解除' : 'DKIM認証ON'}
                        </button>
                      )}
                      {ib.archived_at ? (
                        <button style={{ ...buttonGhost, padding: '2px 8px', fontSize: 12, color: '#b00', borderColor: '#b00' }} onClick={() => remove(ib)}>
                          削除
                        </button>
                      ) : (
                        <button style={{ ...buttonGhost, padding: '2px 8px', fontSize: 12, color: '#92400e', borderColor: '#d97706' }} onClick={() => setArchived(ib, true)}>
                          運用停止
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {isAdmin && !ib.archived_at && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>署名を編集</summary>
                    <SignatureEditor initial={ib.signature ?? ''} onSave={(s) => saveSignature(ib, s)} />
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isAdmin ? (
        <section style={card}>
          <h2 style={h2}>受信箱を追加</h2>
          <label style={{ fontSize: 12, color: '#666' }}>表示名</label>
          <input style={input} placeholder="例: サポート窓口" value={name} onChange={(e) => setName(e.target.value)} />
          <label style={{ fontSize: 12, color: '#666' }}>受信アドレス</label>
          <input style={input} placeholder="例: support@mailgun.chidakiyo.com" value={address} onChange={(e) => setAddress(e.target.value)} />
          <label style={{ fontSize: 12, color: '#666' }}>送信Fromドメイン（任意・未入力なら受信アドレスのドメイン）</label>
          <input style={input} placeholder="例: mailgun.chidakiyo.com" value={fromDomain} onChange={(e) => setFromDomain(e.target.value)} />
          <button style={button} disabled={busy} onClick={create}>
            追加
          </button>
          {err && <p style={{ color: '#b00', fontSize: 13 }}>{err}</p>}
        </section>
      ) : (
        <p style={{ color: '#999', fontSize: 12 }}>受信箱の追加・編集は組織の管理者のみ可能です。</p>
      )}
    </div>
  );
}

function SignatureEditor({ initial, onSave }: { initial: string; onSave: (s: string) => void }) {
  const [val, setVal] = useState(initial);
  const [saved, setSaved] = useState(false);
  return (
    <div style={{ marginTop: 6 }}>
      <textarea
        value={val}
        onChange={(e) => {
          setVal(e.target.value);
          setSaved(false);
        }}
        rows={3}
        style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }}
        placeholder="メール末尾に付与する署名"
      />
      <button
        style={{ ...buttonGhost, padding: '4px 10px', fontSize: 12 }}
        onClick={() => {
          onSave(val);
          setSaved(true);
        }}
      >
        {saved ? '保存済' : '署名を保存'}
      </button>
    </div>
  );
}
