import type { CSSProperties } from 'react';
import type { TicketStatus } from '@metasuke/shared';

export const card: CSSProperties = {
  border: '1px solid #e3e3e3',
  borderRadius: 10,
  padding: 16,
  marginBottom: 16,
  background: '#fff',
};
export const h2: CSSProperties = { fontSize: 16, marginTop: 0 };
export const input: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 10px',
  marginBottom: 8,
  border: '1px solid #ccc',
  borderRadius: 6,
  boxSizing: 'border-box',
};
export const button: CSSProperties = {
  padding: '8px 14px',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
export const buttonGhost: CSSProperties = {
  padding: '8px 14px',
  background: '#fff',
  color: '#2563eb',
  border: '1px solid #2563eb',
  borderRadius: 6,
  cursor: 'pointer',
};

export const statusColor: Record<TicketStatus, string> = {
  unassigned: '#dc2626',
  open: '#2563eb',
  pending: '#d97706',
  resolved: '#16a34a',
};

export function statusBadge(status: TicketStatus): CSSProperties {
  return {
    fontSize: 12,
    padding: '2px 8px',
    borderRadius: 999,
    color: '#fff',
    background: statusColor[status],
    whiteSpace: 'nowrap',
  };
}
