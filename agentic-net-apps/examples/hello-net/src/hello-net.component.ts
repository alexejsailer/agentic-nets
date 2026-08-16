import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApplicationStoreToken, NetApplicationRuntime } from '@agenticos/net-app-sdk';

interface Task { title?: string; status?: string; createdAt?: string }

@Component({
  standalone: true,
  selector: 'agenticos-hello-net-source',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="app-card">
      <header>
        <div><span class="eyebrow">PUBLIC NET APPLICATION</span><h2>Hello Net</h2></div>
        <button type="button" class="ghost" (click)="runtime?.navigate('open-underlying-net')">Open net</button>
      </header>
      <p class="intro">This surface is compiled outside Studio and mounted from a NetHub application package.</p>
      <form (ngSubmit)="add()">
        <input name="title" [(ngModel)]="title" placeholder="A task backed by the net" required>
        <button type="submit" [disabled]="saving || !title.trim()">{{ saving ? 'Adding…' : 'Add task' }}</button>
      </form>
      <p class="error" *ngIf="error">{{ error }}</p>
      <div class="task" *ngFor="let token of tasks">
        <strong>{{ token.properties.title || token.name }}</strong>
        <span>{{ token.properties.status || 'open' }}</span>
      </div>
      <p class="empty" *ngIf="!tasks.length">The net store is empty. Add the first task.</p>
    </section>
  `,
  styles: [`
    :host{display:block;color:var(--fg,#e6edf3);font-family:var(--sans,system-ui,sans-serif)}
    .app-card{border:1px solid var(--edge,#30363d);border-radius:12px;background:var(--card,#161b22);padding:20px}
    header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}h2{margin:3px 0 0;font-size:22px}
    .eyebrow{font:600 10px/1 var(--mono,monospace);letter-spacing:.12em;color:var(--acc,#58a6ff)}
    .intro,.empty{color:var(--muted,#8b949e)}form{display:flex;gap:8px;margin:20px 0}
    input{flex:1;min-width:0;padding:10px;border:1px solid var(--edge,#30363d);border-radius:7px;background:var(--bg,#0d1117);color:inherit}
    button{padding:9px 13px;border:1px solid var(--edge,#30363d);border-radius:7px;background:var(--acc,#238636);color:white;cursor:pointer}
    button:disabled{opacity:.55}.ghost{background:transparent;color:var(--acc,#58a6ff)}
    .task{display:flex;justify-content:space-between;gap:12px;padding:11px 2px;border-top:1px solid var(--edge,#30363d)}
    .task span{color:var(--muted,#8b949e);font:11px var(--mono,monospace)}.error{color:var(--err,#f85149)}
  `],
})
export class HelloNetComponent implements OnDestroy {
  tasks: Array<ApplicationStoreToken<Task>> = [];
  title = '';
  saving = false;
  error = '';
  private stopWatching?: () => void;
  private runtimeValue?: NetApplicationRuntime;

  @Input()
  set runtime(value: NetApplicationRuntime | undefined) {
    this.stopWatching?.();
    this.runtimeValue = value;
    if (value) {
      this.stopWatching = value.watchStore<Task>('tasks', event => {
        this.tasks = event.tokens;
        this.cdr.markForCheck();
      });
    }
  }
  get runtime(): NetApplicationRuntime | undefined { return this.runtimeValue; }

  constructor(private cdr: ChangeDetectorRef) {}
  ngOnDestroy(): void { this.stopWatching?.(); }

  async add(): Promise<void> {
    if (!this.runtime || !this.title.trim()) return;
    this.saving = true; this.error = ''; this.cdr.markForCheck();
    try {
      await this.runtime.invoke('addTask', { title: this.title.trim() });
      this.title = '';
    } catch (error: any) {
      this.error = error?.message || 'Could not add the task.';
    } finally {
      this.saving = false; this.cdr.markForCheck();
    }
  }
}
