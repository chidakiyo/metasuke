// metasuke API（Supabase Edge Functions / Deno 上の Hono）
// 業務ロジックの入口。Phase 0 は health チェックと、RLSが効くことを示す /me を用意。
// 重い処理が出たら、このエンドポイントだけ Cloud Run へ移植できるよう
// ロジックは packages/shared 相当へ寄せる方針（02-architecture.md §1）。

import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const app = new Hono().basePath('/api');

app.use(
  '*',
  cors({
    origin: (origin) => origin, // 開発用。本番は許可オリジンを限定する
    allowHeaders: ['authorization', 'content-type', 'apikey'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }),
);

// 公開ヘルスチェック
app.get('/health', (c) => c.json({ ok: true, service: 'metasuke-api' }));

// 呼び出し元ユーザーのコンテキストで Supabase クライアントを作る（RLS適用）
function userClient(authHeader: string | undefined) {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader ?? '' } } },
  );
}

// 認証ユーザーと、その所属組織を返す（RLSで自分の所属のみ）
app.get('/me', async (c) => {
  const supabase = userClient(c.req.header('Authorization'));
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) return c.json({ error: 'unauthorized' }, 401);

  const { data: orgs, error } = await supabase
    .from('organizations')
    .select('id,name')
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 400);

  return c.json({ user: { id: userData.user.id, email: userData.user.email }, organizations: orgs });
});

Deno.serve(app.fetch);
