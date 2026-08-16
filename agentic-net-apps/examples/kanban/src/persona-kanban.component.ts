import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApplicationStoreToken, NetApplicationRuntime } from '@agenticos/net-app-sdk';
import {
  BOARD_LANES, KanbanActivityProperties, KanbanCardProperties, KanbanCardView,
  KanbanPriority, KanbanStatus, isOverdue, matchesCard, normalizeCard, parseStringList, sortCards,
} from './kanban-model';

interface ActionResult {
  accepted?: boolean;
  effects?: Array<{ applied?: boolean; error?: string }>;
}

interface TaskEditor {
  title: string;
  description: string;
  priority: KanbanPriority;
  assignee: string;
  labels: string;
  acceptanceCriteria: string;
  dueDate: string;
  blockedReason: string;
}

@Component({
  standalone: true,
  selector: 'agenticos-persona-kanban-source',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="kanban-shell">
      <header class="hero">
        <div class="identity">
          <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <div>
            <div class="eyebrow">NET-BACKED WORKSPACE · HUMAN + PERSONA</div>
            <h1>Persona Kanban</h1>
            <p>One observable task system for people and autonomous workers.</p>
          </div>
        </div>
        <div class="hero-actions">
          <button type="button" class="quiet" (click)="runtime?.navigate('open-underlying-net')">View net</button>
          <button type="button" class="primary" (click)="openCreate()"><span>＋</span> Create work</button>
        </div>
      </header>

      <section class="stats" aria-label="Board summary">
        <div><strong>{{ activeCount }}</strong><span>Active tasks</span></div>
        <div><strong>{{ readyCount }}</strong><span>Ready for agents</span></div>
        <div><strong>{{ ownedCount }}</strong><span>In progress</span></div>
        <div><strong>{{ overdueCount }}</strong><span>Overdue</span></div>
        <div class="agent-status"><b></b><span>Net watch active</span></div>
      </section>

      <section class="toolbar">
        <label class="search"><span>⌕</span><input [(ngModel)]="search" name="search" placeholder="Search tasks, ids, labels, personas…"></label>
        <label><span>Assignee</span><select [(ngModel)]="assigneeFilter" name="assigneeFilter">
          <option value="">Everyone</option>
          <option *ngFor="let person of assignees" [value]="person">{{ person }}</option>
        </select></label>
        <label class="actor"><span>Acting as</span><input [(ngModel)]="actor" name="actor" placeholder="human or Persona id"></label>
        <button type="button" class="icon-button" title="Refresh from net" (click)="refresh()" [disabled]="refreshing">↻</button>
      </section>

      <p class="error-banner" *ngIf="error"><span>{{ error }}</span><button type="button" (click)="error = ''">Dismiss</button></p>

      <div class="board" aria-label="Kanban board">
        <section class="lane" *ngFor="let lane of lanes" [attr.data-status]="lane.id"
                 (dragover)="allowDrop($event)" (drop)="drop($event, lane.id)">
          <header>
            <div><span class="lane-dot"></span><h2>{{ lane.label }}</h2><b>{{ cardsFor(lane.id).length }}</b></div>
            <small>{{ lane.hint }}</small>
          </header>
          <div class="lane-body">
            <article class="task-card" *ngFor="let card of cardsFor(lane.id); trackBy: trackCard"
                     [class.overdue]="overdue(card)" [class.busy]="busyTaskId === card.taskId"
                     draggable="true" (dragstart)="startDrag($event, card)" (click)="select(card)">
              <div class="card-top">
                <span class="priority" [attr.data-priority]="card.priority">{{ card.priority }}</span>
                <span class="task-id">{{ card.taskId }}</span>
                <button type="button" class="more" aria-label="Open task details" (click)="select(card); $event.stopPropagation()">•••</button>
              </div>
              <h3>{{ card.title }}</h3>
              <p *ngIf="card.properties.description">{{ card.properties.description }}</p>
              <div class="labels" *ngIf="card.labels.length">
                <span *ngFor="let label of card.labels">{{ label }}</span>
              </div>
              <div class="blocked" *ngIf="card.properties.blockedReason"><span>!</span>{{ card.properties.blockedReason }}</div>
              <footer>
                <span class="avatar" [class.unassigned]="!card.properties.assignee">{{ initials(card.properties.assignee) }}</span>
                <span class="owner">{{ card.properties.assignee || 'Unassigned' }}</span>
                <span class="due" *ngIf="card.properties.dueDate" [class.late]="overdue(card)">◷ {{ card.properties.dueDate }}</span>
                <span class="comments" *ngIf="activityCount(card.taskId)">◌ {{ activityCount(card.taskId) }}</span>
              </footer>
            </article>
            <button type="button" class="lane-add" *ngIf="lane.id === 'backlog' || lane.id === 'ready'"
                    (click)="openCreate(lane.id)">＋ Add {{ lane.id === 'ready' ? 'ready work' : 'task' }}</button>
            <div class="empty-lane" *ngIf="!cardsFor(lane.id).length"><span>◇</span>No work here</div>
          </div>
        </section>
      </div>

      <div class="scrim" *ngIf="creating || selected" (click)="closePanels()"></div>

      <aside class="drawer create-drawer" *ngIf="creating" aria-label="Create task">
        <div class="drawer-head"><div><span class="eyebrow">NEW NET TOKEN</span><h2>Create work</h2></div><button type="button" (click)="closePanels()">×</button></div>
        <p class="drawer-intro">Define the outcome clearly enough that a Persona can claim it without another conversation.</p>
        <label>Title<input [(ngModel)]="newTask.title" name="newTitle" placeholder="A concrete, outcome-focused title"></label>
        <label>Description<textarea [(ngModel)]="newTask.description" name="newDescription" rows="5" placeholder="Context, constraints, and what needs to change"></textarea></label>
        <div class="form-row">
          <label>Status<select [(ngModel)]="newStatus" name="newStatus"><option value="backlog">Backlog</option><option value="ready">Ready</option></select></label>
          <label>Priority<select [(ngModel)]="newTask.priority" name="newPriority"><option *ngFor="let priority of priorities" [value]="priority">{{ priority }}</option></select></label>
        </div>
        <label>Assignee<input [(ngModel)]="newTask.assignee" name="newAssignee" placeholder="Optional Persona id"></label>
        <label>Labels<input [(ngModel)]="newTask.labels" name="newLabels" placeholder="frontend, docs, urgent"></label>
        <label>Acceptance criteria<textarea [(ngModel)]="newTask.acceptanceCriteria" name="newCriteria" rows="4" placeholder="One verifiable criterion per line"></textarea></label>
        <label>Due date<input type="date" [(ngModel)]="newTask.dueDate" name="newDueDate"></label>
        <div class="drawer-actions"><button type="button" class="quiet" (click)="closePanels()">Cancel</button><button type="button" class="primary" (click)="createTask()" [disabled]="saving || !newTask.title.trim()">{{ saving ? 'Creating…' : 'Create task' }}</button></div>
      </aside>

      <aside class="drawer detail-drawer" *ngIf="selected as card" aria-label="Task details">
        <div class="drawer-head"><div><span class="eyebrow">{{ card.taskId }} · {{ card.status }}</span><h2>{{ card.title }}</h2></div><button type="button" (click)="closePanels()">×</button></div>
        <div class="task-actions">
          <button type="button" *ngIf="card.status === 'backlog'" (click)="move(card, 'ready')">Make ready</button>
          <button type="button" *ngIf="card.status === 'ready'" class="accent" (click)="claim(card)">Claim as {{ actor || 'human' }}</button>
          <button type="button" *ngIf="card.status === 'in-progress'" class="accent" (click)="requestReview(card)">Request review</button>
          <button type="button" *ngIf="card.status === 'in-progress'" (click)="release(card)">Release</button>
          <button type="button" *ngIf="card.status === 'review'" class="success" (click)="approve(card)">Approve</button>
          <button type="button" *ngIf="card.status === 'review' || card.status === 'done'" (click)="reopen(card)">Reopen</button>
        </div>
        <label>Title<input [(ngModel)]="editor.title" name="editTitle"></label>
        <label>Description<textarea [(ngModel)]="editor.description" name="editDescription" rows="5"></textarea></label>
        <div class="form-row">
          <label>Priority<select [(ngModel)]="editor.priority" name="editPriority"><option *ngFor="let priority of priorities" [value]="priority">{{ priority }}</option></select></label>
          <label>Assignee<input [(ngModel)]="editor.assignee" name="editAssignee" placeholder="Persona id"></label>
        </div>
        <label>Labels<input [(ngModel)]="editor.labels" name="editLabels" placeholder="comma-separated"></label>
        <label>Acceptance criteria<textarea [(ngModel)]="editor.acceptanceCriteria" name="editCriteria" rows="3"></textarea></label>
        <div class="form-row"><label>Due date<input type="date" [(ngModel)]="editor.dueDate" name="editDueDate"></label><label>Blocked by<input [(ngModel)]="editor.blockedReason" name="editBlocked"></label></div>
        <button type="button" class="save-details" (click)="saveDetails(card)" [disabled]="saving">Save task details</button>

        <section class="criteria" *ngIf="card.acceptanceCriteria.length"><h3>Acceptance criteria</h3><div *ngFor="let criterion of card.acceptanceCriteria"><span>□</span>{{ criterion }}</div></section>
        <section class="result" *ngIf="card.properties.result"><h3>Latest result</h3><p>{{ card.properties.result }}</p></section>

        <section class="activity-panel">
          <h3>Activity <span>{{ activityFor(card.taskId).length }}</span></h3>
          <div class="comment-box"><textarea [(ngModel)]="comment" name="comment" rows="3" placeholder="Progress, blocker, evidence, or decision…"></textarea><button type="button" (click)="addComment(card)" [disabled]="saving || !comment.trim()">Add note</button></div>
          <div class="activity" *ngFor="let event of activityFor(card.taskId); trackBy: trackActivity">
            <span class="event-icon">{{ eventIcon(event.properties.event) }}</span>
            <div><strong>{{ event.properties.actor || event.properties.assignee || 'system' }}</strong> {{ eventLabel(event.properties) }}
              <p *ngIf="event.properties.note">{{ event.properties.note }}</p><time>{{ formatDate(event.properties.createdAt) }}</time></div>
          </div>
          <p class="no-activity" *ngIf="!activityFor(card.taskId).length">No lifecycle events yet. Creation is stored on the canonical card.</p>
        </section>
        <button type="button" class="archive" (click)="archive(card)">Archive task</button>
      </aside>
    </section>
  `,
  styles: [`
    :host{display:block;min-width:0;color:var(--fg,#e7edf4);font-family:var(--sans,Inter,system-ui,sans-serif);--kb-bg:var(--bg,#0b0f14);--kb-panel:var(--panel,#111820);--kb-card:var(--card,#171f29);--kb-edge:var(--edge,#293341);--kb-muted:var(--muted,#8d99a8);--kb-accent:var(--acc,#7c6df2);--kb-green:#43c59e;--kb-red:#ef6a73;--kb-amber:#e8ad4f}
    *{box-sizing:border-box}.kanban-shell{min-height:650px;border:1px solid var(--kb-edge);border-radius:16px;overflow:hidden;background:radial-gradient(circle at 90% -20%,rgba(124,109,242,.14),transparent 34%),var(--kb-bg)}
    button,input,textarea,select{font:inherit}.hero{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:24px 26px 20px;border-bottom:1px solid var(--kb-edge)}.identity{display:flex;align-items:center;gap:16px}.mark{display:grid;grid-template-columns:repeat(3,7px);align-items:end;gap:4px;width:42px;height:42px;padding:10px;border:1px solid rgba(124,109,242,.35);border-radius:12px;background:rgba(124,109,242,.1)}.mark i{display:block;border-radius:3px;background:var(--kb-accent)}.mark i:nth-child(1){height:12px}.mark i:nth-child(2){height:20px}.mark i:nth-child(3){height:16px}.eyebrow{font:700 10px/1.2 var(--mono,monospace);letter-spacing:.13em;color:#9d91ff}.hero h1{margin:4px 0 2px;font-size:24px;letter-spacing:-.03em}.hero p{margin:0;color:var(--kb-muted);font-size:13px}.hero-actions{display:flex;gap:9px}button{border:1px solid var(--kb-edge);border-radius:8px;background:var(--kb-card);color:inherit;padding:9px 12px;cursor:pointer}button:hover{border-color:#59677a}button:disabled{opacity:.5;cursor:default}.primary,.accent{border-color:transparent;background:var(--kb-accent);color:white}.success{border-color:transparent;background:#248d70;color:white}.quiet{background:transparent}.primary span{font-size:16px;margin-right:4px}
    .stats{display:flex;align-items:stretch;border-bottom:1px solid var(--kb-edge);background:rgba(17,24,32,.75)}.stats>div{display:grid;grid-template-columns:auto 1fr;align-items:baseline;column-gap:8px;padding:13px 22px;border-right:1px solid var(--kb-edge)}.stats strong{font:700 17px var(--mono,monospace)}.stats span{font-size:11px;color:var(--kb-muted)}.stats .agent-status{display:flex;align-items:center;gap:8px;margin-left:auto;border:0}.agent-status b{width:7px;height:7px;border-radius:50%;background:var(--kb-green);box-shadow:0 0 0 4px rgba(67,197,158,.1)}
    .toolbar{display:grid;grid-template-columns:minmax(220px,1fr) auto minmax(160px,220px) auto;gap:10px;padding:14px 18px;align-items:end}.toolbar label{display:grid;gap:5px}.toolbar label>span{font:600 10px var(--mono,monospace);text-transform:uppercase;letter-spacing:.06em;color:var(--kb-muted)}.toolbar .search{display:flex;align-items:center;gap:8px;height:38px;padding:0 11px;border:1px solid var(--kb-edge);border-radius:8px;background:var(--kb-panel)}.toolbar .search>span{font-size:19px}.toolbar .search input{border:0;padding:0;background:transparent}.toolbar input,.toolbar select,.drawer input,.drawer textarea,.drawer select{width:100%;min-width:0;border:1px solid var(--kb-edge);border-radius:8px;background:var(--kb-panel);color:inherit;padding:9px 10px;outline:none}.toolbar input:focus,.toolbar select:focus,.drawer input:focus,.drawer textarea:focus,.drawer select:focus{border-color:var(--kb-accent);box-shadow:0 0 0 2px rgba(124,109,242,.13)}.toolbar select{height:38px}.icon-button{height:38px;font-size:18px}.error-banner{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 18px 12px;padding:10px 12px;border:1px solid rgba(239,106,115,.35);border-radius:8px;background:rgba(239,106,115,.1);color:#ffb4b9;font-size:12px}.error-banner button{padding:4px 8px;background:transparent}
    .board{display:grid;grid-template-columns:repeat(5,minmax(225px,1fr));gap:10px;overflow-x:auto;padding:0 18px 22px}.lane{min-width:225px;border:1px solid var(--kb-edge);border-radius:11px;background:rgba(17,24,32,.64);overflow:hidden}.lane>header{padding:13px 13px 11px;border-bottom:1px solid var(--kb-edge)}.lane>header>div{display:flex;align-items:center;gap:7px}.lane h2{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.lane header b{margin-left:auto;border-radius:10px;background:var(--kb-card);padding:2px 7px;color:var(--kb-muted);font:600 10px var(--mono,monospace)}.lane small{display:block;margin:5px 0 0 15px;color:var(--kb-muted);font-size:10px}.lane-dot{width:7px;height:7px;border-radius:50%;background:#677589}.lane[data-status=ready] .lane-dot{background:#58a6ff}.lane[data-status=in-progress] .lane-dot{background:var(--kb-amber)}.lane[data-status=review] .lane-dot{background:#b18cff}.lane[data-status=done] .lane-dot{background:var(--kb-green)}.lane-body{min-height:390px;padding:9px}.task-card{margin-bottom:9px;padding:12px;border:1px solid var(--kb-edge);border-radius:9px;background:linear-gradient(145deg,rgba(255,255,255,.018),transparent),var(--kb-card);box-shadow:0 4px 14px rgba(0,0,0,.13);cursor:pointer;transition:transform .14s,border-color .14s}.task-card:hover{transform:translateY(-1px);border-color:#48576a}.task-card.busy{opacity:.55}.task-card.overdue{border-left:2px solid var(--kb-red)}.card-top{display:flex;align-items:center;gap:7px}.priority{padding:3px 6px;border-radius:5px;background:#27313e;color:#aab4c1;font:700 8px var(--mono,monospace);text-transform:uppercase;letter-spacing:.05em}.priority[data-priority=urgent]{background:rgba(239,106,115,.14);color:#ff8991}.priority[data-priority=high]{background:rgba(232,173,79,.14);color:#f5bd61}.task-id{color:var(--kb-muted);font:500 9px var(--mono,monospace)}.more{margin-left:auto;border:0;background:transparent;padding:0 2px;color:var(--kb-muted);letter-spacing:1px}.task-card h3{margin:10px 0 6px;font-size:13px;line-height:1.35}.task-card>p{display:-webkit-box;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;margin:0 0 10px;color:var(--kb-muted);font-size:11px;line-height:1.45}.labels{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}.labels span{border:1px solid #344254;border-radius:10px;padding:2px 6px;color:#a7b6c9;font-size:8px}.blocked{display:flex;gap:6px;margin:8px 0;padding:6px 7px;border-radius:6px;background:rgba(239,106,115,.08);color:#ef939a;font-size:9px}.blocked span{font-weight:800}.task-card footer{display:flex;align-items:center;gap:6px;margin-top:11px;padding-top:9px;border-top:1px solid rgba(69,83,101,.5);color:var(--kb-muted);font-size:9px}.avatar{display:grid;place-items:center;width:21px;height:21px;border-radius:50%;background:linear-gradient(135deg,#725fe7,#4e9ccf);color:white;font:700 8px var(--mono,monospace)}.avatar.unassigned{background:#303b48;color:#8d99a8}.owner{overflow:hidden;max-width:72px;text-overflow:ellipsis;white-space:nowrap}.due{margin-left:auto}.due.late{color:#ff8991}.comments{white-space:nowrap}.lane-add{width:100%;border-style:dashed;background:transparent;color:var(--kb-muted);font-size:10px}.empty-lane{display:grid;place-items:center;gap:6px;padding:60px 5px;color:#596576;font-size:10px}.empty-lane span{font-size:20px}
    .scrim{position:fixed;z-index:900;inset:0;background:rgba(2,6,10,.66);backdrop-filter:blur(2px)}.drawer{position:fixed;z-index:901;top:0;right:0;width:min(500px,94vw);height:100vh;overflow:auto;padding:22px;background:var(--kb-bg);border-left:1px solid var(--kb-edge);box-shadow:-20px 0 50px rgba(0,0,0,.35)}.drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.drawer-head h2{margin:5px 0 0;font-size:21px}.drawer-head>button{border:0;background:transparent;padding:0;font-size:25px;color:var(--kb-muted)}.drawer-intro{margin:-6px 0 20px;color:var(--kb-muted);font-size:12px;line-height:1.5}.drawer>label,.form-row label{display:grid;gap:6px;margin-bottom:13px;color:var(--kb-muted);font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.05em}.drawer textarea{resize:vertical;line-height:1.45}.form-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.drawer-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px;padding-top:16px;border-top:1px solid var(--kb-edge)}.task-actions{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 20px;padding:12px;border:1px solid var(--kb-edge);border-radius:9px;background:var(--kb-panel)}.task-actions button{font-size:10px}.save-details{width:100%;margin:2px 0 20px}.criteria,.result,.activity-panel{margin:0 0 18px;padding-top:17px;border-top:1px solid var(--kb-edge)}.criteria h3,.result h3,.activity-panel h3{margin:0 0 10px;font-size:12px}.criteria>div{display:flex;gap:8px;margin:7px 0;color:#c0cad6;font-size:11px}.criteria span{color:var(--kb-green)}.result p{margin:0;padding:10px;border-radius:7px;background:var(--kb-panel);color:#bdc7d3;font-size:11px;line-height:1.5}.activity-panel h3 span{color:var(--kb-muted);font:500 10px var(--mono,monospace)}.comment-box{display:grid;grid-template-columns:1fr auto;gap:7px;align-items:end;margin-bottom:15px}.comment-box button{height:36px;font-size:10px}.activity{display:grid;grid-template-columns:27px 1fr;gap:8px;padding:10px 0;border-top:1px solid rgba(41,51,65,.7);font-size:10px}.event-icon{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:var(--kb-panel);color:#a69dff}.activity strong{color:#dce4ed}.activity p{margin:5px 0;color:#b4bfcb;line-height:1.45}.activity time{color:#697687;font:8px var(--mono,monospace)}.no-activity{color:var(--kb-muted);font-size:10px}.archive{width:100%;margin-top:8px;background:transparent;color:#d27b82}
    @media(max-width:850px){.hero{align-items:flex-start}.stats>div{padding:11px 13px}.toolbar{grid-template-columns:1fr 1fr}.toolbar .search{grid-column:1/-1}.board{grid-template-columns:repeat(5,260px)}.agent-status{display:none!important}}
    @media(max-width:560px){.hero{display:grid;padding:18px}.hero-actions{width:100%}.hero-actions button{flex:1}.stats{overflow:auto}.stats>div{min-width:105px}.toolbar{grid-template-columns:1fr;padding:12px}.toolbar .search{grid-column:auto}.form-row{grid-template-columns:1fr}.drawer{padding:18px}.comment-box{grid-template-columns:1fr}}
  `],
})
export class PersonaKanbanComponent implements OnDestroy {
  readonly lanes = BOARD_LANES;
  readonly priorities: KanbanPriority[] = ['urgent', 'high', 'normal', 'low'];
  cards: KanbanCardView[] = [];
  activity: Array<ApplicationStoreToken<KanbanActivityProperties>> = [];
  search = '';
  assigneeFilter = '';
  actor = 'human';
  error = '';
  refreshing = false;
  saving = false;
  busyTaskId = '';
  creating = false;
  selected?: KanbanCardView;
  comment = '';
  newStatus: 'backlog' | 'ready' = 'backlog';
  newTask = this.emptyEditor();
  editor = this.emptyEditor();
  private runtimeValue?: NetApplicationRuntime;
  private readonly stopWatching: Array<() => void> = [];

  @Input()
  set runtime(value: NetApplicationRuntime | undefined) {
    this.stopAllWatching();
    this.runtimeValue = value;
    if (!value) return;
    this.stopWatching.push(value.watchStore<KanbanCardProperties>('cards', event => {
      this.cards = sortCards(event.tokens.map(normalizeCard));
      this.reselect();
      this.cdr.markForCheck();
    }, 2000));
    this.stopWatching.push(value.watchStore<KanbanActivityProperties>('activity', event => {
      this.activity = [...event.tokens].sort((a, b) =>
        (b.properties.createdAt || '').localeCompare(a.properties.createdAt || ''));
      this.cdr.markForCheck();
    }, 2000));
  }
  get runtime(): NetApplicationRuntime | undefined { return this.runtimeValue; }

  constructor(private readonly cdr: ChangeDetectorRef) {}
  ngOnDestroy(): void { this.stopAllWatching(); }

  get activeCards(): KanbanCardView[] { return this.cards.filter(card => !card.archived); }
  get activeCount(): number { return this.activeCards.filter(card => card.status !== 'done').length; }
  get readyCount(): number { return this.activeCards.filter(card => card.status === 'ready').length; }
  get ownedCount(): number { return this.activeCards.filter(card => card.status === 'in-progress').length; }
  get overdueCount(): number { return this.activeCards.filter(card => isOverdue(card)).length; }
  get assignees(): string[] {
    return [...new Set(this.activeCards.map(card => card.properties.assignee || '').filter(Boolean))].sort();
  }

  cardsFor(status: KanbanStatus): KanbanCardView[] {
    return this.activeCards.filter(card => card.status === status && matchesCard(card, this.search, this.assigneeFilter));
  }
  activityFor(taskId: string): Array<ApplicationStoreToken<KanbanActivityProperties>> {
    return this.activity.filter(event => event.properties.taskId === taskId);
  }
  activityCount(taskId: string): number { return this.activityFor(taskId).length; }
  overdue(card: KanbanCardView): boolean { return isOverdue(card); }
  trackCard(_: number, card: KanbanCardView): string { return card.id; }
  trackActivity(_: number, event: ApplicationStoreToken<KanbanActivityProperties>): string { return event.id; }

  initials(value?: string): string {
    if (!value) return '—';
    return value.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?';
  }
  formatDate(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : value;
  }
  eventIcon(event?: string): string {
    return ({ claimed: '↗', released: '↙', moved: '⇢', updated: '✎', 'review-requested': '◇',
      approved: '✓', reopened: '↻', archived: '□', commented: '•' } as Record<string, string>)[event || ''] || '·';
  }
  eventLabel(event: KanbanActivityProperties): string {
    return ({ claimed: 'claimed the task', released: 'released the task', moved: `moved it to ${event.status || 'another lane'}`,
      updated: 'updated task details', 'review-requested': 'requested review', approved: 'approved the result',
      reopened: 'reopened the task', archived: 'archived the task', commented: 'added a note' } as Record<string, string>)[event.event || '']
      || event.action || 'recorded an event';
  }

  openCreate(status: 'backlog' | 'ready' = 'backlog'): void {
    this.closePanels(); this.newStatus = status; this.newTask = this.emptyEditor(); this.creating = true;
  }
  select(card: KanbanCardView): void {
    this.creating = false; this.selected = card; this.comment = ''; this.editor = this.editorFrom(card);
  }
  closePanels(): void { this.creating = false; this.selected = undefined; this.comment = ''; }

  async refresh(): Promise<void> {
    if (!this.runtime) return;
    this.refreshing = true; this.cdr.markForCheck();
    try {
      const [cards, activity] = await Promise.all([
        this.runtime.readStore<KanbanCardProperties>('cards'),
        this.runtime.readStore<KanbanActivityProperties>('activity'),
      ]);
      this.cards = sortCards(cards.map(normalizeCard));
      this.activity = [...activity].sort((a, b) =>
        (b.properties.createdAt || '').localeCompare(a.properties.createdAt || ''));
      this.reselect();
    } catch (error: unknown) { this.showError(error); }
    finally { this.refreshing = false; this.cdr.markForCheck(); }
  }

  async createTask(): Promise<void> {
    if (!this.newTask.title.trim()) return;
    const taskId = `TASK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await this.run('', 'createTask', {
      taskId, title: this.newTask.title.trim(), description: this.newTask.description.trim(),
      status: this.newStatus, priority: this.newTask.priority, assignee: this.newTask.assignee.trim(),
      labels: parseStringList(this.newTask.labels), acceptanceCriteria: parseStringList(this.newTask.acceptanceCriteria),
      dueDate: this.newTask.dueDate, createdBy: this.actor.trim() || 'human',
    });
    if (!this.error) { this.creating = false; this.newTask = this.emptyEditor(); }
  }

  async saveDetails(card: KanbanCardView): Promise<void> {
    await this.run(card.taskId, 'updateTask', {
      taskId: card.taskId, actor: this.currentActor(), title: this.editor.title.trim(),
      description: this.editor.description.trim(), priority: this.editor.priority,
      assignee: this.editor.assignee.trim(), labels: parseStringList(this.editor.labels),
      acceptanceCriteria: parseStringList(this.editor.acceptanceCriteria), dueDate: this.editor.dueDate,
      blockedReason: this.editor.blockedReason.trim(), note: 'Task details updated from the board.',
    });
  }
  async move(card: KanbanCardView, status: KanbanStatus): Promise<void> {
    if (card.status === status) return;
    await this.run(card.taskId, 'moveTask', { taskId: card.taskId, status, actor: this.currentActor(), note: `Board move: ${card.status} → ${status}` });
  }
  async claim(card: KanbanCardView): Promise<void> {
    const assignee = this.editor.assignee.trim() || this.currentActor();
    await this.run(card.taskId, 'claimTask', { taskId: card.taskId, assignee, actor: this.currentActor(), note: 'Claimed from the ready queue.' });
  }
  async release(card: KanbanCardView): Promise<void> {
    await this.run(card.taskId, 'releaseTask', { taskId: card.taskId, actor: this.currentActor(), note: this.comment.trim() || 'Released for another worker.' });
  }
  async requestReview(card: KanbanCardView): Promise<void> {
    const note = this.comment.trim() || card.properties.result || 'Work is ready for review; see the task evidence and activity.';
    await this.run(card.taskId, 'requestReview', { taskId: card.taskId, actor: this.currentActor(), reviewer: '', note });
    this.comment = '';
  }
  async approve(card: KanbanCardView): Promise<void> {
    const note = this.comment.trim() || 'Reviewed and accepted.';
    await this.run(card.taskId, 'approveTask', { taskId: card.taskId, actor: this.currentActor(), note });
    this.comment = '';
  }
  async reopen(card: KanbanCardView): Promise<void> {
    const note = this.comment.trim() || 'More work is required.';
    await this.run(card.taskId, 'reopenTask', { taskId: card.taskId, actor: this.currentActor(), note });
    this.comment = '';
  }
  async archive(card: KanbanCardView): Promise<void> {
    await this.run(card.taskId, 'archiveTask', { taskId: card.taskId, actor: this.currentActor(), note: 'Archived from the board.' });
    if (!this.error) this.closePanels();
  }
  async addComment(card: KanbanCardView): Promise<void> {
    if (!this.comment.trim()) return;
    await this.run(card.taskId, 'addComment', { taskId: card.taskId, actor: this.currentActor(), note: this.comment.trim() });
    if (!this.error) this.comment = '';
  }

  allowDrop(event: DragEvent): void { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }
  startDrag(event: DragEvent, card: KanbanCardView): void {
    event.dataTransfer?.setData('text/plain', card.taskId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }
  drop(event: DragEvent, status: KanbanStatus): void {
    event.preventDefault();
    const taskId = event.dataTransfer?.getData('text/plain');
    const card = this.cards.find(candidate => candidate.taskId === taskId);
    if (card) void this.move(card, status);
  }

  private async run(taskId: string, action: string, input: Record<string, unknown>): Promise<void> {
    if (!this.runtime) return;
    this.error = ''; this.saving = true; this.busyTaskId = taskId; this.cdr.markForCheck();
    try {
      const result = await this.runtime.invoke<ActionResult>(action, input);
      const failed = result.effects?.find(effect => effect.applied === false && effect.error);
      if (failed?.error) throw new Error(failed.error);
      await this.refresh();
    } catch (error: unknown) { this.showError(error); }
    finally { this.saving = false; this.busyTaskId = ''; this.cdr.markForCheck(); }
  }
  private currentActor(): string { return this.actor.trim() || 'human'; }
  private showError(error: unknown): void {
    this.error = error instanceof Error ? error.message : 'The net action could not be completed.';
    this.cdr.markForCheck();
  }
  private reselect(): void {
    if (!this.selected) return;
    this.selected = this.cards.find(card => card.taskId === this.selected?.taskId);
    if (this.selected) this.editor = this.editorFrom(this.selected);
  }
  private stopAllWatching(): void { this.stopWatching.splice(0).forEach(stop => stop()); }
  private emptyEditor(): TaskEditor {
    return { title: '', description: '', priority: 'normal', assignee: '', labels: '', acceptanceCriteria: '', dueDate: '', blockedReason: '' };
  }
  private editorFrom(card: KanbanCardView): TaskEditor {
    return {
      title: card.title, description: card.properties.description || '', priority: card.priority,
      assignee: card.properties.assignee || '', labels: card.labels.join(', '),
      acceptanceCriteria: card.acceptanceCriteria.join('\n'), dueDate: card.properties.dueDate || '',
      blockedReason: card.properties.blockedReason || '',
    };
  }
}
