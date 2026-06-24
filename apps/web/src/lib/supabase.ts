import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // 開発時の取りこぼし防止
  console.warn(
    'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。apps/web/.env を確認してください。',
  );
}

export const supabase = createClient(url ?? '', anonKey ?? '');
