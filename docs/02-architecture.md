# metasuke — 技術設計・アーキテクチャ（ドラフト v0.1）

> 対象: 要件定義書 `01-requirements.md` を実装するための技術選定とアーキテクチャ
> ステータス: 🟡 ドラフト
> 最終更新: 2026-06-22

---

## 1. 技術選定（確定方針）— 2ベンダー構成

デプロイの単純さ・速さを最優先し、**ベンダーを Supabase + メールSaaS の2つに絞る**。
独立したアプリサーバ（Cloud Run等）は持たず、業務ロジックは **Supabase Edge Functions（Deno）上の Hono** で動かす。

| 層 | 採用技術 | 理由 |
|---|---|---|
| フロントエンド | **Vite + React (TypeScript)** | SPA。Next.jsより軽量。Supabaseクライアントで保護された読み取り |
| API / バックエンド | **Hono (TypeScript) on Supabase Edge Functions (Deno)** | 業務ロジック（webhook処理・AI下書き生成・送信指示）。`supabase functions deploy` で即デプロイ |
| DB / 認証 / ストレージ | **Supabase**（Postgres + RLS + Auth + Storage） | マルチテナント分離(RLS)・認証・添付保存を同梱。SaaS土台を最短で |
| ジョブ/キュー | **Supabase Queues (pgmq) + pg_cron** | 受信メールのAI分類など非同期処理。受信webhookと切り離す |
| メール基盤 | **Mailgun または Postmark** | 受信(inbound webhook)が成熟・ドメイン認証(DKIM)対応 |
| AI | **OpenAI API**（プロバイダ抽象化・将来Claude等差替可） | 下書き=最安モデル（`gpt-4o-mini` 既定, env `OPENAI_MODEL`）。AI ON/OFF・月次上限あり・**BYOK対応予定** |
| リアルタイム在席 | **Supabase Realtime** | 二重対応防止の在席・ロック表示 |
| フロント配信 | **Cloudflare Pages**（静的SPA＋CDN） | Vite/Reactの静的ビルドを配信。gitプッシュで即デプロイ・SPAルーティング対応。バックエンド(Supabase+Mailgun)とは独立デプロイ |

### 選定の根拠メモ
- **Supabase が中核に最適な理由**：非機能要件「全データを `org_id` で分離・越境ゼロ」を **RLS でDBレベル強制**できる。Auth/Storage/Realtime/Queues/Edge Functions まで同梱で、配管とベンダーを最小化。
- **2ベンダーに絞る理由**：デプロイがコンテナのビルド/レジストリ/更新を伴わず、`supabase` CLI 一本で完結。立ち上げと反復が速い。
- **Hono を採用する理由（移植性の確保）**：Edge Functions(Deno)で動くが、将来重い処理が出たら**特定エンドポイントだけ Cloud Run へ移せる**。ロジックは `packages/shared` に寄せ移植可能にする（エスケープハッチ）。
- **Cloudflare の役割は静的配信(CDN)のみ**：フロントSPAを Cloudflare Pages で配信。バックエンド2ベンダー（Supabase＝データ/API、Mailgun＝メール）には含めず、デプロイも独立。将来、在席ロックを厳密化したくなったら Durable Objects を検討。

### Edge Functions運用の設計原則（懸念回避）
1. **AIは単発のストリーミング呼び出しに限定**（多段エージェント処理を1リクエストに詰めない）。CPUではなくI/O待ちが主体なので実行時間制限に当たりにくい。
2. **受信webhookは「保存＋キュー投入」で即200を返す**。AI分類はQueuesで非同期化し、受信応答とAI遅延を分離。
3. **重い処理が出たら該当エンドポイントのみCloud Runへ移植**。大きな添付はパースせずStorageへストリーム保存。

❓TODO: メールプロバイダを Mailgun / Postmark のどちらに確定するか（受信ルーティングの作りやすさ・日本到達率で比較）。
❓TODO: Edge Functionsの実行時間上限が下書き生成に十分か、初期に実測で確認。

---

## 2. システム構成図（論理）

```
[ブラウザ: Vite+React SPA]
   │  ① 読み取り（RLSで保護）       ② 操作・送信・AI生成
   ▼                                 ▼
┌─────────────────── Supabase ───────────────────────────┐
│  Postgres(RLS) / Auth / Storage / Realtime / Queues     │
│      ▲                                                   │
│      │ ③ Realtime(在席/更新通知)                          │
│  [Edge Functions: Hono]                                  │
│      │   ├──▶ [OpenAI API]（AI下書き生成。将来Claude等差替可）  │
│      │   └──▶ [メールSaaS 送信API]（DKIM署名で顧客ドメイン送信）  │
│      │                                                   │
│  [Queue worker: Hono]  ◀── pgmq/pg_cron ── (AI分類など非同期) │
└──────────────────────────────────────────────────────────┘
   ▲
   │ ④ inbound webhook（保存＋キュー投入で即200）
[メールSaaS inbound] ──▶ [Edge Functions: Hono] ──▶ Ticket/Message作成 ──▶ Queueへ
```

