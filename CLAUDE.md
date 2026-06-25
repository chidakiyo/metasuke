# CLAUDE.md — metasuke

このファイルは Claude Code がセッション横断で参照する作業コンテキスト。**変更があれば随時更新する**（末尾「メンテナンス方針」参照）。

## 概要
AI支援つき**メール／問い合わせ共有管理ツール**（メールディーラー/Zendesk/Re:lation/yaritori 系）。**SaaS・マルチテナント**。
3層アクター：**事業管理者**（運営=自社）／**テナント**（顧客企業 organizations+memberships）／**顧客**（contacts、ログインせずメールするだけ）。

## 構成（モノレポ / npm workspaces）
```
apps/web         テナント用アプリ（Vite+React）   … 受信箱・対応・AI下書き・招待
apps/admin       事業管理者コンソール（Vite+React）… テナント横断・利用状況・監査  ※テナントアプリと完全分離
packages/shared  共有ドメイン型
supabase/
  migrations/    DBスキーマ＋RLS（0001〜, supabase db push で適用）
  functions/     Edge Functions（Hono on Deno）: api / inbound / send / draft / admin
  config.toml    各関数の verify_jwt 設定など
docs/            設計ドキュメント（下の索引参照）
```

## ローカル開発（重要：別プロジェクト巻き添え注意）
- 並行して別プロジェクト **`grouptool`** が **ポート5173** を使用中。**広域 `pkill -f vite` は厳禁**（grouptool を巻き込む）。
- metasuke の dev サーバはポートを固定して起動する：
  - テナントアプリ: `npm run dev -w @metasuke/web -- --port 5174 --strictPort` → http://localhost:5174
  - 運営コンソール: `npm run dev -w @metasuke/admin -- --port 5175 --strictPort` → http://localhost:5175
  - ※ ルートの `npm run dev -- --port` はネスト npm で引数が vite に届かず404になる。`-w <pkg> -- --port` 形式を使う。
- 停止はポート限定：`kill $(lsof -nP -iTCP:5174 -sTCP:LISTEN -t)`（5175も同様）。
- **バックエンドはクラウド Supabase**なので Docker/`supabase start` は不要。`npm install` → `npm run dev -w …` だけで動く。

## バックエンド（Supabase クラウド・Dockerフリー）
- dev プロジェクト ref: `aujnbllcexdtdrdwfcck`（URL `https://aujnbllcexdtdrdwfcck.supabase.co`、東京）。
- 接続情報は各アプリの `apps/*/.env`（gitignore）。anon キー/URL/FUNCTIONS_URL を置く。**service_role キーはフロントに置かない**。
- CLI 操作（要 `supabase login`。トークンはキーチェーン保存→DB系コマンドで許可ダイアログが出たら「常に許可」）：
  - マイグレーション適用: `supabase db push`
  - 関数デプロイ: `supabase functions deploy <name> [--no-verify-jwt]`
  - シークレット: `supabase secrets set KEY=...`

## dev テストアカウント（dev専用・本番では使わない / password は共通 `password123`）
- テナント: `chidakiyo+c-a@gmail.com`（CloudOrg-A admin・CloudOrg-B member） / `chidakiyo+c-b@gmail.com`（CloudOrg-B admin・CloudOrg-A member）
- 運営: `chidakiyo+admin@gmail.com`（platform superadmin・テナントとは別アカウント）

## デプロイ（本番）
- フロントは静的SPA → **Cloudflare Pages を2サイト**（CDN/静的のみ・Workers不要）：
  - `apps/web` → 例 `app.metasuke.xxx`／`apps/admin` → 例 `admin.metasuke.xxx`
  - Pages 設定: build `npm run build -w @metasuke/<web|admin>`、出力 `apps/<web|admin>/dist`、env に VITE_*。
- バックエンドは Supabase（共有）。メール=Mailgun、AI=OpenAI。
- 本番化TODO: Edge Functions の **CORS を実ドメインに制限**、admin ドメインに **Cloudflare Access/IP許可**（任意・推奨）。

## 主要な設計判断・規約
- **マルチテナント分離は RLS で強制**。テナント判定は `is_org_member()` / `is_org_admin()`（SECURITY DEFINER, memberships参照）。JWT に org_id は載せない。
- **RLS だけでは不足**：テーブルへの GRANT が別途必要（`authenticated` と `service_role`。無いと `permission denied 42501`）。
- **service_role は Edge Functions 内のみ**。横断（全org）アクセスは admin 関数が service_role で行い、`platform_admins` 検証＋`platform_audit_log` 記録してから返す。
- **AI = OpenAI**（プロバイダ抽象化・将来Claude等差替可・BYOK予定）。最安モデル既定 `gpt-4o-mini`（env `OPENAI_MODEL`）。
- **AIもメールも「キー未設定なら dry-run」**で動く（OPENAI/MAILGUN secrets を入れると実動作に切替）。
- **受信(inbound)はMailgun本番形式(multipart/form-data＋署名検証)と開発用JSONの両対応**。Mailgun連携手順は下記。マルチテナント振り分けは「recipientアドレス→inbox→org」を `ingest_inbound_email` が解決（Mailgunはテナントを知らない／振り分けはアプリ側）。
- **送信は人間承認**（AI下書きは挿入のみ・自動送信しない）。
- 監査トリガ `log_ticket_changes`（status/assign→events）、運営は `platform_audit_log`（追記専用）。

## マイグレーション/関数の追加手順
- スキーマ変更 → `supabase/migrations/000N_*.sql` を追加 → `supabase db push`。**forward-only**（クラウドで db reset しない）。
- 関数変更 → `supabase functions deploy <name>`。
- 注意: `gen_random_bytes`(pgcrypto) はクラウドの search_path に無い→ 使うなら `extensions.` 修飾 or `gen_random_uuid` 系で代替。

## 既知の落とし穴
- ポート衝突（grouptool 5173）→ 上記の固定ポートで起動。
- vite v5 / esbuild dev-server の moderate 警告（本番影響なし。後でメジャー更新）。
- 招待・AI・送信は「実メール/実AI」未設定だと dry-run。実利用は secrets 設定＋deploy。

## ドキュメント索引（`docs/`）
- `01-requirements.md` 要件定義（3層モデル・機能・データモデル・AI・非機能）
- `02-architecture.md` 技術設計（2ベンダー＋Cloudflare Pages・関数構成）
- `03-mvp-roadmap.md` ロードマップ（進捗サマリ）
- `04-data-schema.md` スキーマ要約（マイグレーション一覧）
- `05-cloud-dev-setup.md` クラウドdevセットアップ手順
- `06-platform-admin-design.md` 事業管理者サーフェス設計

## 進捗（要約）
- ✅ テナント Phase 0〜4a（受信→対応→二重対応防止→AI下書き）＋メンバー招待
- ✅ 事業管理者 Phase A（テナント一覧/詳細/利用状況/監査/運営者ロール）＋ Phase B（代理ログイン・読み取り専用・理由必須・期限・監査）
- ✅ プロフィール管理（両アプリのヘッダーから 名前/メール/パスワード 変更。名前=profiles直接更新, メール/PW=auth.updateUser, メール変更は profiles へ同期トリガ 0009）
- ⏳ 実OpenAI/実Mailgun有効化、Cloudflare Pages配信、prod環境、BYOK(4b)、運営Phase C〜D、Phase5機能群

## メンテナンス方針
- **機能追加・構成変更・運用知見が出たらこの CLAUDE.md と該当 `docs/` を更新**してからコミットする。
- 詳細な設計判断は `docs/`、本ファイルは「全体像と作業のしかた」を簡潔に保つ。
