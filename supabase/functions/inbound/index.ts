// metasuke inbound webhook（Supabase Edge Functions / Deno）
// メールSaaS（Mailgun/Postmark等）からの受信webhookを受け、取り込みRPCを呼ぶ。
// 設計: 「保存＋即200」。重い後処理（AI分類など）は将来キューへ（Phase 4）。
//
// 現状は汎用JSON形状を受ける。各プロバイダのwebhookは、この形へ変換する
// アダプタ（mailgun.ts / postmark.ts）を将来噛ませる。

import { Hono } from 'jsr:@hono/hono';
import { createClient } from 'jsr:@supabase/supabase-js@2';

interface InboundPayload {
  to: string;
  from: string;
  from_name?: string;
  subject?: string;
  text?: string;
  html?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string[];
}

const app = new Hono().basePath('/inbound');

function adminClient() {
  // service_role で実行（RLS迂回）。宛先→組織の解決は ingest_inbound_email が担う。
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

app.get('/health', (c) => c.json({ ok: true, service: 'metasuke-inbound' }));

app.post('/', async (c) => {
  let body: InboundPayload;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  if (!body.to || !body.from) return c.json({ error: 'to and from are required' }, 400);

  const supabase = adminClient();
  const { data, error } = await supabase.rpc('ingest_inbound_email', {
    p_to: body.to,
    p_from: body.from,
    p_from_name: body.from_name ?? null,
    p_subject: body.subject ?? null,
    p_text: body.text ?? null,
    p_html: body.html ?? null,
    p_message_id: body.message_id ?? null,
    p_in_reply_to: body.in_reply_to ?? null,
    p_references: body.references ?? [],
  });

  if (error) return c.json({ error: error.message }, 400);
  // data が null = 宛先に対応する受信箱なし。リトライ抑止のため 200 で無視。
  return c.json({ ok: true, ticket_id: data, matched: data !== null });
});

Deno.serve(app.fetch);
