// metasuke 共有ドメイン型。DBスキーマ(supabase/migrations/0001_init.sql)と対応させる。
// フロント(apps/web)と Edge Functions(supabase/functions) の両方から参照する。

export type UUID = string;
export type ISODateTime = string;

// --- 列挙型（SQLの enum と一致させる） ---
export type MembershipRole = 'admin' | 'member';
export type TicketStatus = 'unassigned' | 'open' | 'pending' | 'resolved';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageChannel = 'email' | 'form';
export type AISuggestionType = 'draft' | 'summary' | 'classification';
export type PresenceKind = 'viewing' | 'editing';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'unassigned',
  'open',
  'pending',
  'resolved',
] as const;

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  unassigned: '未対応',
  open: '対応中',
  pending: '保留',
  resolved: '対応済',
};

// --- エンティティ ---
export interface Organization {
  id: UUID;
  name: string;
  plan: string;
  ai_enabled: boolean;
  created_at: ISODateTime;
}

export interface Membership {
  id: UUID;
  org_id: UUID;
  user_id: UUID;
  role: MembershipRole;
  status: string;
  created_at: ISODateTime;
}

export interface Inbox {
  id: UUID;
  org_id: UUID;
  name: string;
  inbound_address: string;
  from_domain: string | null;
  signature: string | null;
  dkim_verified: boolean;
  created_at: ISODateTime;
}

export interface Contact {
  id: UUID;
  org_id: UUID;
  email: string;
  name: string | null;
  company: string | null;
  meta: Record<string, unknown>;
  created_at: ISODateTime;
}

export interface Ticket {
  id: UUID;
  org_id: UUID;
  inbox_id: UUID;
  contact_id: UUID;
  assignee_id: UUID | null;
  subject: string | null;
  status: TicketStatus;
  replied: boolean;
  is_read: boolean;
  priority: number | null;
  thread_key: string | null;
  last_message_at: ISODateTime | null;
  created_at: ISODateTime;
  closed_at: ISODateTime | null;
}

export interface MessageAttachment {
  name: string;
  size: number;
  storage_path: string;
  content_type: string;
}

export interface Message {
  id: UUID;
  org_id: UUID;
  ticket_id: UUID;
  direction: MessageDirection;
  channel: MessageChannel;
  from_addr: string | null;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  mail_references: string[];
  attachments: MessageAttachment[];
  sent_by: UUID | null;
  created_at: ISODateTime;
}

export interface AISuggestion {
  id: UUID;
  org_id: UUID;
  ticket_id: UUID;
  type: AISuggestionType;
  input_hash: string | null;
  output: unknown;
  model: string | null;
  accepted: boolean | null;
  created_at: ISODateTime;
}
