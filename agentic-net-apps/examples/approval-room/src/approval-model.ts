export type ApprovalStatus = 'pending' | 'changes-requested' | 'approved' | 'rejected';
export type ApprovalRisk = 'critical' | 'high' | 'normal' | 'low';

export interface ApprovalRequestProperties {
  kind?: string;
  requestId?: string;
  title?: string;
  summary?: string;
  status?: ApprovalStatus;
  risk?: ApprovalRisk;
  requestedBy?: string;
  requestedAt?: string;
  dueDate?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  changeNote?: string;
}

export interface ApprovalDecisionProperties {
  kind?: string;
  requestId?: string;
  decision?: 'approved' | 'rejected' | 'changes-requested';
  actor?: string;
  note?: string;
  createdAt?: string;
}

export interface ApprovalEvidenceProperties {
  kind?: string;
  requestId?: string;
  actor?: string;
  label?: string;
  url?: string;
  note?: string;
  createdAt?: string;
}

export interface TokenLike<T extends object> {
  id: string;
  name: string;
  properties: T;
}

export interface ApprovalRequestView extends TokenLike<ApprovalRequestProperties> {
  requestId: string;
  title: string;
  status: ApprovalStatus;
  risk: ApprovalRisk;
}

export interface ApprovalSubmissionAttempt {
  requestId: string;
  requestedAt: string;
}

/** Retain both values until the caller receives a definitive action response. */
export function submissionAttempt(
  existing?: ApprovalSubmissionAttempt,
  uuid: () => string = () => crypto.randomUUID(),
  now: () => string = () => new Date().toISOString(),
): ApprovalSubmissionAttempt {
  return existing || {
    requestId: `APR-${uuid().slice(0, 8).toUpperCase()}`,
    requestedAt: now(),
  };
}

const STATUSES = new Set<ApprovalStatus>(['pending', 'changes-requested', 'approved', 'rejected']);
const RISKS = new Set<ApprovalRisk>(['critical', 'high', 'normal', 'low']);

export function normalizeRequest(token: TokenLike<ApprovalRequestProperties>): ApprovalRequestView {
  const properties = token.properties || {};
  return {
    ...token,
    properties,
    requestId: properties.requestId || token.name,
    title: properties.title || 'Untitled approval',
    status: STATUSES.has(properties.status as ApprovalStatus)
      ? properties.status as ApprovalStatus : 'pending',
    risk: RISKS.has(properties.risk as ApprovalRisk)
      ? properties.risk as ApprovalRisk : 'normal',
  };
}

export function sortRequests(requests: ApprovalRequestView[]): ApprovalRequestView[] {
  const statusRank: Record<ApprovalStatus, number> = {
    pending: 0, 'changes-requested': 1, approved: 2, rejected: 3,
  };
  const riskRank: Record<ApprovalRisk, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  return [...requests].sort((a, b) => statusRank[a.status] - statusRank[b.status]
    || riskRank[a.risk] - riskRank[b.risk]
    || (b.properties.requestedAt || '').localeCompare(a.properties.requestedAt || '')
    || a.requestId.localeCompare(b.requestId));
}

export function matchesRequest(request: ApprovalRequestView, search: string, status: string): boolean {
  if (status && request.status !== status) return false;
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [request.requestId, request.title, request.properties.summary,
    request.properties.requestedBy, request.properties.decidedBy]
    .filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
}

export function isDue(request: ApprovalRequestView, today = new Date()): boolean {
  if (!request.properties.dueDate || request.status !== 'pending') return false;
  const due = new Date(`${request.properties.dueDate}T23:59:59`);
  return Number.isFinite(due.getTime()) && due.getTime() < today.getTime();
}
