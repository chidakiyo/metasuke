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

// 監査ログ
app.get('/audit', async (c) => {
  const ctx = await authPlatformAdmin(c.req.header('Authorization'));
  if (!ctx) return c.json({ error: 'forbidden' }, 403);
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const { data } = await ctx.db.from('platform_audit_log')
    .select('actor_id,action,target_org_id,reason,created_at').order('created_at', { ascending: false }).limit(limit);
  return c.json({ events: data ?? [] });
});

Deno.serve(app.fetch);
