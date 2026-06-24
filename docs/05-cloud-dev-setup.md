# metasuke — クラウドdev環境セットアップ（Docker不使用）

> ローカルDockerをやめ、**dev専用のSupabaseクラウドプロジェクト**に直結して開発する手順。
> 本物の環境（実Auth・デプロイ済み関数・Mailgun実webhook）で検証できる。prodは別プロジェクトとして後で用意。
> 最終更新: 2026-06-23

---

## 0. 方針
- **dev専用プロジェクト**を1つ作る（将来のprodとは分ける）。壊れたらダッシュボードから作り直す。
- スキーマはこのリポジトリの `supabase/migrations/*.sql` を **forward-only** で push する（クラウドでは `db reset` は使わない想定）。
- フロントは `npm run dev` のみ。Dockerは不要。

---

## 1. プロジェクト作成（ダッシュボード / ブラウザ）
1. https://supabase.com/dashboard で **New project**（名前例: `metasuke-dev`、リージョンは東京/Asia Northeast 推奨）。
2. 控える：
   - **Project Ref**（`Settings → General` の Reference ID。例 `abcdefgh...`）
   - **DB password**（作成時に設定したもの）
   - `Settings → API` の **Project URL**（`https://<ref>.supabase.co`）と **anon public key**

## 2. CLI でログイン & リンク（ターミナル）
```bash
supabase login                       # ブラウザ認証（または SUPABASE_ACCESS_TOKEN）
supabase link --project-ref <ref>    # DBパスワードを聞かれる
```

## 3. スキーマを push（マイグレーション適用）
```bash
supabase db push                     # 0001_init.sql / 0002_inbound.sql をクラウドへ
```

## 4. Auth設定（dev用にメール確認をオフ）
ダッシュボード `Authentication → Sign In / Providers → Email` で **Confirm email を OFF**（ローカルと同じく即ログインにするため）。
※ 本番では ON 推奨。

## 5. 関数をデプロイ
```bash
supabase functions deploy api
supabase functions deploy inbound --no-verify-jwt   # webhookは公開（JWT検証なし）
```
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` はデプロイ済み関数に自動注入される（Phase 1では手動シークレット不要）。
- AI（OpenAI）キーは Phase 4 で `supabase secrets set OPENAI_API_KEY=... [OPENAI_MODEL=gpt-4o-mini]`。メール送信は `supabase secrets set MAILGUN_API_KEY=... MAILGUN_DOMAIN=...`。

## 6. フロントの環境変数をクラウドに向ける
`apps/web/.env`（gitignore対象）を以下に更新：
```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
VITE_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1
```

## 7. 起動 & 確認
```bash
npm run dev                          # http://localhost:5173
```
- 新規登録 → 組織作成 → 受信箱作成 → 「テスト受信」でチケットが出ることを確認。

## 8. ローカルDockerを停止
```bash
supabase stop                        # ローカルスタックを落とす（もう使わない）
```

---

## 9. 以後の開発フロー
- スキーマ変更：`supabase/migrations/` に新しい `000N_*.sql` を追加 → `supabase db push`。
- 関数変更：`supabase functions deploy <name>`。
- フロント：`npm run dev`（ローカル）。本番配信は Cloudflare Pages（別途）。
- やり直したい時：dev プロジェクトをダッシュボードから削除して作り直し、`db push` で再構築。

## 注意
- `apps/web/.env` と service_role キーは**コミットしない**（`.gitignore` 済み）。
- クラウドは共有・永続。破壊的変更は新マイグレーションで前進させる。
- Mailgun連携（Phase 1の実受信）：受信webhookのURLを `https://<ref>.supabase.co/functions/v1/inbound` に向ける（Phase 2/メールプロバイダ確定時に設定）。
