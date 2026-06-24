// metasuke AI返信下書き生成（Supabase Edge Functions / Deno）
// 認証ユーザーでチケット検証 → AI ON/OFF・月次上限チェック → 下書き生成 → ai_suggestions に記録。
// 生成はプロバイダ抽象（今は OpenAI）。OPENAI_API_KEY 未設定なら dry-run スタブを返す。
// ※ 下書きは返すだけ。送信は人間が承認（自動送信しない）。
//
// 環境変数:
//   OPENAI_API_KEY  … プラットフォーム共通キー（supabase secrets set）
//   OPENAI_MODEL    … 既定 'gpt-4o-mini'（最安モデルを設定）
//   OPENAI_BASE_URL … 既定 'https://api.openai.com/v1'

import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const DEFAULT_DRAFT_LIMIT = 100;

const app = new Hono().basePath('/draft');
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

interface ThreadMsg { direction: string; from_addr: string | null; body_text: string | null }

// --- プロバイダ抽象（今は OpenAI） ---
async function generateDraft(
  thread: ThreadMsg[],
  instruction: string | null,
): Promise<{ text: string; model: string; dryRun: boolean }> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  const model = Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini';
  const baseUrl = Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';

  const convo = thread
    .map((m) => `${m.direction === 'inbound' ? '顧客' : '自社'}: ${m.body_text ?? ''}`)
    .join('\n\n');
  const system =
    'あなたはカスタマーサポートの返信下書きを作成するアシスタントです。' +
    '日本語で、丁寧かつ簡潔に。これまでのやり取りを踏まえ、顧客への返信本文の下書きのみを出力してください。' +
    '宛名・署名・件名は含めないでください。';
  const user =
    `これまでのやり取り:\n${convo}\n\n` +
    (instruction ? `補足指示: ${instruction}\n\n` : '') +
    '上記に対する返信本文の下書きを作成してください。';

  if (!apiKey) {
    // dry-run（キー未設定）。フロー確認用のスタブ。
    return {
      text: '【AI下書き(dry-run)】お問い合わせありがとうございます。確認の上、改めてご連絡いたします。（OPENAI_API_KEY 未設定のためスタブを返しています）',
      model: `${model} (dry-run)`,
      dryRun: true,
    };
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 800,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text: string = json.choices?.[0]?.message?.content ?? '';
  return { text, model, dryRun: false };
}

function monthStartISO(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

app.post('/', async (c) => {
  const supabase = userClient(c.req.header('Authorization'));
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return c.json({ error: 'unauthorized' }, 401);

  let body: { ticket_id?: string; instruction?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  if (!body.ticket_id) return c.json({ error: 'ticket_id is required' }, 400);

  // チケット取得（RLSで自組織のみ）
  const { data: ticket, error: tErr } = await supabase
    .from('tickets').select('id,org_id').eq('id', body.ticket_id).single();
  if (tErr || !ticket) return c.json({ error: 'ticket not found' }, 404);
  const orgId = ticket.org_id as string;

  // AI ON/OFF
  const { data: org } = await supabase.from('organizations').select('ai_enabled').eq('id', orgId).single();
  if (!org?.ai_enabled) return c.json({ error: 'AIはこの組織で無効です' }, 403);

  // 月次上限
  const { data: ent } = await supabase.from('org_entitlements').select('monthly_draft_limit').eq('org_id', orgId).maybeSingle();
  const limit = ent?.monthly_draft_limit ?? DEFAULT_DRAFT_LIMIT;
  const { count } = await supabase
    .from('ai_suggestions').select('id', { count: 'exact', head: true })
    .eq('org_id', orgId).eq('type', 'draft').gte('created_at', monthStartISO());
  const used = count ?? 0;
  if (used >= limit) return c.json({ error: `今月のAI下書き上限（${limit}）に達しました`, used, limit }, 429);

  // スレッド
  const { data: msgs } = await supabase
    .from('messages').select('direction,from_addr,body_text')
    .eq('ticket_id', body.ticket_id).order('created_at', { ascending: true });

  // 生成
  let result: { text: string; model: string; dryRun: boolean };
  try {
    result = await generateDraft((msgs ?? []) as ThreadMsg[], body.instruction ?? null);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }

  // 記録（採否は後で更新可能。ここでは未判定）
  await supabase.from('ai_suggestions').insert({
    org_id: orgId,
    ticket_id: body.ticket_id,
    type: 'draft',
    output: { text: result.text },
    model: result.model,
  });

  return c.json({ ok: true, draft: result.text, model: result.model, dry_run: result.dryRun, used: used + 1, limit });
});

Deno.serve(app.fetch);
