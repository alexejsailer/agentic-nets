export type KanbanStatus = 'backlog' | 'ready' | 'in-progress' | 'review' | 'done';
export type KanbanPriority = 'urgent' | 'high' | 'normal' | 'low';

export interface KanbanCardProperties {
  kind?: string;
  taskId?: string;
  title?: string;
  description?: string;
  status?: KanbanStatus | 'archived';
  priority?: KanbanPriority;
  assignee?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  dueDate?: string;
  labels?: string | string[];
  acceptanceCriteria?: string | string[];
  blockedReason?: string;
  result?: string;
  reviewer?: string;
  archived?: string | boolean;
}

export interface KanbanActivityProperties {
  kind?: string;
  taskId?: string;
  event?: string;
  actor?: string;
  assignee?: string;
  reviewer?: string;
  note?: string;
  status?: string;
  createdAt?: string;
  action?: string;
}

export interface TokenLike<T extends object> {
  id: string;
  name: string;
  properties: T;
}

export interface KanbanCardView extends TokenLike<KanbanCardProperties> {
  taskId: string;
  title: string;
  status: KanbanStatus;
  priority: KanbanPriority;
  labels: string[];
  acceptanceCriteria: string[];
  archived: boolean;
}

export const BOARD_LANES: ReadonlyArray<{ id: KanbanStatus; label: string; hint: string }> = [
  { id: 'backlog', label: 'Backlog', hint: 'Ideas and unscheduled work' },
  { id: 'ready', label: 'Ready', hint: 'Actionable and claimable' },
  { id: 'in-progress', label: 'In progress', hint: 'Owned by a worker' },
  { id: 'review', label: 'Review', hint: 'Waiting for a verdict' },
  { id: 'done', label: 'Done', hint: 'Accepted outcomes' },
];

const STATUSES = new Set<KanbanStatus>(BOARD_LANES.map(lane => lane.id));
const PRIORITIES = new Set<KanbanPriority>(['urgent', 'high', 'normal', 'low']);

export function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  const raw = value.trim();
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).map(item => item.trim()).filter(Boolean);
    } catch { /* Fall through to comma/newline parsing. */ }
  }
  // Older effect writes used Java List.toString(), yielding `[one, two]` rather than JSON.
  // Accept it defensively while current runtimes persist structured values as JSON.
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return unwrapped.split(/[,\n]/)
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

export function normalizeCard(token: TokenLike<KanbanCardProperties>): KanbanCardView {
  const properties = token.properties || {};
  const status = properties.status && STATUSES.has(properties.status as KanbanStatus)
    ? properties.status as KanbanStatus : 'backlog';
  const priority = properties.priority && PRIORITIES.has(properties.priority)
    ? properties.priority : 'normal';
  return {
    ...token,
    properties,
    taskId: properties.taskId || token.name,
    title: properties.title || 'Untitled task',
    status,
    priority,
    labels: parseStringList(properties.labels),
    acceptanceCriteria: parseStringList(properties.acceptanceCriteria),
    archived: properties.status === 'archived' || properties.archived === true
      || properties.archived === 'true',
  };
}

export function sortCards(cards: KanbanCardView[]): KanbanCardView[] {
  const priorityRank: Record<KanbanPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...cards].sort((a, b) => {
    const byPriority = priorityRank[a.priority] - priorityRank[b.priority];
    if (byPriority) return byPriority;
    const aDate = a.properties.updatedAt || a.properties.createdAt || '';
    const bDate = b.properties.updatedAt || b.properties.createdAt || '';
    return bDate.localeCompare(aDate) || a.taskId.localeCompare(b.taskId);
  });
}

export function matchesCard(card: KanbanCardView, search: string, assignee: string): boolean {
  if (assignee && (card.properties.assignee || '') !== assignee) return false;
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [card.taskId, card.title, card.properties.description, card.properties.assignee,
    card.properties.createdBy, ...card.labels]
    .filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
}

export function isOverdue(card: KanbanCardView, today = new Date()): boolean {
  if (!card.properties.dueDate || card.status === 'done') return false;
  const due = new Date(`${card.properties.dueDate}T23:59:59`);
  return Number.isFinite(due.getTime()) && due.getTime() < today.getTime();
}
