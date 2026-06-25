// metasuke 事業管理者API（Supabase Edge Functions / Deno）
// 設計: docs/06。テナントアプリとは別。**ここだけが service_role を使う**。
// 全ルートで「呼び出し元が platform_admins か」を検証し、機微操作は監査ログに記録する。
// ブラウザ(apps/admin)はこの関数だけを叩く（PostgREST 直アクセスはRLSで横断不可）。

import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const app = new Hono().basePath('/admin');
app.use('*', cors({
  origin: (o) => o,
  allowHeaders: ['authorization', 'content-type', 'apikey'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
}));

function userClient(auth: string | undefined) {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth ?? '' } } },
  );
}
function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

// 呼び出し元が有効な platform_admin か検証して {uid, role, db(service_role)} を返す
async function authPlatformAdmin(auth: string | undefined):
  Promise<{ uid: string; role: string; db: SupabaseClient } | null> {
  const su = userClient(auth);
  const { data: u } = await su.auth.getUser();
  if (!u.user) return null;
  const db = adminClient();
  const { data: pa } = await db
    .from('platform_admins').select('role,status').eq('user_id', u.user.id).maybeSingle();
  if (!pa || pa.status !== 'active') return null;
  return { uid: u.user.id, role: pa.role as string, db };
}

async function audit(db: SupabaseClient, actorId: string, action: string,
  opts: { target_org_id?: string; target_user_id?: string; reason?: string; payload?: unknown } = {}) {
  await db.from('platform_audit_log').insert({
    actor_id: actorId,
    action,
    target_org_id: opts.target_org_id ?? null,
    target_user_id: opts.target_user_id ?? null,
    reason: opts.reason ?? null,
    payload: opts.payload ?? {},
  });
}

function monthStartISO(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString();
}

// 自分が運営者か（admin appのゲート用）
app.get('/whoami', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  return c.json({ role: ctx.role });
});

// テナント一覧（検索）
app.get('/tenants', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  const q = c.req.query('q')?.trim();
  let query = ctx.db.from('v_admin_tenant_summary').select('*').order('created_at', { ascending: false });
  if (q) query = query.ilike('name', `%${q}%`);
  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ tenants: data ?? [] });
});

// テナント詳細（利用状況・メンバー）。閲覧を監査記録。
app.get('/tenants/:id', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');

  const { data: summary } = await ctx.db.from('v_admin_tenant_summary').select('*').eq('id', id).maybeSingle();
  if (!summary) return c.json({ error: 'tenant not found' }, 404);

  const { data: members } = await ctx.db.from('v_org_members').select('user_id,display_name,email,role').eq('org_id', id);
  const { data: inboxes } = await ctx.db.from('inboxes').select('name,inbound_address,dkim_verified').eq('org_id', id);

  const since = monthStartISO();
  const inRes = await ctx.db.from('messages').select('id', { count: 'exact', head: true })
    .eq('org_id', id).eq('direction', 'inbound').gte('created_at', since);
  const outRes = await ctx.db.from('messages').select('id', { count: 'exact', head: true })
    .eq('org_id', id).eq('direction', 'outbound').gte('created_at', since);
  const aiRes = await ctx.db.from('ai_suggestions').select('id', { count: 'exact', head: true })
    .eq('org_id', id).eq('type', 'draft').gte('created_at', since);
  const inboundThisMonth = inRes.count ?? 0;
  const outboundThisMonth = outRes.count ?? 0;
  const aiThisMonth = aiRes.count ?? 0;

  await audit(ctx.db, ctx.uid, 'tenant.view', { target_org_id: id });

  return c.json({
    tenant: summary,
    members: members ?? [],
    inboxes: inboxes ?? [],
    usage: { inboundThisMonth, outboundThisMonth, aiDraftsThisMonth: aiThisMonth },
  });
});

