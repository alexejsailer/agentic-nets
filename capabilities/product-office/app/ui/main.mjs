/**
 * Product office: the application on top of the office nets (trusted-element web component, self-contained ESM).
 *
 * Tabs: Inbox (everything waiting for you, across teams), Roadmap (the product manager's open question and the
 * roadmap), Teams (the registry with status and a link to each team's app), Product (goal, principles, services,
 * config), Brain, Digest, Journal. Everything shown is read from stores through the runtime bridge; every button
 * writes a token through a declared action. Nothing here computes a number a script did not measure.
 * Token properties arrive as STRINGS; nested structures as JSON text (arr()/obj() are the only readers).
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const arr = (v) => { if (Array.isArray(v)) return v; if (typeof v !== 'string' || !v.trim()) return []; try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } };
const obj = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) return v; if (typeof v !== 'string' || !v.trim()) return {}; try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {}; } catch { return {}; } };
const isTrue = (v) => String(v ?? '').toLowerCase() === 'true';
const when = (s) => { if (!s) return ''; const d = new Date(String(s)); return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const props = (tokens) => (tokens || []).map((t) => t.properties || {});
const newest = (rows, field) => [...rows].sort((a, b) => String(b[field] ?? '').localeCompare(String(a[field] ?? '')));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const stamp = () => nowIso().replace(/[-:]/g, '').replace('T', '');
const linesOf = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
async function idempotencyKey(action, input) {
  const canon = JSON.stringify({ action, input }, Object.keys(input).sort().concat('action', 'input'));
  try { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon)); return `${action}:${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`; }
  catch { return `${action}:${crypto.randomUUID()}`; }
}

const CSS = `
:host { display: block; container-type: inline-size; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  --fg: #1c1f24; --muted: #5d6673; --panel: #ffffff; --edge: #dfe3e8; --card: #f6f7f9; --accent: #0f766e; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --bg: #f0f2f5; }
@media (prefers-color-scheme: dark) { :host { --fg: #e6e6e6; --muted: #9aa1ab; --panel: #16181d; --edge: #2a2d34; --card: #1d2026; --accent: #2dd4bf; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --bg: #0f1115; } }
.wrap { color: var(--fg); background: var(--bg); padding: 12px; min-height: 100%; box-sizing: border-box; }
header { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: baseline; padding: 6px 4px 10px; }
header h1 { font-size: 20px; margin: 0; } header .status { color: var(--muted); font-size: 13px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
nav button { background: var(--panel); border: 1px solid var(--edge); color: var(--fg); padding: 6px 12px; border-radius: 16px; cursor: pointer; }
nav button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
nav button .n { display: inline-block; min-width: 18px; text-align: center; background: var(--accent); color: #fff; border-radius: 9px; font-size: 11px; margin-left: 6px; padding: 0 5px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--edge); border-radius: 10px; padding: 12px 14px; }
.card h2 { font-size: 15px; margin: 0 0 8px; } .card h3 { font-size: 13px; margin: 12px 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.muted { color: var(--muted); } .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
button.act { background: var(--accent); color: #fff; border: 0; padding: 7px 12px; border-radius: 6px; cursor: pointer; font-weight: 600; }
button.act.secondary { background: var(--card); color: var(--fg); border: 1px solid var(--edge); } button.act.danger { background: var(--bad); } button.act:disabled { opacity: .5; cursor: default; }
input, textarea, select { width: 100%; box-sizing: border-box; background: var(--card); color: var(--fg); border: 1px solid var(--edge); border-radius: 6px; padding: 6px 8px; font: inherit; }
textarea { min-height: 70px; resize: vertical; } label { display: block; font-size: 12px; color: var(--muted); margin-top: 8px; }
.opt { border: 1px solid var(--edge); border-radius: 8px; padding: 10px 12px; margin-top: 8px; background: var(--card); cursor: pointer; } .opt.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; } .opt .t { font-weight: 600; }
.pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--edge); color: var(--muted); margin-left: 6px; }
.pill.ok { color: var(--ok); border-color: var(--ok); } .pill.warn { color: var(--warn); border-color: var(--warn); } .pill.bad { color: var(--bad); border-color: var(--bad); } .pill.rec { color: var(--accent); border-color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: 13px; } td, th { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--edge); vertical-align: top; } th { color: var(--muted); font-weight: 600; }
ul { margin: 4px 0; padding-left: 18px; } li { margin: 2px 0; }
.toast { position: fixed; right: 16px; bottom: 16px; background: var(--fg); color: var(--bg); padding: 8px 12px; border-radius: 8px; z-index: 9; max-width: 60ch; } .toast.err { background: var(--bad); color: #fff; }
details summary { cursor: pointer; color: var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; }
.empty { color: var(--muted); padding: 24px; text-align: center; } .banner { border-left: 4px solid var(--warn); background: var(--card); padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; }
a { color: var(--accent); }
`;

const ROLES = ['charter', 'coders', 'teams', 'inbox', 'status', 'prompts', 'responses', 'iterate', 'roadmap', 'infra', 'digest', 'journal', 'errors', 'llm-errors', 'knowledge', 'plan', 'adr', 'ideas', 'curations', 'signals', 'specs'];
const CHARTER_KEYS = ['product', 'goal', 'description', 'principles', 'constraints', 'services', 'autonomyLevel', 'dailyBudgetUsd', 'digestCron', 'home', 'repoRoot', 'mcpUrl', 'coderAgent', 'coderModel', 'coderMaxTurns', 'coderAllowedTools', 'coderTimeoutMin', 'brainAgent', 'brainModel'];
const LIST_KEYS = ['principles', 'constraints', 'services'];

class ProductOfficeApp extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }); this._s = {}; this._tab = 'inbox'; this._form = {}; this._busy = new Set(); this._unsubs = []; this._open = new Set(); }
  set runtime(rt) { this._rt = rt; if (this.isConnected) this._boot(); }
  get runtime() { return this._rt; }
  connectedCallback() { if (this._rt) this._boot(); }
  disconnectedCallback() { for (const u of this._unsubs.splice(0)) { try { u(); } catch { /* gone */ } } clearInterval(this._timer); }

  async _boot() {
    this.shadowRoot.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="empty">Loading the product office…</div></div>`;
    await this._load(ROLES);
    for (const role of ['inbox', 'prompts', 'teams', 'status', 'roadmap', 'journal', 'knowledge', 'plan', 'digest', 'infra']) {
      try { this._unsubs.push(this._rt.watchStore(role, (ev) => { this._s[role] = ev.tokens; this._render(); }, 15000)); } catch { /* covered by the sweep */ }
    }
    this._timer = setInterval(() => this._load(['charter', 'coders', 'responses', 'adr', 'ideas', 'errors', 'llm-errors', 'iterate']), 30000);
  }
  async _load(roles) {
    await Promise.all(roles.map(async (r) => { try { this._s[r] = await this._rt.readStore(r, { limit: 400 }); } catch { this._s[r] = this._s[r] || []; } }));
    this._render();
  }
  async _invoke(action, input, busyKey) {
    if (this._busy.has(busyKey)) return;
    this._busy.add(busyKey); this._render();
    try { await this._rt.invoke(action, input, { idempotencyKey: await idempotencyKey(action, input) }); this._toast(`${action} ✓`); await this._load(ROLES); }
    catch (e) { this._toast(e?.message || `${action} failed`, true); }
    finally { this._busy.delete(busyKey); this._render(); }
  }
  _toast(msg, err) { const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg; this.shadowRoot.appendChild(el); setTimeout(() => el.remove(), err ? 6000 : 2500); }

  // ---- data ------------------------------------------------------------------------------------
  _charter() { const rows = props(this._s.charter).filter((c) => c.charterId === 'office' || !c.charterId); return newest(rows, 'updatedAt')[0] || {}; }
  _goalUndefined(c) { return !c.goal || /REPLACE.?ME/i.test(String(c.goal)); }
  _teams() { return newest(props(this._s.teams), 'registeredAt').filter((t) => t.service); }
  _statusOf(service) { return newest(props(this._s.status).filter((s) => s.service === service), 'at')[0] || null; }
  _inbox() { const by = new Map(); for (const i of newest(props(this._s.inbox), 'at').reverse()) if (i.itemId) by.set(i.itemId, i); return [...by.values()].filter((i) => i.status === 'open').sort((a, b) => String(a.at).localeCompare(String(b.at))); }
  _openQuestion() {
    const answered = new Set(props(this._s.responses).map((r) => r.promptId));
    const latestPerIteration = new Map();
    for (const p of newest(props(this._s.prompts), 'at').reverse()) if (p.promptId) latestPerIteration.set(p.iterationId || p.promptId, p);
    return newest([...latestPerIteration.values()].filter((p) => !answered.has(p.promptId)), 'at')[0] || null;
  }
  _adrs() { const by = new Map(); for (const a of newest(props(this._s.adr), 'updatedAt').reverse()) if (a.adrId) by.set(a.adrId, a); return [...by.values()].sort((a, b) => String(a.adrId).localeCompare(String(b.adrId))); }
  _ideas() { const by = new Map(); for (const i of newest(props(this._s.ideas), 'at').reverse()) if (i.ideaId) by.set(i.ideaId, i); return [...by.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))); }
  _infra() { return newest(props(this._s.infra).filter((i) => i.kind !== 'pause'), 'at')[0] || null; }
  _paused() { const r = newest(props(this._s.infra).filter((i) => i.kind === 'pause'), 'at')[0]; return !!r && r.state === 'paused'; }
  _working() {
    if (props(this._s.iterate).length) return 'The product manager is thinking about the next step';
    const j = newest(props(this._s.journal), 'at')[0];
    if (j && j.stage === 'brief' && Date.now() - new Date(j.at).getTime() < 10 * 60 * 1000) return 'The product manager is thinking about the next step';
    return '';
  }
  _teamRoute(t) { return t.appRoute || `#/applications/${encodeURIComponent(t.session || '')}?model=${encodeURIComponent(t.model || '')}`; }

  // ---- render ----------------------------------------------------------------------------------
  _render() {
    const root = this.shadowRoot;
    const c = this._charter(), inbox = this._inbox(), q = this._openQuestion(), teams = this._teams();
    const status = [this._paused() ? 'PAUSED' : '', `${teams.length} team${teams.length === 1 ? '' : 's'}`, `${inbox.length} waiting for you`, this._working()].filter(Boolean).join(' · ');
    const tabs = [['inbox', 'Inbox'], ['roadmap', 'Roadmap'], ['teams', 'Teams'], ['product', 'Product'], ['brain', 'Brain'], ['digest', 'Digest'], ['journal', 'Journal']];
    const body = { inbox: this._inboxTab, roadmap: this._roadmapTab, teams: this._teamsTab, product: this._productTab, brain: this._brainTab, digest: this._digestTab, journal: this._journalTab }[this._tab].call(this);
    root.innerHTML = `<style>${CSS}</style><div class="wrap">
      <header><h1>${esc(c.product || 'Product office')}</h1><span class="status">${esc(status)}</span></header>
      <nav>${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === this._tab ? 'on' : ''}">${l}${k === 'inbox' && (inbox.length + (q ? 1 : 0)) ? `<span class="n">${inbox.length + (q ? 1 : 0)}</span>` : ''}</button>`).join('')}</nav>
      ${this._paused() ? '<div class="banner">The product office is paused. Resume it in Product.</div>' : ''}
      ${body}</div>`;
    root.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { this._tab = b.dataset.tab; this._render(); }));
    root.querySelectorAll('details').forEach((d) => { const k = this._tab + '|' + (d.querySelector('summary')?.textContent || '').trim().slice(0, 120); if (this._open.has(k)) d.open = true; else if (d.open) this._open.add(k); d.addEventListener('toggle', () => { if (d.open) this._open.add(k); else this._open.delete(k); }); });
    root.querySelectorAll('[data-f]').forEach((el) => { el.addEventListener('input', () => { this._form[el.dataset.f] = el.value; }); if (el.tagName === 'SELECT') el.addEventListener('change', () => { this._form[el.dataset.f] = el.value; this._render(); }); });
    root.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => this._onAct(el.dataset.act, el.dataset.arg)));
    root.querySelectorAll('.opt[data-opt]').forEach((el) => el.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT') return;
      const multi = el.dataset.multi === 'true'; const cur = new Set(arr(this._form.__selected || '[]'));
      if (multi) { cur.has(el.dataset.opt) ? cur.delete(el.dataset.opt) : cur.add(el.dataset.opt); } else { cur.clear(); cur.add(el.dataset.opt); }
      this._form.__selected = JSON.stringify([...cur]); this._render();
    }));
  }
  _field(name, label, value, kind = 'input', ph = '') { const v = this._form[name] ?? value ?? ''; return `<label>${esc(label)}</label>${kind === 'textarea' ? `<textarea data-f="${name}" placeholder="${esc(ph)}">${esc(v)}</textarea>` : `<input data-f="${name}" value="${esc(v)}" placeholder="${esc(ph)}">`}`; }
  _select(name, label, value, options) { const v = this._form[name] ?? value ?? ''; return `<label>${esc(label)}</label><select data-f="${name}">${options.map(([val, lab]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`; }

  _questionCard(p) {
    const options = arr(p.options), selected = new Set(arr(this._form.__selected || '[]')), mode = String(p.mode || 'choice');
    const title = p.kind === 'brain' ? 'The brain has a question' : mode === 'goal' ? 'The product manager needs the product goal' : mode === 'interview' ? 'The product manager has questions' : 'The product manager proposes the next step';
    return `<div class="card"><h2>${title} <span class="pill">${esc(p.promptId)}</span></h2>
      <div>${esc(p.question)}</div>${p.context ? `<div class="muted" style="margin-top:6px">${esc(p.context)}</div>` : ''}
      ${options.map((o) => mode === 'interview'
        ? `<div class="opt" data-opt="${esc(o.value)}" data-multi="true"><div class="t">${esc(o.label)}</div><div class="muted">${esc(o.description || '')}</div>${this._field('q.' + o.value, 'Your answer', '', 'textarea')}</div>`
        : `<div class="opt ${selected.has(String(o.value)) ? 'sel' : ''}" data-opt="${esc(o.value)}" data-multi="false"><div class="t">${esc(o.label)} ${isTrue(o.recommended) ? '<span class="pill rec">recommended</span>' : ''} ${o.kind ? `<span class="pill">${esc(o.kind)}</span>` : ''} ${o.service ? `<span class="pill">${esc(o.service)}</span>` : ''} ${o.effort ? `<span class="pill">effort ${esc(o.effort)}</span>` : ''} ${o.risk ? `<span class="pill">risk ${esc(o.risk)}</span>` : ''}</div><div class="muted">${esc(o.description || '')}</div>${o.direction ? `<div class="muted mono">${esc(o.direction)}</div>` : ''}</div>`).join('')}
      ${this._field('resp.text', mode === 'goal' ? 'The product goal (one line, then a paragraph)' : 'Your own words (optional)', '', 'textarea')}
      ${this._field('resp.notes', 'Notes for the team (optional)', '')}
      ${p.rationale ? `<details><summary>Why these options</summary><div>${esc(p.rationale)}</div></details>` : ''}
      <div class="row"><button class="act" data-act="respond">Answer</button><button class="act secondary" data-act="revise">Reshape the question</button><button class="act secondary" data-act="skip">Skip, propose something else</button></div></div>`;
  }

  _inboxTab() {
    const q = this._openQuestion(), inbox = this._inbox(), c = this._charter();
    const parts = [];
    if (q) parts.push(this._questionCard(q));
    const byService = new Map();
    for (const i of inbox) { const k = i.service || 'product'; if (!byService.has(k)) byService.set(k, []); byService.get(k).push(i); }
    for (const [service, items] of byService) {
      const team = this._teams().find((t) => t.service === service);
      parts.push(`<div class="card"><h2>${esc(service)} <span class="pill">${items.length}</span> ${team ? `<a href="${esc(this._teamRoute(team))}">open the team app</a>` : ''}</h2>
        <table>${items.map((i) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(i.at))}</td><td><span class="pill">${esc(i.persona)}</span> <span class="pill">${esc(i.kind)}</span></td><td>${esc(i.title)}${i.route ? ` <a href="${esc(i.route)}">open</a>` : ''}</td><td><button class="act secondary" data-act="close-item" data-arg="${esc(i.itemId)}">Done</button></td></tr>`).join('')}</table></div>`);
    }
    if (!q && !inbox.length) {
      const working = this._working();
      parts.push(`<div class="card"><h2>Nothing waits for you</h2><div class="muted">${working ? working + '…' : this._goalUndefined(c) ? 'The product goal is not defined yet; the product manager asks for it first.' : 'Ask the product manager for the next roadmap step, or open a team.'}</div>
        <div class="row"><button class="act" data-act="start-iteration" ${working || this._paused() ? 'disabled' : ''}>Ask for the next step</button></div></div>`);
    }
    return `<div class="grid">${parts.join('')}</div>`;
  }

  _roadmapTab() {
    const q = this._openQuestion(); const rows = newest(props(this._s.roadmap), 'at');
    const pill = (s) => `<span class="pill ${s === 'allocated' || s === 'released' ? 'ok' : s === 'waiting-for-team' ? 'warn' : ''}">${esc(s)}</span>`;
    return `<div class="grid">${q ? this._questionCard(q) : `<div class="card"><h2>Next step</h2><div class="muted">${this._working() ? this._working() + '…' : 'No open question.'}</div><div class="row"><button class="act" data-act="start-iteration" ${this._working() || this._paused() ? 'disabled' : ''}>Ask for the next step</button></div></div>`}
      <div class="card"><h2>Roadmap <span class="pill">${rows.length}</span></h2>${rows.length ? `<table>${rows.map((r) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(r.at))}</td><td>${esc(r.service)}</td><td>${esc(r.direction)}${r.teamIteration ? `<div class="muted mono">${esc(r.teamIteration)}</div>` : ''}</td><td>${pill(r.status)}</td></tr>`).join('')}</table>` : '<div class="muted">Empty. Every answered proposal becomes a roadmap item and an iteration for a team.</div>'}</div>
      <div class="card"><h2>Ideas</h2><div class="muted">A service, a feature, a quality the product should gain; the product manager serves open ideas before inventing.</div>
        ${this._field('idea.text', 'Your idea', '', 'textarea')}${this._field('idea.service', 'Service (optional)', '')}<div class="row"><button class="act" data-act="add-idea">Give the product manager this idea</button></div>
        ${this._ideas().length ? `<table>${this._ideas().slice(0, 20).map((i) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(i.at))}</td><td>${esc(i.text)} <span class="muted">(${esc(i.by)}${i.service ? ', ' + esc(i.service) : ''})</span></td><td><span class="pill ${i.status === 'taken' ? 'ok' : i.status === 'dropped' ? 'bad' : 'warn'}">${esc(i.status)}</span>${i.status === 'open' ? ` <button class="act secondary" data-act="drop-idea" data-arg="${esc(i.ideaId)}">Drop</button>` : ''}</td></tr>`).join('')}</table>` : ''}</div>
    </div>`;
  }

  _teamsTab() {
    const teams = this._teams(); const c = this._charter();
    const wanted = arr(c.services).filter((s) => !teams.some((t) => t.service === s));
    return `<div class="grid">${teams.map((t) => { const s = this._statusOf(t.service); const items = this._inbox().filter((i) => i.service === t.service); return `<div class="card"><h2>${esc(t.service)} <span class="pill">${esc(t.session)}</span> ${s ? `<span class="pill ${String(s.audit || '').startsWith('red') ? 'bad' : 'ok'}">${esc(s.phase || 'idle')}</span>` : '<span class="pill">no status yet</span>'}</h2>
        <div class="muted">${esc(s?.summary || 'The team has not reported yet.')}</div>
        <table><tr><th>Iteration</th><td>${esc(s?.iterationId || '')}</td></tr><tr><th>Last release</th><td>${esc(s?.lastRelease || 'none')}</td></tr><tr><th>Audit</th><td>${esc(s?.audit || '')}</td></tr><tr><th>Waiting for you</th><td>${items.length}</td></tr><tr><th>Repository</th><td class="mono">${esc(t.repo || '')}</td></tr></table>
        <div class="row"><a href="${esc(this._teamRoute(t))}">Open the ${esc(t.service)} team app</a></div></div>`; }).join('')}
      ${wanted.length ? `<div class="card"><h2>Services without a team</h2><ul>${wanted.map((s) => `<li>${esc(s)}: install the service-team pack into session <span class="mono">${esc(s)}</span> and provision it; it registers itself here</li>`).join('')}</ul></div>` : ''}
      ${!teams.length && !wanted.length ? '<div class="card"><div class="muted">No teams. List the services in Product, then install a service-team pack per service.</div></div>' : ''}
    </div>`;
  }

  _productTab() {
    const c = this._charter(), infra = this._infra(), tools = obj(infra?.tools), mcp = obj(infra?.mcp), repos = obj(infra?.repos);
    const coders = props(this._s.coders).filter((x) => x.agentId); const coderId = this._form['c.coderAgent'] ?? c.coderAgent ?? 'claude-code';
    return `<div class="grid">
      <div class="card"><h2>Product ${this._goalUndefined(c) ? '<span class="pill warn">goal not defined</span>' : '<span class="pill ok">goal defined</span>'}</h2>
        ${this._field('c.product', 'Product name', c.product)}${this._field('c.goal', 'Goal for this period, one line', this._goalUndefined(c) ? '' : c.goal)}${this._field('c.description', 'Who it serves, what it must do, what it must never do', c.description, 'textarea')}
        ${this._field('c.principles', 'Principles (one per line; every team reads them)', arr(c.principles).join('\n'), 'textarea')}${this._field('c.constraints', 'Constraints (one per line)', arr(c.constraints).join('\n'), 'textarea')}
        ${this._field('c.services', 'Services the product consists of (one per line; a team per service)', arr(c.services).join('\n'), 'textarea')}
        ${this._select('c.autonomyLevel', 'Default autonomy level for teams', c.autonomyLevel || '3', [['1', '1: observe only'], ['2', '2: propose only'], ['3', '3: apply with approval (default)'], ['4', '4: small changes alone'], ['5', '5: also refactors alone']])}
        ${this._field('c.dailyBudgetUsd', 'Daily budget (USD) per team', c.dailyBudgetUsd)}${this._field('c.digestCron', 'Digest schedule (6-field cron, Europe/Berlin)', c.digestCron)}
        <div class="row"><button class="act" data-act="set-charter">Save product</button><span class="muted">${c.updatedAt ? 'saved ' + esc(when(c.updatedAt)) : 'seeded, not saved yet'}</span></div></div>
      <div class="card"><h2>Coder and repositories</h2>
        <label>Coding agent (every team uses it unless its own charter overrides)</label><select data-f="c.coderAgent">${coders.map((x) => `<option value="${esc(x.agentId)}" ${coderId === x.agentId ? 'selected' : ''}>${esc(x.title || x.agentId)}</option>`).join('')}</select>
        ${this._field('c.coderModel', 'Model (empty = the agent default)', c.coderModel)}${this._field('c.coderMaxTurns', 'Max turns', c.coderMaxTurns)}${this._field('c.coderTimeoutMin', 'Timeout in minutes', c.coderTimeoutMin)}
        <label>The brain's curator</label><select data-f="c.brainAgent"><option value="llm" ${(this._form['c.brainAgent'] ?? c.brainAgent ?? 'llm') === 'llm' ? 'selected' : ''}>One-shot model call</option>${coders.map((x) => `<option value="${esc(x.agentId)}" ${(this._form['c.brainAgent'] ?? c.brainAgent) === x.agentId ? 'selected' : ''}>${esc(x.title || x.agentId)}, headless</option>`).join('')}</select>
        ${this._field('c.repoRoot', 'Workspace root holding core, agentic-nets and ci', c.repoRoot)}${this._field('c.home', 'Working directory for the teams on the executor host', c.home)}${this._field('c.mcpUrl', 'Agentic-Nets MCP endpoint', c.mcpUrl)}
        <div class="row"><button class="act" data-act="set-charter">Save coder and repositories</button></div></div>
      <div class="card"><h2>Infrastructure ${infra ? `<span class="pill ${isTrue(infra.ok) ? 'ok' : 'bad'}">${isTrue(infra.ok) ? 'ok' : 'problems'}</span>` : ''} ${this._paused() ? '<span class="pill bad">paused</span>' : ''}</h2>
        ${infra ? `<div class="muted">measured ${esc(when(infra.at))}</div><table><tr><th>Coding agents</th><td>claude ${tools.claude ? esc(tools.claude) : '✗'} · codex ${tools.codex ? esc(tools.codex) : '✗'}</td></tr><tr><th>Toolchain</th><td>node ${esc(tools.node || '✗')} · git ${esc(tools.git || '✗')} · mvn ${esc(tools.mvn || '✗')}</td></tr><tr><th>MCP</th><td>${esc(mcp.url || '')} ${mcp.ready === true || isTrue(mcp.ready) ? '<span class="pill ok">ready</span>' : '<span class="pill bad">not ready</span>'}</td></tr><tr><th>Repositories</th><td>${Object.entries(repos).map(([k, v]) => `${esc(k)} ${v === true || isTrue(v) ? '✓' : '✗'}`).join(' · ') || '?'}</td></tr><tr><th>Teams</th><td>${esc(arr(infra.teams).join(', ') || 'none')}</td></tr></table>${arr(infra.problems).length ? `<ul>${arr(infra.problems).map((p) => `<li class="muted">${esc(p)}</li>`).join('')}</ul>` : ''}` : '<div class="muted">Not measured yet.</div>'}
        <div class="row"><button class="act secondary" data-act="check-infra">Check infrastructure</button><button class="act" data-act="provision">Provision (MCP token)</button>${this._paused() ? '<button class="act" data-act="resume">Resume</button>' : '<button class="act danger" data-act="pause">Pause the office</button>'}</div></div>
    </div>`;
  }

  _brainTab() {
    const plan = newest(props(this._s.plan), 'at')[0] || null;
    const facts = props(this._s.knowledge).filter((f) => f.status === 'active').sort((a, b) => String(a.factId).localeCompare(String(b.factId)));
    const adrs = this._adrs(); const kinds = ['decision', 'answer', 'convention', 'platform', 'gap', 'risk', 'question'];
    const apill = (s) => `<span class="pill ${s === 'accepted' ? 'ok' : s === 'rejected' || s === 'superseded' ? 'bad' : 'warn'}">${esc(s)}</span>`;
    return `<div class="grid">
      <div class="card"><h2>The plan across teams ${plan ? `<span class="muted">curated ${esc(when(plan.at))}</span>` : ''}</h2>${plan ? `<div class="muted">${esc(plan.summary || '')}</div><table>${arr(plan.increments).map((i) => `<tr><td>${esc(i.id)}</td><td>${esc(i.title)}</td><td>${esc(i.service || '')}</td><td><span class="pill">${esc(i.status)}</span></td></tr>`).join('')}</table>` : '<div class="muted">No plan yet. The brain writes one after the first release a team reports.</div>'}<div class="row"><button class="act secondary" data-act="curate-now">Curate now</button></div></div>
      <div class="card"><h2>What the office knows <span class="pill">${facts.length} active</span></h2>${facts.length ? kinds.filter((k) => facts.some((f) => f.kind === k)).map((k) => `<h3>${esc(k)}</h3><ul>${facts.filter((f) => f.kind === k).map((f) => `<li>${esc(f.text)} <span class="muted">(${esc(f.scope)}, ${esc(f.confidence)}, ${esc(f.source)})</span></li>`).join('')}</ul>`).join('') : '<div class="muted">Nothing curated yet.</div>'}</div>
      <div class="card"><h2>Decisions</h2>${adrs.length ? adrs.map((a) => `<details ${a.status === 'proposed' ? 'open' : ''}><summary><b>${esc(a.adrId)}</b> ${esc(a.title)} ${apill(a.status)}</summary><div class="muted">Context</div><div>${esc(a.context || '')}</div><div class="muted">Decision</div><div>${esc(a.decision || '')}</div><div class="muted">Consequences</div><div>${esc(a.consequences || '')}</div>
        <div class="row">${a.status !== 'accepted' ? `<button class="act" data-act="adr-accept" data-arg="${esc(a.adrId)}">Accept</button>` : `<button class="act secondary" data-act="adr-supersede" data-arg="${esc(a.adrId)}">Supersede</button>`}${a.status === 'proposed' ? `<button class="act secondary" data-act="adr-reject" data-arg="${esc(a.adrId)}">Reject</button>` : ''}</div></details>`).join('') : '<div class="muted">None yet. Product-level decisions bind every team.</div>'}</div>
    </div>`;
  }

  _digestTab() {
    const rows = newest(props(this._s.digest), 'at').slice(0, 10);
    return `<div class="grid"><div class="card"><h2>Digest</h2>${rows.length ? rows.map((d) => `<details ${d === rows[0] ? 'open' : ''}><summary>${esc(when(d.at))} · ${esc(d.summary)}</summary><table><tr><th>Team</th><th>Phase</th><th>Iteration</th><th>Last release</th><th>Audit</th><th>Waiting</th></tr>${arr(d.teams).map((t) => `<tr><td>${esc(t.service)}</td><td>${esc(t.phase)}</td><td>${esc(t.iteration)}</td><td>${esc(t.lastRelease)}</td><td>${esc(t.audit)}</td><td>${esc(t.openItems)}</td></tr>`).join('')}</table></details>`).join('') : '<div class="muted">No digest yet.</div>'}<div class="row"><button class="act secondary" data-act="digest-now">Digest now</button></div></div>
      ${newest(props(this._s.errors), 'at').length ? `<div class="card"><h2>Errors</h2>${newest(props(this._s.errors), 'at').slice(0, 8).map((e) => `<div><span class="muted">${esc(when(e.at))} ${esc(e.lane)}/${esc(e.stage)}</span> ${esc(e.message)}</div>`).join('')}</div>` : ''}</div>`;
  }

  _journalTab() { const rows = newest(props(this._s.journal), 'at').slice(0, 150); return `<div class="card"><h2>Journal</h2>${rows.length ? `<table>${rows.map((j) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(j.at))}</td><td class="muted">${esc(j.stage)}</td><td>${esc(j.summary)}</td></tr>`).join('')}</table>` : '<div class="muted">Empty.</div>'}</div>`; }

  // ---- actions ---------------------------------------------------------------------------------
  async _onAct(act, arg) {
    const at = nowIso(); const f = (k) => String(this._form[k] ?? '').trim(); const c = this._charter();
    switch (act) {
      case 'check-infra': case 'provision': case 'pause': case 'resume': case 'digest-now': case 'curate-now': return this._invoke(act, {}, act);
      case 'set-charter': {
        const input = { updatedAt: at, status: 'ready' };
        for (const k of CHARTER_KEYS) { const raw = this._form['c.' + k]; if (LIST_KEYS.includes(k)) input[k] = raw !== undefined ? linesOf(raw) : arr(c[k]); else input[k] = raw !== undefined ? String(raw).trim() : String(c[k] ?? (k === 'coderAgent' ? 'claude-code' : k === 'brainAgent' ? 'llm' : k === 'autonomyLevel' ? '3' : '')); }
        if (input.goal && /REPLACE.?ME/i.test(input.goal)) input.goal = '';
        if (!input.goal) input.goal = this._goalUndefined(c) ? 'REPLACE ME' : c.goal;
        if (arr(c.tokenLanes).length) input.tokenLanes = arr(c.tokenLanes); if (c.notes) input.notes = c.notes;
        return this._invoke('set-charter', input, act);
      }
      case 'start-iteration': return this._invoke('start-iteration', { iterationId: `it-${stamp()}`, at, reason: 'app' }, act);
      case 'respond': case 'revise': case 'skip': {
        const p = this._openQuestion(); if (!p) return;
        const intent = act === 'respond' ? (p.kind === 'brain' ? 'knowledge' : 'answer') : 'revise';
        let selected = arr(this._form.__selected || '[]'); let text = f('resp.text');
        if (act === 'skip') { text = ['Skip this; propose something different.', text].filter(Boolean).join(' '); selected = []; }
        if (p.mode === 'interview' && intent !== 'revise') { const answers = arr(p.options).map((o) => { const v = f('q.' + o.value); return v ? `${o.label}: ${v}` : ''; }).filter(Boolean); if (!answers.length && !text) return this._toast('Answer at least one question', true); text = [...answers, text].filter(Boolean).join('\n'); selected = arr(p.options).filter((o) => f('q.' + o.value)).map((o) => o.value); }
        if (intent === 'answer' && p.mode === 'choice' && !selected.length && !text) return this._toast('Pick an option or write your own', true);
        if (act === 'revise' && !text) return this._toast('Say how the question should be reshaped', true);
        if (intent === 'answer' && p.mode === 'goal' && this._goalUndefined(c) && !text) return this._toast('Write the product goal here or in Product', true);
        if (intent === 'answer' && p.mode === 'goal' && text && this._goalUndefined(c)) {
          const [first, ...rest] = text.split('\n'); const input = { updatedAt: at, status: 'ready', goal: first.trim(), description: rest.join('\n').trim() || c.description || '' };
          for (const k of CHARTER_KEYS) if (!(k in input)) input[k] = LIST_KEYS.includes(k) ? arr(c[k]) : String(c[k] ?? ''); if (arr(c.tokenLanes).length) input.tokenLanes = arr(c.tokenLanes);
          await this._invoke('set-charter', input, 'set-charter');
        }
        const r = await this._invoke('respond', { promptId: p.promptId, iterationId: p.iterationId, intent, selected: selected.join(','), text, notes: f('resp.notes'), at }, act);
        this._form.__selected = '[]'; this._form['resp.text'] = ''; this._form['resp.notes'] = ''; return r;
      }
      case 'add-idea': { if (!f('idea.text')) return this._toast('Write the idea first', true); const ideaId = `idea-${String(this._ideas().length + 1).padStart(3, '0')}`; const r = await this._invoke('add-idea', { ideaId, text: f('idea.text'), service: f('idea.service'), at }, act); this._form['idea.text'] = ''; return r; }
      case 'drop-idea': { const i = this._ideas().find((x) => x.ideaId === arg); if (!i) return; return this._invoke('drop-idea', { ideaId: i.ideaId, text: i.text, by: i.by || 'person', at }, act + arg); }
      case 'close-item': { const i = this._inbox().find((x) => x.itemId === arg); if (!i) return; return this._invoke('close-inbox-item', { itemId: i.itemId, title: i.title, service: i.service || '', persona: i.persona || '', kind: i.kind || '', route: i.route || '', at: i.at, doneAt: at }, act + arg); }
      case 'adr-accept': case 'adr-reject': case 'adr-supersede': { const a = this._adrs().find((x) => x.adrId === arg); if (!a) return; const status = { 'adr-accept': 'accepted', 'adr-reject': 'rejected', 'adr-supersede': 'superseded' }[act]; return this._invoke('decide-adr', { adrId: a.adrId, title: a.title, context: a.context || '', decision: a.decision, consequences: a.consequences || '', status, updatedAt: at }, act + arg); }
      default: return undefined;
    }
  }
}

if (!customElements.get('agenticos-product-office-v1')) customElements.define('agenticos-product-office-v1', ProductOfficeApp);
export default ProductOfficeApp;