- ①読み取り：一覧やスレッド表示は SPA から Supabase へ直接（RLSでテナント分離を保証）。
- ②操作：送信・ステータス変更・AI下書き生成など副作用のある操作は Edge Functions(Hono) 経由。
- ③Realtime：在席表示・新着通知は Supabase Realtime で配信。
- ④受信：メールSaaSの inbound webhook を Hono が受け、保存＋キュー投入で即返し。AI分類はワーカーで非同期。

---

## 3. マルチテナント分離（RLS設計の方針）

- 全テーブルに `org_id` 列。RLSポリシーで `org_id = auth.jwt()->>'org_id'`（または members 経由）に一致する行のみ許可。
- ユーザーは複数組織に所属し得る（将来）。MVPは1ユーザー＝1組織でも、設計は members テーブルで多対多に。
- Hono API はサービスロール鍵を使うが、**必ず呼び出し元のユーザー/組織コンテキストでスコープ**するヘルパを通す（サービスロールでの無条件アクセスを禁止）。

❓TODO: JWTに `org_id` を載せるか、`memberships` テーブルをRLSで参照するか（組織切り替えUXに影響）。

---

## 4. メール送受信の設計

### 受信（inbound）
1. メールSaaSが受信 → inbound webhook を Hono へ POST。
2. 署名検証 → MIMEパース（本文/HTML/添付）。
3. `Message-ID` / `In-Reply-To` / `References` で既存スレッドへ連結 or 新規 `Ticket` 作成。
4. 添付は Supabase Storage へ。
5. (任意) AI分類ジョブをキュー投入 → カテゴリ/タグ/優先度の提案を `AISuggestion` に保存。
6. 担当者・購読者へ Realtime / 通知。

### 送信（outbound）
1. Hono が `Message`(direction=outbound) を作成。
2. メールSaaS(Mailgun)が**MTA（実送信）**。From は **`inboxes.from_domain` ＋ `dkim_verified` で分岐**：
   - `dkim_verified=true` → `From: support@テナントドメイン`（**ブランド送信**。テナントが SPF/DKIM の **TXT** を追加＝MXに非干渉なので転送受信と共存）。
   - `false` → **metasukeの認証済みドメインから送信**（フォールバック。Zendesk式：検証前はSaaSドメイン、検証後は自社ドメイン）。
3. **Reply-To に ticket トークン**（例 `t+<ticket_id>@inbound.metasuke.app`）を付け、顧客の返信を metasuke ドメインに集約＋スレッド連結を堅牢化（In-Reply-To/References に依存しない）。
4. 送信結果（成功/バウンス/苦情）を webhook で受け、ステータス・履歴に反映。
5. （将来の別解）テナントのSMTP/OAuthで本人として送る（Zendeskの認証SMTPコネクタ相当・新規DNS不要だが認証情報保持が必要）。

### メール接続方式（テナント単位の設定・競合準拠）
競合（メールディーラー/Re:lation/yaritori/Zendesk/Freshdesk）の調査結果として、**MTAにテナント独自ドメインを増やす方式は使われていない**。接続方式は**テナント単位の設定（DBの inbox に持つ）**として実装し、Route/ドメインは増やさない。

| 方式 | 内容 | Gmail/M365 | 自前サーバ | 優先 |
|---|---|---|---|---|
| **転送（Forwarding）** | テナントが support@ を metasuke の受信アドレスに転送。受信ドメイン1つ・Route1本 | ✅ | ✅ | **基本（採用・実装済み）** |
| **OAuth（Gmail/M365 API）** | 既存メールボックスにOAuth接続して取得・送信。最も良い体験 | ✅本命 | ✗ | 次（本命） |
| **IMAP/POP＋パスワード** | 既存メールボックスをポーリング取得 | ✗(基本認証廃止) | ✅ | 最後（自前向け） |

重要：**Gmail/M365 は基本認証(IMAP/POPパスワード)を廃止済み → これらは OAuth 必須**。IMAP/POPパスワードは自前メールサーバ専用。よって順番は **転送（universal・今すぐ）→ OAuth Gmail→M365（大手向け本命）→ IMAP（レガシー）**。

接続方式・認証情報は inbox（または専用テーブル）に保持。認証情報/トークンは**暗号化保存**（BYOKの鍵保管と同方式）。IMAP/OAuthは**webhookでなく定期ポーリング(cron: pg_cron＋取得関数)**が必要。

### マルチテナントとMTAの関係
**Mailgun自体はテナントを知らない**。Mailgunは「受信→webhookへPOST」までで、**どのテナント宛かはアプリ側が宛先(recipient)アドレスから解決**する（`ingest_inbound_email` が `inboxes.inbound_address` を引く）。これがマルチテナント受信の肝。テナント判別は**宛先アドレス**で行うため、各受信箱に一意アドレスを払い出す。

