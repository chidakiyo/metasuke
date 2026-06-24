# metasuke — データスキーマ設計メモ（ドラフト v0.2）

> 実体は `supabase/migrations/*.sql`（`supabase db push` で適用）。本書はその設計意図の要約。
> ステータス: 🟢 0001〜0006 適用済み / 最終更新: 2026-06-24

---

## 0. マイグレーション一覧（実装済み）
| ファイル | 内容 |
|---|---|
| `0001_init.sql` | 中核13テーブル＋列挙型＋RLS＋GRANT。`is_org_member`/`is_org_admin`、`create_organization()`、メッセージ追加で `tickets.last_message_at` 更新トリガ |
| `0002_inbound.sql` | 受信取り込み `ingest_inbound_email()`（宛先→組織解決・コンタクト名寄せ・スレッド連結・メッセージ作成。service_role限定） |
| `0003_profiles_and_audit.sql` | `profiles`（auth.users表示用・新規作成トリガ）、`v_org_members` ビュー、`log_ticket_changes` 監査トリガ（status/assign→events） |
| `0004_outbound.sql` | 返信記録 `record_outbound_message()`（outbound作成＋replied/既読＋'sent'イベントを原子的に） |
| `0005_invitations.sql` | `invitations` テーブル＋ `accept_invitation(token)`（招待リンク方式） |
| `0006_ai_entitlements.sql` | `org_entitlements`（組織別の月次AI下書き上限） |

---

## 1. 全体方針
- 全テーブルに `org_id`。**RLS でテナント分離を強制**し、テナント越境ゼロを保証する。
- 認証は Supabase Auth（`auth.users`）。アプリ上の所属とロールは `memberships`（多対多）で表現。

## 2. テナント判定（未決TODOの確定）
- 方式は **「memberships 参照」方式に確定**（JWTに `org_id` を載せる方式は不採用）。
- 理由：1ユーザーが複数組織に所属でき、組織切り替えがトークン再発行なしで完結する。RLSは
  `is_org_member(org_id)` / `is_org_admin(org_id)` の **SECURITY DEFINER 関数**で判定し、
  `memberships` への RLS 再帰を回避する。

## 3. ポリシーの粒度
- **参照**：当該組織のメンバーのみ（全テーブル）。
- **一般データの書き込み**：メンバー可（contacts/tickets/messages/notes/tags/templates/ai_suggestions/events/presence/ticket_tags）。
- **管理系**：admin のみ（organizations 更新、memberships 管理、inboxes 管理）。
- **組織作成**：`create_organization()` RPC（作成者を admin 登録）。直接 insert は不可。

## 4. 主なテーブル
中核（0001）：`organizations` / `memberships` / `inboxes` / `contacts` / `tickets` / `messages` /
`notes` / `tags` / `ticket_tags` / `templates` / `ai_suggestions` / `events` / `ticket_presence`
追加：`profiles`（0003） / `invitations`（0005） / `org_entitlements`（0006） ／ ビュー `v_org_members`（0003）

要点：
- `tickets.status` は4種（unassigned/open/pending/resolved）、`replied` は内部フラグ。
- `messages` はメールヘッダ（message_id / in_reply_to / mail_references）を保持しスレッド連結。
- `events` は監査ログ（誰がいつ何を）。`log_ticket_changes` トリガで status/assign 変更を自動記録。MVPは更新/削除許可、将来禁止も検討。
- `ticket_presence` は補助。MVPの在席表示は主に Supabase Realtime Presence を使う。
- `profiles` は `auth.users` の表示用（メール/表示名）。新規ユーザー作成トリガで自動作成。`v_org_members` で組織メンバーを引く。
- `invitations` は招待リンク方式（token）。受諾は `accept_invitation()`（メール一致を確認）。
- `org_entitlements.monthly_draft_limit` でAI下書きの月次上限。AI ON/OFF は `organizations.ai_enabled`。
- メッセージ追加時に `tickets.last_message_at` をトリガで更新。inbound は未読化。

## 5. 注意点
- Edge Functions が `service_role` で動く処理（inbound webhook 等）は RLS を迂回するため、
  アプリ側で必ず `org_id` スコープを明示する（`02-architecture.md` §3）。
- 添付は本文に持たず Storage に保存し、`messages.attachments` にメタのみ（name/size/path/type）。

❓TODO: RLSポリシーの自動テスト（2組織で越境ゼロを毎フェーズ検証）を Phase 0 で用意。
