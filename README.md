# metasuke

AI支援つきメール／問い合わせ共有管理ツール。**作業コンテキストは `CLAUDE.md`**、設計は `docs/` を参照。

- `docs/01-requirements.md` 要件定義 / `docs/02-architecture.md` 技術設計 / `docs/03-mvp-roadmap.md` ロードマップ
- `docs/04-data-schema.md` スキーマ / `docs/05-cloud-dev-setup.md` クラウドdev / `docs/06-platform-admin-design.md` 運営画面

## 構成（モノレポ / npm workspaces）
```
apps/web              … テナント用アプリ（Vite+React）。Cloudflare Pages で配信（dev: 5174）
apps/admin            … 事業管理者コンソール（Vite+React）。別サイト配信（dev: 5175）
packages/shared       … 共有ドメイン型
supabase/migrations   … DBスキーマ（RLS含む, 0001〜）
supabase/functions    … Edge Functions（api / inbound / send / draft / admin）
```

> 現在はクラウド Supabase に直結して開発（Docker不要）。起動コマンド・テストアカウントは `CLAUDE.md`。

## 前提ツール
- Node 20+（`.nvmrc`）
- [Supabase CLI](https://supabase.com/docs/guides/cli)（マイグレーション/関数デプロイ用）
- ※ **クラウド Supabase に直結**して開発するため Docker は不要

## セットアップ & 起動
```bash
npm install
cp apps/web/.env.example apps/web/.env       # クラウドの URL / anon key / FUNCTIONS_URL を設定
cp apps/admin/.env.example apps/admin/.env

# 別プロジェクト(grouptool)が 5173 を使うためポートを固定して起動
npm run dev -w @metasuke/web   -- --port 5174 --strictPort   # テナントアプリ http://localhost:5174
npm run dev -w @metasuke/admin -- --port 5175 --strictPort   # 運営コンソール http://localhost:5175
```

スキーマ適用・関数デプロイ・テストアカウント・本番配信などの詳細は **`CLAUDE.md`** と `docs/05-cloud-dev-setup.md` を参照。
