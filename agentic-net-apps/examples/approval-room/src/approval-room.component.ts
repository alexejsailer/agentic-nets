import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApplicationStoreToken, NetApplicationRuntime } from '@agenticos/net-app-sdk';
import {
  ApprovalDecisionProperties, ApprovalEvidenceProperties, ApprovalRequestProperties,
  ApprovalRequestView, ApprovalRisk, ApprovalSubmissionAttempt, isDue, matchesRequest,
  normalizeRequest, sortRequests, submissionAttempt,
} from './approval-model';

interface ActionResult {
  accepted?: boolean;
  replayed?: boolean;
  effects?: Array<{ applied?: boolean; error?: string }>;
}

@Component({
  standalone: true,
  selector: 'agenticos-approval-room-source',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="approval-shell">
      <header class="topbar">
        <div class="identity">
          <span class="seal" aria-hidden="true">✓</span>
          <div><div class="eyebrow">NET-BACKED CONTROL PLANE</div><h1>Approval Room</h1>
            <p>Independent decisions with a durable, inspectable record.</p></div>
        </div>
        <div class="top-actions">
          <label><span>Acting as</span><input [(ngModel)]="actor" name="actor" placeholder="human or Persona id"></label>
          <button type="button" class="quiet" (click)="runtime?.navigate('open-underlying-net')">View net</button>
          <button type="button" class="primary" (click)="creating = true">＋ New request</button>
        </div>
      </header>

      <section class="metrics" aria-label="Approval summary">
        <div><strong>{{ pendingCount }}</strong><span>Awaiting decision</span></div>
        <div><strong>{{ changesCount }}</strong><span>Changes requested</span></div>
        <div><strong>{{ decidedToday }}</strong><span>Decided today</span></div>
        <div><strong>{{ overdueCount }}</strong><span>Past due</span></div>
        <div class="watch"><i></i><span>Watching {{ hasEvidence ? '3' : '2' }} semantic stores</span></div>
      </section>

      <section class="workspace">
        <aside class="filters">
          <div class="section-label">Queues</div>
          <button *ngFor="let queue of queues" type="button" [class.active]="statusFilter === queue.id"
                  (click)="statusFilter = queue.id">
            <span>{{ queue.icon }}</span><b>{{ queue.label }}</b><em>{{ count(queue.id) }}</em>
          </button>
          <div class="policy-card"><span>SEPARATION OF DUTY</span><strong>Enforced by the net</strong>
            <p>The identity that submitted a request cannot approve, reject, or request changes on it.</p></div>
          <button type="button" class="net-link" (click)="refresh()" [disabled]="refreshing">↻ {{ refreshing ? 'Refreshing…' : 'Refresh snapshot' }}</button>
        </aside>

        <main class="inbox">
          <div class="inbox-head">
            <div><span class="section-label">Decision inbox</span><h2>{{ queueTitle }}</h2></div>
            <label class="search">⌕ <input [(ngModel)]="search" name="search" placeholder="Search title, id, requester…"></label>
          </div>
          <p class="error" *ngIf="error"><span>{{ error }}</span><button type="button" (click)="error = ''">×</button></p>
          <div class="request-list">
            <button type="button" class="request" *ngFor="let request of visibleRequests; trackBy: trackRequest"
                    [class.selected]="selected?.requestId === request.requestId" [class.busy]="busyId === request.requestId"
                    (click)="select(request)">
              <span class="risk" [attr.data-risk]="request.risk">{{ request.risk }}</span>
              <span class="request-copy"><strong>{{ request.title }}</strong><small>{{ request.requestId }} · {{ request.properties.requestedBy || 'unknown requester' }}</small></span>
              <span class="state" [attr.data-state]="request.status">{{ stateLabel(request.status) }}</span>
              <span class="date" [class.late]="overdue(request)">{{ request.properties.dueDate || formatDate(request.properties.requestedAt) }}</span>
              <span class="chevron">›</span>
            </button>
            <div class="empty" *ngIf="!visibleRequests.length"><span>◇</span><strong>Queue clear</strong><p>No approvals match this view.</p></div>
          </div>
        </main>

        <aside class="review" *ngIf="selected as request; else noSelection">
          <header><div><span class="risk" [attr.data-risk]="request.risk">{{ request.risk }} risk</span><span class="request-id">{{ request.requestId }}</span></div>
            <button type="button" (click)="selected = undefined">×</button></header>
          <h2>{{ request.title }}</h2>
          <p class="summary">{{ request.properties.summary || 'No summary was provided.' }}</p>
          <dl>
            <div><dt>Requested by</dt><dd><span class="avatar">{{ initials(request.properties.requestedBy) }}</span>{{ request.properties.requestedBy || 'unknown' }}</dd></div>
            <div><dt>Submitted</dt><dd>{{ formatDate(request.properties.requestedAt) }}</dd></div>
            <div *ngIf="request.properties.dueDate"><dt>Decision due</dt><dd [class.late]="overdue(request)">{{ request.properties.dueDate }}</dd></div>
            <div *ngIf="request.properties.decidedBy"><dt>Decided by</dt><dd>{{ request.properties.decidedBy }}</dd></div>
          </dl>

          <section class="evidence" *ngIf="hasEvidence">
            <div class="section-title"><h3>Evidence</h3><span>{{ evidenceFor(request.requestId).length }}</span></div>
            <a *ngFor="let item of evidenceFor(request.requestId)" [href]="item.properties.url || null" target="_blank" rel="noopener">
              <span>↗</span><div><strong>{{ item.properties.label || 'Evidence' }}</strong><small>{{ item.properties.note || item.properties.url || item.properties.actor }}</small></div>
            </a>
            <div class="add-evidence" *ngIf="actionAvailable('addEvidence')">
              <input [(ngModel)]="evidenceLabel" name="evidenceLabel" placeholder="Evidence label">
              <input [(ngModel)]="evidenceUrl" name="evidenceUrl" placeholder="https://…">
              <button type="button" (click)="addEvidence(request)" [disabled]="saving || !evidenceLabel.trim()">Add</button>
            </div>
          </section>

          <section class="history">
            <div class="section-title"><h3>Decision history</h3><span>{{ decisionsFor(request.requestId).length }}</span></div>
            <div class="event" *ngFor="let decision of decisionsFor(request.requestId)">
              <i [attr.data-decision]="decision.properties.decision"></i>
              <div><strong>{{ decision.properties.actor || 'unknown' }} · {{ stateLabel(decision.properties.decision || '') }}</strong>
                <p>{{ decision.properties.note || 'No decision note.' }}</p><small>{{ formatDate(decision.properties.createdAt) }}</small></div>
            </div>
            <p class="muted" *ngIf="!decisionsFor(request.requestId).length">No decision events yet.</p>
          </section>

          <section class="decision-box" *ngIf="request.status === 'pending'">
            <label>Decision note<textarea [(ngModel)]="note" name="note" rows="4" placeholder="Record evidence and reasoning for the durable audit trail"></textarea></label>
            <p class="self-warning" *ngIf="isSelfRequest(request)">You submitted this request. The net will reject a decision by the same identity.</p>
            <div class="decision-actions">
              <button type="button" class="reject" (click)="decide(request, 'reject')" [disabled]="saving">Reject</button>
              <button type="button" *ngIf="actionAvailable('requestChanges')" (click)="decide(request, 'requestChanges')" [disabled]="saving">Request changes</button>
              <button type="button" class="approve" (click)="decide(request, 'approve')" [disabled]="saving">✓ Approve</button>
            </div>
          </section>
          <section class="decision-box" *ngIf="request.status === 'changes-requested' && actionAvailable('resubmit')">
            <label>Resolution note<textarea [(ngModel)]="note" name="resolutionNote" rows="3" placeholder="What changed?"></textarea></label>
            <button type="button" class="primary full" (click)="resubmit(request)" [disabled]="saving">Resubmit for approval</button>
          </section>
        </aside>
        <ng-template #noSelection><aside class="review empty-review"><span>✓</span><h2>Select a request</h2><p>Inspect its evidence and record an independent decision.</p></aside></ng-template>
      </section>

      <div class="scrim" *ngIf="creating" (click)="cancelCreate()"></div>
      <aside class="drawer" *ngIf="creating">
        <header><div><span class="eyebrow">NEW APPROVAL TOKEN</span><h2>Submit a decision request</h2></div><button type="button" (click)="cancelCreate()">×</button></header>
        <p>State the decision and evidence clearly enough that another human or Persona can decide independently.</p>
        <label>Title<input [(ngModel)]="draft.title" name="title" placeholder="A concise decision to make"></label>
        <label>Context and recommendation<textarea [(ngModel)]="draft.summary" name="summary" rows="6" placeholder="Scope, impact, alternatives, and recommendation"></textarea></label>
        <div class="row"><label>Risk<select [(ngModel)]="draft.risk" name="risk"><option *ngFor="let risk of risks" [value]="risk">{{ risk }}</option></select></label>
          <label>Decision due<input type="date" [(ngModel)]="draft.dueDate" name="dueDate"></label></div>
        <label>Requester identity<input [(ngModel)]="draft.requestedBy" name="requestedBy" placeholder="human or Persona id"></label>
        <div class="drawer-actions"><button type="button" class="quiet" (click)="cancelCreate()">Cancel</button>
          <button type="button" class="primary" (click)="submit()" [disabled]="saving || !draft.title.trim()">{{ saving ? 'Submitting…' : retryingSubmission ? 'Retry same submission' : 'Submit request' }}</button></div>
      </aside>
    </section>
  `,
  styles: [`
    :host{display:block;min-width:0;container-type:inline-size;color:var(--fg,#e9eef5);font-family:var(--sans,Inter,system-ui,sans-serif);--ar-bg:var(--bg,#090d12);--ar-panel:var(--panel,#111820);--ar-card:var(--card,#171f29);--ar-edge:var(--edge,#293441);--ar-muted:var(--muted,#8e9baa);--ar-blue:#61a8ff;--ar-green:#41c796;--ar-red:#ef6a73;--ar-amber:#e4ad55}
    *{box-sizing:border-box}button,input,textarea,select{font:inherit}.approval-shell{position:relative;min-height:720px;border:1px solid var(--ar-edge);border-radius:16px;overflow:hidden;background:radial-gradient(circle at 82% -15%,rgba(97,168,255,.13),transparent 32%),var(--ar-bg)}
    .topbar{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:22px 25px;border-bottom:1px solid var(--ar-edge)}.identity{display:flex;align-items:center;gap:14px}.seal{display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(97,168,255,.4);border-radius:50%;background:rgba(97,168,255,.1);color:var(--ar-blue);font-size:20px}.eyebrow,.section-label{font:700 10px/1.2 var(--mono,monospace);letter-spacing:.12em;color:var(--ar-blue)}h1{margin:3px 0 1px;font-size:24px;letter-spacing:-.03em}.identity p{margin:0;color:var(--ar-muted);font-size:12px}.top-actions{display:flex;align-items:end;gap:9px}.top-actions label{display:grid;gap:4px}.top-actions label span{font:600 9px var(--mono,monospace);text-transform:uppercase;color:var(--ar-muted)}
    button{border:1px solid var(--ar-edge);border-radius:8px;background:var(--ar-card);color:inherit;padding:9px 12px;cursor:pointer}button:hover{border-color:#596a7d}button:disabled{opacity:.48;cursor:default}.primary{border-color:transparent;background:#397fd3;color:white}.quiet{background:transparent}input,textarea,select{width:100%;border:1px solid var(--ar-edge);border-radius:8px;background:var(--ar-panel);color:inherit;padding:9px 10px;outline:none}input:focus,textarea:focus,select:focus{border-color:var(--ar-blue);box-shadow:0 0 0 2px rgba(97,168,255,.12)}
    .metrics{display:flex;align-items:stretch;border-bottom:1px solid var(--ar-edge);background:rgba(17,24,32,.72)}.metrics>div{display:grid;grid-template-columns:auto auto;align-items:baseline;column-gap:7px;padding:12px 20px;border-right:1px solid var(--ar-edge)}.metrics strong{font:700 17px var(--mono,monospace)}.metrics span{font-size:10px;color:var(--ar-muted)}.metrics .watch{display:flex;align-items:center;gap:8px;margin-left:auto;border:0}.watch i{width:7px;height:7px;border-radius:50%;background:var(--ar-green);box-shadow:0 0 0 4px rgba(65,199,150,.1)}
    .workspace{display:grid;grid-template-columns:190px minmax(340px,1fr) minmax(330px,420px);min-height:605px}.filters{padding:20px 13px;border-right:1px solid var(--ar-edge);background:rgba(13,19,26,.7)}.filters>.section-label{display:block;padding:0 9px 10px;color:var(--ar-muted)}.filters>button{display:grid;grid-template-columns:20px 1fr auto;width:100%;gap:8px;align-items:center;margin:2px 0;border-color:transparent;background:transparent;text-align:left}.filters>button b{font-size:12px}.filters>button em{font:normal 11px var(--mono,monospace);color:var(--ar-muted)}.filters>button.active{background:rgba(97,168,255,.12);color:#b9d9ff}.policy-card{margin:22px 4px 12px;padding:13px;border:1px solid rgba(65,199,150,.28);border-radius:10px;background:rgba(65,199,150,.06)}.policy-card span{font:700 9px var(--mono,monospace);letter-spacing:.08em;color:var(--ar-green)}.policy-card strong{display:block;margin:6px 0;font-size:12px}.policy-card p{margin:0;color:var(--ar-muted);font-size:10px;line-height:1.5}.filters .net-link{display:block;border-color:var(--ar-edge);text-align:center;color:var(--ar-muted)}
    .inbox{min-width:0;border-right:1px solid var(--ar-edge)}.inbox-head{display:flex;justify-content:space-between;align-items:end;gap:15px;padding:18px;border-bottom:1px solid var(--ar-edge)}.inbox-head h2{margin:4px 0 0;font-size:18px}.search{display:flex;align-items:center;gap:7px;width:min(230px,48%);padding-left:9px;border:1px solid var(--ar-edge);border-radius:8px;background:var(--ar-panel);color:var(--ar-muted)}.search input{border:0;background:transparent;box-shadow:none;padding-left:0}.error{display:flex;justify-content:space-between;align-items:center;margin:12px;padding:9px 10px;border:1px solid rgba(239,106,115,.35);border-radius:8px;background:rgba(239,106,115,.1);color:#ffb5ba;font-size:11px}.error button{padding:2px 6px;background:transparent}.request-list{padding:8px}.request{display:grid;grid-template-columns:68px minmax(130px,1fr) auto 76px 12px;align-items:center;gap:10px;width:100%;padding:13px 11px;margin-bottom:5px;background:transparent;border-color:transparent;text-align:left}.request:hover,.request.selected{background:var(--ar-panel);border-color:var(--ar-edge)}.request.selected{box-shadow:inset 2px 0 var(--ar-blue)}.request.busy{opacity:.6}.risk{width:max-content;padding:3px 6px;border-radius:4px;font:700 9px var(--mono,monospace);text-transform:uppercase;background:rgba(97,168,255,.1);color:#a9d1ff}.risk[data-risk=critical]{background:rgba(239,106,115,.13);color:#ff9ba2}.risk[data-risk=high]{background:rgba(228,173,85,.13);color:#f1c578}.request-copy{display:grid;gap:4px;min-width:0}.request-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.request-copy small,.date{font-size:10px;color:var(--ar-muted)}.state{padding:3px 6px;border-radius:10px;font-size:9px;background:rgba(228,173,85,.12);color:#edc078}.state[data-state=approved]{background:rgba(65,199,150,.12);color:#7bdeb9}.state[data-state=rejected]{background:rgba(239,106,115,.12);color:#ff9da4}.date.late,.late{color:#ff8992!important}.chevron{color:var(--ar-muted);font-size:20px}.empty{display:grid;place-items:center;padding:70px 20px;color:var(--ar-muted)}.empty span{font-size:30px}.empty strong{margin-top:9px;color:inherit}.empty p{font-size:11px}
    .review{padding:18px;overflow:auto;background:rgba(14,20,27,.7)}.review>header{display:flex;justify-content:space-between}.review>header>div{display:flex;gap:8px;align-items:center}.review>header button{padding:3px 8px;background:transparent}.request-id{font:600 10px var(--mono,monospace);color:var(--ar-muted)}.review>h2{margin:17px 0 8px;font-size:21px}.summary{color:#b8c2ce;font-size:12px;line-height:1.65;white-space:pre-wrap}.review dl{margin:18px 0;border-top:1px solid var(--ar-edge)}.review dl div{display:grid;grid-template-columns:100px 1fr;align-items:center;padding:9px 0;border-bottom:1px solid var(--ar-edge)}dt{font-size:10px;color:var(--ar-muted)}dd{display:flex;align-items:center;gap:7px;margin:0;font-size:11px}.avatar{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;background:#30465f;color:#cfe5ff;font:700 8px var(--mono,monospace)}.section-title{display:flex;align-items:center;gap:7px;margin:17px 0 8px}.section-title h3{margin:0;font-size:12px}.section-title span{padding:1px 5px;border-radius:8px;background:var(--ar-edge);font-size:9px}.evidence a{display:flex;gap:8px;padding:9px;margin-bottom:5px;border:1px solid var(--ar-edge);border-radius:7px;color:inherit;text-decoration:none}.evidence a>span{color:var(--ar-blue)}.evidence a div{display:grid;gap:2px}.evidence a strong{font-size:10px}.evidence a small{font-size:9px;color:var(--ar-muted)}.add-evidence{display:grid;grid-template-columns:1fr 1fr auto;gap:5px}.add-evidence input,.add-evidence button{padding:7px;font-size:9px}.event{display:grid;grid-template-columns:12px 1fr;gap:8px;padding:8px 0}.event i{width:7px;height:7px;margin-top:4px;border-radius:50%;background:var(--ar-amber)}.event i[data-decision=approved]{background:var(--ar-green)}.event i[data-decision=rejected]{background:var(--ar-red)}.event strong{font-size:10px}.event p{margin:3px 0;color:#b8c2ce;font-size:10px}.event small,.muted{color:var(--ar-muted);font-size:9px}.decision-box{margin-top:18px;padding-top:15px;border-top:1px solid var(--ar-edge)}.decision-box label{display:grid;gap:6px;font-size:10px;color:var(--ar-muted)}.decision-actions{display:grid;grid-template-columns:auto 1fr auto;gap:6px;margin-top:8px}.decision-actions button{font-size:10px}.approve{border-color:transparent;background:#238762;color:white}.reject{color:#ff9da4}.self-warning{padding:7px;border-radius:6px;background:rgba(239,106,115,.09);color:#ffadb3;font-size:9px}.full{width:100%;margin-top:8px}.empty-review{display:grid;place-content:center;text-align:center;color:var(--ar-muted)}.empty-review>span{font-size:36px;color:#32485e}.empty-review h2{color:#acb6c2}
    .scrim{position:absolute;inset:0;z-index:5;background:rgba(0,0,0,.58)}.drawer{position:absolute;z-index:6;top:0;right:0;width:min(480px,100%);height:100%;padding:24px;background:var(--ar-panel);box-shadow:-18px 0 45px rgba(0,0,0,.35);overflow:auto}.drawer header{display:flex;justify-content:space-between}.drawer header h2{margin:5px 0 0}.drawer header button{padding:3px 8px;background:transparent}.drawer>p{margin:18px 0;color:var(--ar-muted);font-size:11px;line-height:1.6}.drawer>label,.row label{display:grid;gap:6px;margin:13px 0;font-size:10px;color:var(--ar-muted)}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.drawer-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
    @container(max-width:950px){.workspace{grid-template-columns:150px minmax(0,1fr)}.review{grid-column:1/-1;border-top:1px solid var(--ar-edge)}.top-actions label{display:none}.metrics>div{padding:10px}.metrics .watch{display:none}}@container(max-width:650px){.topbar{align-items:flex-start}.identity p,.quiet{display:none}.workspace{display:block}.filters{display:flex;overflow:auto;border-right:0}.filters>.section-label,.policy-card,.filters .net-link{display:none}.filters>button{min-width:max-content}.request{grid-template-columns:55px minmax(0,1fr) auto}.request .date,.chevron{display:none}.metrics>div:nth-child(n+4){display:none}.add-evidence{grid-template-columns:1fr}}
  `],
})
export class ApprovalRoomComponent implements OnDestroy {
  readonly queues = [
    { id: '', label: 'All requests', icon: '◫' },
    { id: 'pending', label: 'Awaiting me', icon: '◇' },
    { id: 'changes-requested', label: 'Needs changes', icon: '↺' },
    { id: 'approved', label: 'Approved', icon: '✓' },
    { id: 'rejected', label: 'Rejected', icon: '×' },
  ];
  readonly risks: ApprovalRisk[] = ['critical', 'high', 'normal', 'low'];
  requests: ApprovalRequestView[] = [];
  decisions: Array<ApplicationStoreToken<ApprovalDecisionProperties>> = [];
  evidence: Array<ApplicationStoreToken<ApprovalEvidenceProperties>> = [];
  actor = 'human-reviewer';
  search = '';
  statusFilter = 'pending';
  selected?: ApprovalRequestView;
  note = '';
  evidenceLabel = '';
  evidenceUrl = '';
  error = '';
  refreshing = false;
  saving = false;
  busyId = '';
  creating = false;
  hasEvidence = false;
  availableActions = new Set<string>();
  draft = this.emptyDraft();
  private runtimeValue?: NetApplicationRuntime;
  private submitAttempt?: ApprovalSubmissionAttempt;
  private submitInput?: Record<string, unknown>;
  private readonly stopWatching: Array<() => void> = [];
  private readonly retryKeys = new Map<string, string>();

  @Input()
  set runtime(value: NetApplicationRuntime | undefined) {
    this.stopAllWatching();
    this.runtimeValue = value;
    if (value) void this.connect(value);
  }
  get runtime(): NetApplicationRuntime | undefined { return this.runtimeValue; }

  constructor(private readonly cdr: ChangeDetectorRef) {}
  ngOnDestroy(): void { this.stopAllWatching(); }

  get visibleRequests(): ApprovalRequestView[] {
    return this.requests.filter(request => matchesRequest(request, this.search, this.statusFilter));
  }
  get queueTitle(): string { return this.queues.find(queue => queue.id === this.statusFilter)?.label || 'All requests'; }
  get pendingCount(): number { return this.count('pending'); }
  get changesCount(): number { return this.count('changes-requested'); }
  get overdueCount(): number { return this.requests.filter(item => isDue(item)).length; }
  get decidedToday(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.decisions.filter(item => (item.properties.createdAt || '').startsWith(today)).length;
  }
  get retryingSubmission(): boolean { return !!this.submitInput; }

  count(status: string): number { return status ? this.requests.filter(item => item.status === status).length : this.requests.length; }
  actionAvailable(name: string): boolean { return this.availableActions.has(name); }
  overdue(request: ApprovalRequestView): boolean { return isDue(request); }
  trackRequest(_: number, request: ApprovalRequestView): string { return request.id; }
  select(request: ApprovalRequestView): void { this.selected = request; this.note = ''; }
  initials(value?: string): string {
    return value?.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?';
  }
  stateLabel(value: string): string {
    return ({ pending: 'Awaiting decision', 'changes-requested': 'Changes requested', approved: 'Approved', rejected: 'Rejected' } as Record<string, string>)[value] || value;
  }
  formatDate(value?: string): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : value;
  }
  decisionsFor(requestId: string): Array<ApplicationStoreToken<ApprovalDecisionProperties>> {
    return this.decisions.filter(item => item.properties.requestId === requestId);
  }
  evidenceFor(requestId: string): Array<ApplicationStoreToken<ApprovalEvidenceProperties>> {
    return this.evidence.filter(item => item.properties.requestId === requestId);
  }
  isSelfRequest(request: ApprovalRequestView): boolean {
    return !!this.actor.trim() && this.actor.trim() === request.properties.requestedBy;
  }

  async refresh(): Promise<void> {
    if (!this.runtime) return;
    this.refreshing = true; this.cdr.markForCheck();
    try {
      const reads: Array<Promise<unknown>> = [
        this.runtime.readStore<ApprovalRequestProperties>('requests').then(tokens => { this.requests = sortRequests(tokens.map(normalizeRequest)); }),
        this.runtime.readStore<ApprovalDecisionProperties>('decisions').then(tokens => { this.decisions = this.sortEvents(tokens); }),
      ];
      if (this.hasEvidence) reads.push(this.runtime.readStore<ApprovalEvidenceProperties>('evidence').then(tokens => { this.evidence = this.sortEvents(tokens); }));
      await Promise.all(reads); this.reselect();
    } catch (error: unknown) { this.showError(error); }
    finally { this.refreshing = false; this.cdr.markForCheck(); }
  }

  async submit(): Promise<void> {
    if (!this.draft.title.trim()) return;
    this.submitAttempt = submissionAttempt(this.submitAttempt);
    const { requestId, requestedAt } = this.submitAttempt;
    this.submitInput ||= {
      requestId, title: this.draft.title.trim(), summary: this.draft.summary.trim(), risk: this.draft.risk,
      dueDate: this.draft.dueDate, requestedBy: this.draft.requestedBy.trim() || this.currentActor(), requestedAt,
    };
    const succeeded = await this.run(requestId, 'submitRequest', this.submitInput);
    if (succeeded) {
      this.creating = false; this.draft = this.emptyDraft();
      this.submitAttempt = undefined; this.submitInput = undefined;
    }
  }

  async decide(request: ApprovalRequestView, action: 'approve' | 'reject' | 'requestChanges'): Promise<void> {
    const defaults = action === 'approve' ? 'Reviewed and approved.' : action === 'reject' ? 'Rejected after review.' : 'Changes are required before approval.';
    const succeeded = await this.run(request.requestId, action, {
      requestId: request.requestId, actor: this.currentActor(), note: this.note.trim() || defaults,
    });
    if (succeeded) this.note = '';
  }

  async resubmit(request: ApprovalRequestView): Promise<void> {
    const succeeded = await this.run(request.requestId, 'resubmit', {
      requestId: request.requestId, actor: this.currentActor(), note: this.note.trim() || 'Requested changes have been addressed.',
    });
    if (succeeded) this.note = '';
  }

  async addEvidence(request: ApprovalRequestView): Promise<void> {
    if (!this.evidenceLabel.trim()) return;
    const succeeded = await this.run(request.requestId, 'addEvidence', {
      requestId: request.requestId, actor: this.currentActor(), label: this.evidenceLabel.trim(),
      url: this.evidenceUrl.trim(), note: '',
    });
    if (succeeded) { this.evidenceLabel = ''; this.evidenceUrl = ''; }
  }

  private async connect(runtime: NetApplicationRuntime): Promise<void> {
    try {
      const descriptor = await runtime.describe();
      if (this.runtimeValue !== runtime) return;
      this.availableActions = new Set(descriptor.actions.map(action => action.name));
      this.hasEvidence = descriptor.stores.some(store => store.role === 'evidence');
      this.stopWatching.push(runtime.watchStore<ApprovalRequestProperties>('requests', event => {
        this.requests = sortRequests(event.tokens.map(normalizeRequest)); this.reselect(); this.cdr.markForCheck();
      }, 2000));
      this.stopWatching.push(runtime.watchStore<ApprovalDecisionProperties>('decisions', event => {
        this.decisions = this.sortEvents(event.tokens); this.cdr.markForCheck();
      }, 2000));
      if (this.hasEvidence) this.stopWatching.push(runtime.watchStore<ApprovalEvidenceProperties>('evidence', event => {
        this.evidence = this.sortEvents(event.tokens); this.cdr.markForCheck();
      }, 2000));
      await this.refresh();
    } catch (error: unknown) { this.showError(error); this.cdr.markForCheck(); }
  }

  cancelCreate(): void {
    this.creating = false;
    this.draft = this.emptyDraft();
    this.submitAttempt = undefined;
    this.submitInput = undefined;
  }

  private async run(requestId: string, action: string, input: Record<string, unknown>): Promise<boolean> {
    if (!this.runtime) return false;
    const fingerprint = `${action}:${JSON.stringify(input)}`;
    const idempotencyKey = this.retryKeys.get(fingerprint) || crypto.randomUUID();
    this.retryKeys.set(fingerprint, idempotencyKey);
    this.error = ''; this.saving = true; this.busyId = requestId; this.cdr.markForCheck();
    try {
      const result = await this.runtime.invoke<ActionResult>(action, input, { idempotencyKey });
      const failed = result.effects?.find(effect => effect.applied === false && effect.error);
      if (failed?.error) throw new Error(failed.error);
      this.retryKeys.delete(fingerprint);
      await this.refresh();
      return true;
    } catch (error: unknown) { this.showError(error); return false; }
    finally { this.saving = false; this.busyId = ''; this.cdr.markForCheck(); }
  }

  private currentActor(): string { return this.actor.trim() || 'human-reviewer'; }
  private emptyDraft(): { title: string; summary: string; risk: ApprovalRisk; dueDate: string; requestedBy: string } {
    return { title: '', summary: '', risk: 'normal', dueDate: '', requestedBy: this.actor || 'human-requester' };
  }
  private reselect(): void {
    if (!this.selected) return;
    this.selected = this.requests.find(item => item.requestId === this.selected?.requestId);
  }
  private sortEvents<T extends { createdAt?: string }>(tokens: Array<ApplicationStoreToken<T>>): Array<ApplicationStoreToken<T>> {
    return [...tokens].sort((a, b) => (b.properties.createdAt || '').localeCompare(a.properties.createdAt || ''));
  }
  private stopAllWatching(): void { this.stopWatching.splice(0).forEach(stop => stop()); }
  private showError(error: unknown): void {
    this.error = error instanceof Error ? error.message : 'The approval action could not be completed.';
  }
}
