# metasuke

AI支援つきメール／問い合わせ共有管理ツール。設計は `docs/` を参照。

- `docs/01-requirements.md` 要件定義
- `docs/02-architecture.md` 技術設計（Vite+React / Hono on Supabase Edge Functions / Supabase / Mailgun / Cloudflare Pages配信）
- `docs/03-mvp-roadmap.md` MVPロードマップ
- `docs/04-data-schema.md` ＋ `supabase/migrations/0001_init.sql` DBスキーマ＋RLS

## 構成（モノレポ / npm workspaces）
```
apps/web              … Vite + React (TS) SPA。Cloudflare Pages で配信
packages/shared       … 共有ドメイン型（フロント/関数で共用）
supabase/migrations   … DBスキーマ（RLS含む）
supabase/functions/api … Hono API（Edge Functions / Deno）
```

## 前提ツール
- Node 20+（`.nvmrc`）
- [Supabase CLI](https://supabase.com/docs/guides/cli)（要インストール）
- Docker（`supabase start` のローカルスタックに必要）

## セットアップ
```bash
npm install

# Supabase ローカルを起動（Postgres/Auth/Studio 等）
supabase start
# 出力された API URL / anon key を控える

# マイグレーション適用（スキーマ＋RLS）
supabase db reset      # 初回。以降は supabase migration up / db push

# フロントの環境変数
cp apps/web/.env.example apps/web/.env
#   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を supabase start の出力で埋める
```

## 起動
```bash
# フロント
npm run dev            # http://127.0.0.1:5173

# API（Edge Functions ローカル）
supabase functions serve api
# health: GET http://127.0.0.1:54321/functions/v1/api/health
```

## Phase 0 の確認（RLSのテナント分離）
1. 2つのメールアドレスでそれぞれ新規登録・ログイン。
2. 各アカウントで組織を作成。
3. 互いの組織が **一覧に出ないこと**（RLSで越境ゼロ）を確認。

詳細な進め方は `docs/03-mvp-roadmap.md`。