// 監査ログ（actor/orgを名前に解決して返す。解決は in(...) のバッチで N+1 回避）
app.get('/audit', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const { data: events } = await ctx.db.from('platform_audit_log')
    .select('actor_id,action,target_org_id,reason,payload,created_at')
    .order('created_at', { ascending: false }).limit(limit);
  const rows = events ?? [];

  const actorIds = [...new Set(rows.map((e) => e.actor_id).filter(Boolean))] as string[];
  const orgIds = [...new Set(rows.map((e) => e.target_org_id).filter(Boolean))] as string[];
  const [profRes, orgRes] = await Promise.all([
    actorIds.length ? ctx.db.from('profiles').select('user_id,email,display_name').in('user_id', actorIds) : Promise.resolve({ data: [] }),
    orgIds.length ? ctx.db.from('organizations').select('id,name').in('id', orgIds) : Promise.resolve({ data: [] }),
  ]);
  const pmap = new Map((profRes.data ?? []).map((p: { user_id: string; email: string | null; display_name: string | null }) => [p.user_id, p.display_name || p.email || '']));
  const omap = new Map((orgRes.data ?? []).map((o: { id: string; name: string }) => [o.id, o.name]));

  const enriched = rows.map((e) => ({
    action: e.action,
    reason: e.reason,
    payload: e.payload,
    created_at: e.created_at,
    actor: e.actor_id ? (pmap.get(e.actor_id) ?? `${(e.actor_id as string).slice(0, 8)}…`) : null,
    org_name: e.target_org_id ? (omap.get(e.target_org_id) ?? `${(e.target_org_id as string).slice(0, 8)}…`) : null,
  }));
  return c.json({ events: enriched });
});

// ===== 代理ログイン（impersonation・読み取り専用） =====
// テナントの資格情報は使わず、admin関数が service_role で当該orgに限定して返す。
// 各データルートは「自分の・終了していない・期限内」のセッションを必須にする。

async function activeSession(db: SupabaseClient, adminId: string, id: string) {
  const { data } = await db.from('impersonation_sessions').select('*')
    .eq('id', id).eq('admin_id', adminId).is('ended_at', null).maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null; // 期限切れ
  return data;
}
async function orgName(db: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await db.from('organizations').select('name').eq('id', orgId).maybeSingle();
  return data?.name ?? '';
}

// 開始（理由必須）
app.post('/impersonate', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  let body: { org_id?: string; reason?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  if (!body.org_id || !body.reason?.trim()) return c.json({ error: 'org_id と reason は必須' }, 400);
  const { data: session, error } = await ctx.db.from('impersonation_sessions')
    .insert({ admin_id: ctx.uid, target_org_id: body.org_id, reason: body.reason.trim() })
    .select('*').single();
  if (error) return c.json({ error: error.message }, 400);
  await audit(ctx.db, ctx.uid, 'impersonate.start', { target_org_id: body.org_id, reason: body.reason.trim() });
  return c.json({ session, org_name: await orgName(ctx.db, body.org_id) });
});

// 現在有効なセッション（バナー復元用）
app.get('/impersonate/active', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  const { data } = await ctx.db.from('impersonation_sessions').select('*')
    .eq('admin_id', ctx.uid).is('ended_at', null).gt('expires_at', new Date().toISOString())
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  return c.json({ session: data ?? null, org_name: data ? await orgName(ctx.db, data.target_org_id) : null });
});

// 終了
app.post('/impersonate/:id/end', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  const { data } = await ctx.db.from('impersonation_sessions').update({ ended_at: new Date().toISOString() })
    .eq('id', c.req.param('id')).eq('admin_id', ctx.uid).is('ended_at', null).select('target_org_id').maybeSingle();
  if (data) await audit(ctx.db, ctx.uid, 'impersonate.end', { target_org_id: data.target_org_id });
  return c.json({ ok: true });
});

// 代理閲覧: チケット一覧（読み取り専用）
app.get('/impersonate/:id/tickets', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  const s = await activeSession(ctx.db, ctx.uid, c.req.param('id'));
  if (!s) return c.json({ error: 'impersonation session not active' }, 403);
  const { data } = await ctx.db.from('tickets')
    .select('id,subject,status,is_read,last_message_at,contact:contacts(name,email)')
    .eq('org_id', s.target_org_id).order('last_message_at', { ascending: false, nullsFirst: false });
  return c.json({ tickets: data ?? [] });
});

// 代理閲覧: スレッド（読み取り専用）。閲覧を監査。
app.get('/impersonate/:id/tickets/:ticketId', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  const s = await activeSession(ctx.db, ctx.uid, c.req.param('id'));
  if (!s) return c.json({ error: 'impersonation session not active' }, 403);
  const ticketId = c.req.param('ticketId');
  const { data: ticket } = await ctx.db.from('tickets').select('id').eq('id', ticketId).eq('org_id', s.target_org_id).maybeSingle();
  if (!ticket) return c.json({ error: 'ticket not found' }, 404);
  const { data: messages } = await ctx.db.from('messages')
    .select('id,direction,from_addr,subject,body_text,created_at')
    .eq('ticket_id', ticketId).order('created_at', { ascending: true });
  await audit(ctx.db, ctx.uid, 'impersonate.view_ticket', { target_org_id: s.target_org_id, payload: { ticket_id: ticketId } });
  return c.json({ messages: messages ?? [] });
});

Deno.serve(app.fetch);
