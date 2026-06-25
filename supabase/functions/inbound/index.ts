// metasuke inbound webhook（Supabase Edge Functions / Deno）
// メールSaaS（Mailgun）の受信webhook と、開発用の汎用JSON の両方を受ける。
// 設計: 「保存＋即200」。宛先(recipient)→組織解決〜スレッド連結は ingest_inbound_email(RPC) が担う。
//
// 受信経路:
//  - 本番: Mailgun Route(forward) → multipart/form-data（recipient/sender/from/subject/body-plain/Message-Id/In-Reply-To/References...）
//  - 開発: 「テスト受信」ボタン → application/json（汎用形状）
//
// 環境変数:
//  - MAILGUN_WEBHOOK_SIGNING_KEY … 設定時はMailgun署名(timestamp,token,signature)を検証

import { Hono } from 'jsr:@hono/hono';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const app = new Hono().basePath('/inbound');

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

// "Name <email>" → {name, email}
function parseFrom(from: string): { email: string; name: string | null } {
  const m = from.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim() || null, email: m[2].trim() };
  return { name: null, email: from.trim() };
}

// Mailgun署名検証: signature == HMAC-SHA256(signingKey, timestamp + token)
async function verifyMailgun(signingKey: string, timestamp: string, token: string, signature: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + token));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === signature;
}

interface IngestParams {
  p_to: string; p_from: string; p_from_name: string | null; p_subject: string | null;
  p_text: string | null; p_html: string | null; p_message_id: string | null;
  p_in_reply_to: string | null; p_references: string[];
}

async function ingest(params: IngestParams) {
  const supabase = adminClient();
  return await supabase.rpc('ingest_inbound_email', params);
}

app.get('/health', (c) => c.json({ ok: true, service: 'metasuke-inbound' }));

app.post('/', async (c) => {
  const ct = c.req.header('content-type') ?? '';

  // --- 開発用: 汎用JSON（テスト受信ボタン） ---
  if (ct.includes('application/json')) {
    let b: Record<string, unknown>;
    try { b = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    if (!b.to || !b.from) return c.json({ error: 'to and from are required' }, 400);
    const { data, error } = await ingest({
      p_to: String(b.to), p_from: String(b.from), p_from_name: (b.from_name as string) ?? null,
      p_subject: (b.subject as string) ?? null, p_text: (b.text as string) ?? null, p_html: (b.html as string) ?? null,
      p_message_id: (b.message_id as string) ?? null, p_in_reply_to: (b.in_reply_to as string) ?? null,
      p_references: (b.references as string[]) ?? [],
    });
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ ok: true, ticket_id: data, matched: data !== null });
  }

  // --- 本番: Mailgun（multipart/form-data） ---
  const form = await c.req.formData();
  const f = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === 'string' ? v : null;
  };

  // 署名検証（鍵が設定されていれば必須）
  const signingKey = Deno.env.get('MAILGUN_WEBHOOK_SIGNING_KEY');
  if (signingKey) {
    const ts = f('timestamp'); const tok = f('token'); const sig = f('signature');
    if (!ts || !tok || !sig || !(await verifyMailgun(signingKey, ts, tok, sig))) {
      return c.json({ error: 'invalid signature' }, 401);
    }
  }

  const recipient = f('recipient'); // この受信箱宛アドレス
  const fromHeader = f('from') ?? f('sender') ?? '';
  if (!recipient || !fromHeader) return c.json({ error: 'recipient/from missing' }, 400);
  const { email, name } = parseFrom(fromHeader);
  const refs = (f('References') ?? '').trim().split(/\s+/).filter(Boolean);

  const { data, error } = await ingest({
    p_to: recipient,
    p_from: email,
    p_from_name: name,
    p_subject: f('subject'),
    p_text: f('body-plain') ?? f('stripped-text'),
    p_html: f('body-html'),
    p_message_id: f('Message-Id'),
    p_in_reply_to: f('In-Reply-To'),
    p_references: refs,
  });
  if (error) return c.json({ error: error.message }, 400);
  // data が null = 宛先に対応する受信箱なし。Mailgunのリトライ抑止のため 200 で無視。
  return c.json({ ok: true, ticket_id: data, matched: data !== null });
});

Deno.serve(app.fetch);