### ドメイン戦略（採用）
- **案A（推奨・MVP）**：共通受信ドメイン1つ＋キャッチオールRoute1本。各テナント受信箱に一意アドレスを払い出し、テナントは自社 `support@…` を**転送**（DNS不要）。送信ブランド化したいテナントだけ自社ドメインのDKIM/SPFを設定。
- **案B（将来）**：テナントごとに独自ドメイン（Mailgun APIでドメイン＋Route自動生成、テナントはMX＋DKIMをDNS設定）。
- 共有送信は送信者レピュテーションを共有する点に注意（規模が出たら分離）。

### Mailgun連携手順（実装側は対応済み：inbound関数がmultipart＋署名検証を処理）
1. 受信ドメイン（例 `inbound.example.com`）を Mailgun に追加。
2. DNSに **MXレコード**（`mxa.mailgun.org` / `mxb.mailgun.org`）を設定。
3. Mailgun **Route**（catch-all 等）→ action: forward → `https://<ref>.supabase.co/functions/v1/inbound`。
4. `supabase secrets set MAILGUN_WEBHOOK_SIGNING_KEY=...`（署名検証を有効化）→ `supabase functions deploy inbound`。
5. 送信は `supabase secrets set MAILGUN_API_KEY=... MAILGUN_DOMAIN=...` → `deploy send`、送信ドメインの DKIM/SPF 認証。
6. テナントアプリで受信箱を作成（`inbound_address` をその受信ドメイン上のアドレスに）。

### 開発時の受信（外部MUA不要・本番直結）
転送方式は外部に Gmail 等の MUA が要る。開発では**自分の(サブ)ドメインのMXをMailgunへ向け**、`match_recipient(".*@inbound.<自分のドメイン>")` の Route 1本にすると、**任意のメールクライアントから直接 `acme@inbound.<自分のドメイン>` 宛に送って受信テスト**できる（外部転送不要）。これは**本番の案A（共通ドメイン）と同一構成**なのでそのまま育つ。サンドボックスは「ドメイン取得前のつなぎ」。
- ⚠ Route式は **catch_all を避け `match_recipient` でドメイン限定**（同一Mailgunアカウントを他アプリと共用しても衝突しないため）。

❓TODO: バウンス・苦情・自動応答ループ対策の具体化。

---

## 5. 二重対応防止のリアルタイム実装

- **MVP**: Supabase Realtime（Presence機能）で「このチケットを開いている/編集中のユーザー」をブロードキャスト。送信直前に最新状態を再取得し競合検知。
- **将来**: Cloudflare Durable Objects で厳密な在席・ソフトロックを集中管理（スケール・一貫性向上）。

---

## 6. AI 呼び出しの実装方針

- **プロバイダ抽象化**で実装（`draft` Edge Function 内に生成ロジック）。**現状はOpenAIを採用**（既存のOpenAI課金を利用。最安モデル `gpt-4o-mini` 既定、env `OPENAI_MODEL` で変更可）。将来 Claude 等への差し替えが容易な構造。
- `OPENAI_API_KEY` 未設定なら **dry-run スタブ**を返す（フロー検証用）。
- すべて `ai_suggestions` に記録。下書きは返信エディタに挿入のみ・**送信は人間承認後のみ**（[[人間承認]]）。
- コスト制御：組織単位の **AI ON/OFF（`organizations.ai_enabled`）** と **月次下書き上限（`org_entitlements.monthly_draft_limit`）** を draft 関数で強制。
- **BYOK（テナントが自分のAPIキーを設定）対応予定**（Phase 4b。キーは暗号化保存しクライアントに返さない設計）。
- 将来：要約・自動分類、プロンプトキャッシュ／構造化出力の活用、ストリーミング中継。

---

## 7. 環境・デプロイ（後で詳細化）

- リポジトリ構成: モノレポ（`apps/web` = テナントアプリ, `apps/admin` = 事業管理者コンソール, `supabase/functions/*` = Hono(Edge Functions), `packages/shared` = 共有型）。
- デプロイ: **`supabase` CLI 一本**で完結（`supabase db push` でマイグレーション、`supabase functions deploy` で関数）。コンテナのビルド/レジストリ不要で速い。
- フロント: 静的ビルドを任意のホスティングへ（将来CDNが要れば Cloudflare Pages 等）。
- シークレット管理: Supabase secrets（`OPENAI_API_KEY` / `OPENAI_MODEL`、メールSaaSの `MAILGUN_API_KEY`/`MAILGUN_DOMAIN`）。
- **デプロイ済み Edge Functions**：`api`（/health, /me）・`inbound`（受信webhook）・`send`（返信送信, Mailgun or dry-run）・`draft`（AI下書き, OpenAI or dry-run）・`admin`（事業管理者API・service_role・運営者検証＋監査）。
- **フロント配信**：Cloudflare Pages を**2サイト**（`apps/web`＝テナント, `apps/admin`＝運営。理想は別ドメイン app./admin.）。CDN/静的のみで Workers 不要。本番は Edge Functions の CORS を実ドメインに制限、admin に Cloudflare Access/IP許可（任意・推奨）。
- **移植性**: 重い処理が出たら該当エンドポイントだけ Cloud Run へ移せる構造を保つ（将来のエスケープハッチ）。

❓TODO: ステージング/本番の分離（Supabaseプロジェクトを分ける or ブランチ機能）。
