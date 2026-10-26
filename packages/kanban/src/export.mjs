// dsh-kanban: raw exports. Pure functions over rows the store already returns,
// so the HTTP surface and the tests share one serializer.

export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label ?? c.key)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(typeof c.get === 'function' ? c.get(row) : row[c.key])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

export function toJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

export const TICKET_COLUMNS = [
  { key: 'key', label: 'key' },
  { key: 'title', label: 'title' },
  { key: 'column', label: 'column' },
  { key: 'phase', label: 'phase' },
  { key: 'attemptCount', label: 'attempts' },
  { key: 'spentUsd', label: 'spent_usd' },
  { key: 'budgetUsd', label: 'budget_usd' },
  { key: 'createdAt', label: 'created_at' },
  { key: 'closedAt', label: 'closed_at' },
];

export const SPAN_COLUMNS = [
  { key: 'id', label: 'span_id' },
  { key: 'ticketId', label: 'ticket_id' },
  { key: 'runId', label: 'run_id' },
  { key: 'parentSpanId', label: 'parent_span_id' },
  { key: 'kind', label: 'kind' },
  { key: 'name', label: 'name' },
  { key: 'role', label: 'role' },
  { key: 'provider', label: 'provider' },
  { key: 'model', label: 'model' },
  { key: 'startedAt', label: 'started_at' },
  { key: 'endedAt', label: 'ended_at' },
  { key: 'durationMs', label: 'duration_ms' },
  { key: 'status', label: 'status' },
  { key: 'attempt', label: 'attempt' },
  { key: 'error', label: 'error' },
];

export const USAGE_COLUMNS = [
  { key: 'ticketId', label: 'ticket_id' },
  { key: 'spanId', label: 'span_id' },
  { key: 'role', label: 'role' },
  { key: 'provider', label: 'provider' },
  { key: 'model', label: 'model' },
  { key: 'inputTokens', label: 'input_tokens' },
  { key: 'outputTokens', label: 'output_tokens' },
  { key: 'cacheReadTokens', label: 'cache_read_tokens' },
  { key: 'cacheWriteTokens', label: 'cache_write_tokens' },
  { key: 'costUsd', label: 'cost_usd' },
  { key: 'priceVersion', label: 'price_version' },
];

/** Flat usage rows for one ticket, ready for CSV/JSONL. */
export function usageRows(ticket, rows) {
  return rows.map((row) => ({ ticketId: ticket.id, key: ticket.key, ...row }));
}
