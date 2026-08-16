import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ApplicationDescriptor, ApplicationStoreToken, NetApplicationElement,
  NetApplicationRuntime, NetApplicationSnapshotEvent,
} from '@agenticos/net-app-sdk';

@Component({
  standalone: true,
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <header><strong>AgenticOS Net App Dev Host</strong><span>public SDK · mock runtime</span></header>
    <main>
      <section class="controls">
        <label>Compiled ESM entry<input type="file" accept=".js,.mjs,text/javascript" (change)="choose($event)"></label>
        <label>Custom element<input [(ngModel)]="elementName" placeholder="agenticos-my-app-v1"></label>
        <button type="button" (click)="mount()" [disabled]="!source || !elementName">Load surface</button>
        <button type="button" class="secondary" (click)="seed()">Seed Kanban</button>
        <p *ngIf="error" class="error">{{ error }}</p>
        <p class="help">Build an app, select its self-contained <code>main.js</code>, and enter the element name from <code>agenticos.app.json</code>. The host supplies an in-memory implementation of the same runtime contract as Studio.</p>
      </section>
      <section class="frame"><div #mountPoint></div><p class="empty" *ngIf="!mounted">Application surface mounts here.</p></section>
    </main>
  `,
  styles: [`
    header{height:56px;display:flex;align-items:center;gap:12px;padding:0 18px;background:linear-gradient(180deg,var(--bg),var(--toolbar));border-bottom:1px solid var(--edge)}header span{color:var(--muted);font-size:12px}
    main{max-width:1000px;margin:0 auto;padding:24px}.controls,.frame{border:1px solid var(--edge);border-radius:12px;background:var(--panel);padding:18px;margin-bottom:18px}
    .controls{display:grid;grid-template-columns:1fr 1fr auto auto;gap:12px;align-items:end}label{display:grid;gap:6px;color:var(--muted);font-size:12px}input{width:100%;padding:9px;border:1px solid var(--edge);border-radius:7px;background:var(--bg);color:var(--fg)}
    button{padding:10px 14px;border:1px solid var(--edge);border-radius:7px;background:var(--acc);color:white;cursor:pointer}.secondary{background:var(--card);color:var(--fg)}button:disabled{opacity:.5}.help,.error{grid-column:1/-1;margin:0;font-size:12px}.help{color:var(--muted)}.error{color:var(--err)}.empty{text-align:center;color:var(--muted);padding:50px}
    @media(max-width:760px){.controls{grid-template-columns:1fr}}
  `],
})
export class DevHostComponent {
  @ViewChild('mountPoint', { static: true }) mountPoint!: ElementRef<HTMLDivElement>;
  elementName = 'agenticos-persona-kanban-v1';
  source = '';
  error = '';
  mounted = false;
  private readonly runtime = new MockRuntime();

  constructor(private cdr: ChangeDetectorRef) {}

  choose(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then(source => { this.source = source; this.error = ''; this.cdr.markForCheck(); });
  }

  async mount(): Promise<void> {
    this.error = ''; this.mounted = false; this.mountPoint.nativeElement.replaceChildren();
    try {
      const url = URL.createObjectURL(new Blob([this.source], { type: 'text/javascript' }));
      try { await import(/* webpackIgnore: true */ url); } finally { URL.revokeObjectURL(url); }
      if (!customElements.get(this.elementName)) throw new Error(`Module did not register <${this.elementName}>.`);
      const element = document.createElement(this.elementName) as NetApplicationElement;
      element.runtime = this.runtime;
      this.mountPoint.nativeElement.appendChild(element);
      this.mounted = true;
    } catch (error: any) {
      this.error = error?.message || 'Could not mount the application.';
    }
    this.cdr.markForCheck();
  }

  seed(): void { void this.runtime.seedKanban(); }
}

class MockRuntime implements NetApplicationRuntime {
  readonly context = { modelId: 'dev', sessionId: 'dev-session', installationId: 'dev-app', name: 'dev-app', version: '0.0.0' };
  private readonly stores = new Map<string, Array<ApplicationStoreToken>>([
    ['tasks', []], ['cards', []], ['activity', []],
  ]);
  private readonly listeners = new Map<string, Set<(event: NetApplicationSnapshotEvent) => void>>();

  async describe(): Promise<ApplicationDescriptor> {
    return {
      sessionId: this.context.sessionId, name: this.context.name,
      stores: [{ role: 'tasks' }, { role: 'cards' }, { role: 'activity' }],
      actions: ['addTask', 'createTask', 'updateTask', 'moveTask', 'claimTask', 'releaseTask',
        'requestReview', 'approveTask', 'reopenTask', 'archiveTask', 'addComment'].map(name => ({ name })),
    };
  }
  async readStore<T extends object>(role: string): Promise<Array<ApplicationStoreToken<T>>> {
    return [...(this.stores.get(role) || [])] as Array<ApplicationStoreToken<T>>;
  }
  watchStore<T extends object>(role: string,
      listener: (event: NetApplicationSnapshotEvent<T>) => void): () => void {
    const listeners = this.listeners.get(role) || new Set();
    listeners.add(listener as (event: NetApplicationSnapshotEvent) => void); this.listeners.set(role, listeners);
    void this.readStore<T>(role).then(tokens => listener({ type: 'snapshot', role, tokens }));
    return () => listeners.delete(listener as (event: NetApplicationSnapshotEvent) => void);
  }
  async invoke<T>(action: string, input: Record<string, unknown>): Promise<T> {
    const now = new Date().toISOString();
    if (action === 'addTask') {
      const tasks = this.stores.get('tasks') || [];
      tasks.push({ id: crypto.randomUUID(), name: `task-${tasks.length + 1}`, properties: { ...input, status: 'open', createdAt: now } });
      this.stores.set('tasks', tasks); this.emit('tasks');
      return { accepted: true } as T;
    }
    if (action === 'createTask') {
      const cards = this.stores.get('cards') || [];
      if (cards.some(card => card.properties['taskId'] === input['taskId'])) throw new Error('Duplicate taskId.');
      cards.push({ id: crypto.randomUUID(), name: `card-${cards.length + 1}`, properties: {
        kind: 'kanban-task', priority: 'normal', status: 'backlog', assignee: '', archived: false,
        ...input, createdAt: now, application: 'dev-app', action,
      } });
      this.stores.set('cards', cards); this.emit('cards');
      return { accepted: true } as T;
    }
    const taskId = String(input['taskId'] || '');
    const cards = this.stores.get('cards') || [];
    const card = cards.find(candidate => candidate.properties['taskId'] === taskId);
    if (!card) throw new Error(`Mock card ${taskId} does not exist.`);
    const activity = this.stores.get('activity') || [];
    const eventByAction: Record<string, string> = {
      updateTask: 'updated', moveTask: 'moved', claimTask: 'claimed', releaseTask: 'released',
      requestReview: 'review-requested', approveTask: 'approved', reopenTask: 'reopened',
      archiveTask: 'archived', addComment: 'commented',
    };
    if (!eventByAction[action]) throw new Error(`Mock runtime does not implement ${action}.`);
    if (action === 'claimTask' && card.properties['status'] !== 'ready') throw new Error('Only ready tasks can be claimed.');
    if (action === 'requestReview' && card.properties['status'] !== 'in-progress') throw new Error('Only in-progress tasks can enter review.');
    if (action === 'approveTask' && card.properties['status'] !== 'review') throw new Error('Only review tasks can be approved.');
    activity.push({ id: crypto.randomUUID(), name: `activity-${activity.length + 1}`, properties: {
      kind: 'kanban-activity', event: eventByAction[action], ...input, createdAt: now, action,
    } });
    if (action === 'updateTask') {
      for (const key of ['title', 'description', 'priority', 'assignee', 'labels', 'acceptanceCriteria', 'dueDate', 'blockedReason']) {
        if (input[key] !== undefined) card.properties[key] = input[key];
      }
    } else if (action === 'moveTask') card.properties['status'] = input['status'];
    else if (action === 'claimTask') Object.assign(card.properties, { status: 'in-progress', assignee: input['assignee'], claimedAt: now });
    else if (action === 'releaseTask') Object.assign(card.properties, { status: 'ready', assignee: '', blockedReason: '' });
    else if (action === 'requestReview') Object.assign(card.properties, { status: 'review', reviewer: input['reviewer'], result: input['note'] });
    else if (action === 'approveTask') Object.assign(card.properties, { status: 'done', completedBy: input['actor'], completedAt: now, result: input['note'] });
    else if (action === 'reopenTask') Object.assign(card.properties, { status: 'ready', assignee: '', blockedReason: input['note'] });
    else if (action === 'archiveTask') Object.assign(card.properties, { status: 'archived', archived: true });
    card.properties['updatedAt'] = now;
    this.stores.set('activity', activity); this.emit('activity'); this.emit('cards');
    return { accepted: true, effects: action === 'addComment' ? [] : [{ applied: true }] } as T;
  }
  async seedKanban(): Promise<void> {
    if ((this.stores.get('cards') || []).length) return;
    await this.invoke('createTask', { taskId: 'TASK-101', title: 'Define the Persona work contract',
      description: 'Document how autonomous workers discover, claim, review, and complete tasks.',
      status: 'ready', priority: 'urgent', assignee: '', labels: ['agents', 'architecture'],
      acceptanceCriteria: ['Contract is machine-readable', 'Claim and review paths are documented'], createdBy: 'product-manager' });
    await this.invoke('createTask', { taskId: 'TASK-102', title: 'Polish responsive board layout',
      description: 'Verify the Web Component remains useful inside narrow Studio panes.',
      status: 'in-progress', priority: 'high', assignee: 'persona-frontend', labels: ['ui'], createdBy: 'human' });
    await this.invoke('createTask', { taskId: 'TASK-103', title: 'Run package integrity smoke test',
      description: 'Build, package, verify SHA-256, install, and mount through the gateway.',
      status: 'review', priority: 'normal', assignee: 'persona-qa', labels: ['release', 'security'], createdBy: 'persona-developer' });
  }
  navigate(command: 'open-app-index' | 'open-underlying-net'): void { alert(`Navigation requested: ${command}`); }
  private emit(role: string): void {
    const event: NetApplicationSnapshotEvent = { type: 'snapshot', role, tokens: [...(this.stores.get(role) || [])] };
    this.listeners.get(role)?.forEach(listener => listener(event));
  }
}
