// metasuke 返信送信（Supabase Edge Functions / Deno）
// 認証ユーザーのコンテキストでチケットを検証 → メール送信（Mailgun or dry-run）→ RPCで記録。
// Mailgun未設定（MAILGUN_API_KEY 無し）なら dry-run（実送信せず記録のみ）で動く。
// → 設定後は環境変数を入れるだけで実送信に切り替わる（クライアント変更不要）。

import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const app = new Hono().basePath('/send');

app.use('*', cors({
  origin: (o) => o,
  allowHeaders: ['authorization', 'content-type', 'apikey'],
  allowMethods: ['POST', 'OPTIONS'],
}));

function userClient(auth: string | undefined) {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth ?? '' } } },
  );
}

function reSubject(s: string | null): string {
  const base = (s ?? '').trim();
  if (!base) return '(件名なし)';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

// "name@domain" + tag → "name+tag@domain"（サブアドレス）
function subAddress(addr: string, tag: string): string {
  const at = addr.lastIndexOf('@');
  if (at < 0) return addr;
  return `${addr.slice(0, at)}+${tag}@${addr.slice(at + 1)}`;
}

// Mailgun送信。成功なら確定した Message-Id を返す。未設定なら null（dry-run）。
// sendingDomain は送信元（SPF/DKIM）として使う Mailgun 上の検証済みドメイン。
async function sendViaMailgun(args: {
  sendingDomain: string;
  from: string; to: string; subject: string; text: string;
  replyTo: string | null; inReplyTo: string | null; references: string[];
}): Promise<{ messageId: string | null; dryRun: boolean }> {
  const apiKey = Deno.env.get('MAILGUN_API_KEY');
  const baseUrl = Deno.env.get('MAILGUN_BASE_URL') ?? 'https://api.mailgun.net';
  if (!apiKey || !args.sendingDomain) {
    return { messageId: null, dryRun: true }; // dry-run
  }
  const form = new FormData();
  form.set('from', args.from);
  form.set('to', args.to);
  form.set('subject', args.subject);
  form.set('text', args.text);
  if (args.replyTo) form.set('h:Reply-To', args.replyTo);
  if (args.inReplyTo) form.set('h:In-Reply-To', args.inReplyTo);
  if (args.references.length) form.set('h:References', args.references.join(' '));

  const res = await fetch(`${baseUrl}/v3/${args.sendingDomain}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`api:${apiKey}`) },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`mailgun ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return { messageId: (json.id as string) ?? null, dryRun: false };
}

app.post('/', async (c) => {
  const supabase = userClient(c.req.header('Authorization'));
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return c.json({ error: 'unauthorized' }, 401);

  let body: { ticket_id?: string; body_text?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  if (!body.ticket_id || !body.body_text) {
    return c.json({ error: 'ticket_id and body_text are required' }, 400);
  }

  // チケット・宛先・受信箱を取得（RLSで自組織のみ）
  const { data: ticket, error: tErr } = await supabase
    .from('tickets')
    .select('id,subject,reply_token,contact:contacts(email,name),inbox:inboxes(inbound_address,from_domain,dkim_verified,name)')
    .eq('id', body.ticket_id)
    .single();
  if (tErr || !ticket) return c.json({ error: 'ticket not found' }, 404);

  const contact = ticket.contact as unknown as { email: string } | null;
  const inbox = ticket.inbox as unknown as { inbound_address: string; from_domain: string | null; dkim_verified: boolean; name: string | null } | null;
  if (!contact?.email || !inbox) return c.json({ error: 'missing contact or inbox' }, 400);
  const replyToken = (ticket as unknown as { reply_token: string | null }).reply_token;

  // スレッド連結用に既存メッセージの Message-Id を収集（References チェーン＋直近=In-Reply-To）
  const { data: priorMsgs } = await supabase
    .from('messages')
    .select('message_id')
    .eq('ticket_id', body.ticket_id)
    .order('created_at', { ascending: true });
  const allIds = (priorMsgs ?? []).map((m) => (m as { message_id: string | null }).message_id).filter((x): x is string => !!x);
  const inReplyTo: string | null = allIds.length ? allIds[allIds.length - 1] : null;
  const references = allIds.slice(-10); // 直近10件までを References に

  // From ドメイン分岐: DKIM認証済テナントドメインはブランド送信、未認証は共有ドメイン＋Reply-Toで誘導
  const sharedDomain = Deno.env.get('MAILGUN_SHARED_DOMAIN') ?? Deno.env.get('MAILGUN_DOMAIN') ?? '';
  const inboxName = inbox.name ?? 'サポート';
  const branded = !!(inbox.dkim_verified && inbox.from_domain);
  // Reply-To は常に受信箱アドレスにトークンを埋めたサブアドレス（返信が確実に同チケットへ届く）
  const replyTo = replyToken ? subAddress(inbox.inbound_address, `t-${replyToken}`) : inbox.inbound_address;

  let sendingDomain: string;
  let from: string;
  if (branded) {
    sendingDomain = inbox.from_domain as string;          // 検証済みテナントドメインで送信
    from = `${inboxName} <${inbox.inbound_address}>`;       // テナントブランドの From
  } else {
    sendingDomain = sharedDomain;                          // metasuke 共有の検証済みドメイン
    from = sharedDomain ? `${inboxName} <no-reply@${sharedDomain}>` : `${inboxName} <${inbox.inbound_address}>`;
  }
  const subject = reSubject(ticket.subject as string | null);

  // 送信（or dry-run）
  let sendResult: { messageId: string | null; dryRun: boolean };
  try {
    sendResult = await sendViaMailgun({ sendingDomain, from, to: contact.email, subject, text: body.body_text, replyTo, inReplyTo, references });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }

  // 確定 Message-Id（Mailgunが採番した値、なければ生成）
  const messageId = sendResult.messageId ?? `<out.${Date.now()}.${Math.floor(Math.random() * 1e6)}@metasuke.local>`;

  const { data: msgId, error: rErr } = await supabase.rpc('record_outbound_message', {
    p_ticket_id: body.ticket_id,
    p_from: inbox.inbound_address,
    p_to: contact.email,
    p_subject: subject,
    p_body_text: body.body_text,
    p_message_id: messageId,
    p_in_reply_to: inReplyTo,
    p_references: references,
  });
  if (rErr) return c.json({ error: rErr.message }, 400);

  return c.json({ ok: true, message_id: msgId, dry_run: sendResult.dryRun });
});

Deno.serve(app.fetch);
