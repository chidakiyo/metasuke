import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
export const FUNCTIONS_URL = import.meta.env.VITE_FUNCTIONS_URL ?? '';

export const supabase = createClient(url, anonKey);

// 運営API（admin Edge Function）を呼ぶ。ブラウザは service_role を持たず、
// 自分のJWTを渡すだけ。横断データは関数側が service_role で取得して返す。
export async function adminApi<T = unknown>(path: string): Promise<T> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token ?? '';
  const res = await fetch(`${FUNCTIONS_URL}/admin${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function adminApiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token ?? '';
  const res = await fetch(`${FUNCTIONS_URL}/admin${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
