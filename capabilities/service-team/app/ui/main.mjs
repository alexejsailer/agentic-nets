/**
 * Service team: the application of one service team (trusted-element web component, self-contained ESM).
 *
 * Tabs: Now (everything waiting for you: questions, spec approvals, context packs, merges), Product owner
 * (requirements, iterations, ideas), Architect (spec catalog mirroring the code, specs, decisions), QA (acceptance,
 * verifications, readiness, bugs), Developer (runs, reviews, branches), Brain, Setup, Journal. Everything shown is
 * read from stores through the runtime bridge; every button writes a token through a declared action. Nothing here
 * computes a number a script did not measure. Token properties arrive as STRINGS; nested structures as JSON text.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const arr = (v) => { if (Array.isArray(v)) return v; if (typeof v !== 'string' || !v.trim()) return []; try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } };
const obj = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) return v; if (typeof v !== 'string' || !v.trim()) return {}; try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; } };
const isTrue = (v) => String(v ?? '').toLowerCase() === 'true';
const when = (s) => { if (!s) return ''; const d = new Date(String(s)); return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const props = (tokens) => (tokens || []).map((t) => t.properties || {});
const newest = (rows, field) => [...rows].sort((a, b) => String(b[field] ?? '').localeCompare(String(a[field] ?? '')));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const stamp = () => nowIso().replace(/[-:]/g, '').replace('T', '');
const atKey = (v) => { const t = String(v || ''); return t.includes('.') ? t : t.replace('Z', '.000Z'); };
const atMs = () => new Date().toISOString();
const planKey = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const linesOf = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
const list = (v) => { const a = arr(v); return a.length ? `<ul>${a.map((x) => `<li>${esc(typeof x === 'object' ? JSON.stringify(x) : x)}</li>`).join('')}</ul>` : '<span class="muted">none</span>'; };
async function idempotencyKey(action, input) {
  const canon = JSON.stringify({ action, input }, Object.keys(input).sort().concat('action', 'input'));
  try { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon)); return `${action}:${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`; }
  catch { return `${action}:${crypto.randomUUID()}`; }
}

const CSS = `
:host { display: block; container-type: inline-size; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  --fg: #1c1f24; --muted: #5d6673; --panel: #ffffff; --edge: #dfe3e8; --card: #f6f7f9; --accent: #1d4ed8; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --bg: #f0f2f5; }
@media (prefers-color-scheme: dark) { :host { --fg: #e6e6e6; --muted: #9aa1ab; --panel: #16181d; --edge: #2a2d34; --card: #1d2026; --accent: #60a5fa; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --bg: #0f1115; } }
.wrap { color: var(--fg); background: var(--bg); padding: 12px; min-height: 100%; box-sizing: border-box; }
header { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: baseline; padding: 6px 4px 10px; }
header h1 { font-size: 20px; margin: 0; } header .status { color: var(--muted); font-size: 13px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
nav button { background: var(--panel); border: 1px solid var(--edge); color: var(--fg); padding: 6px 12px; border-radius: 16px; cursor: pointer; }
nav button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
nav button .n { display: inline-block; min-width: 18px; text-align: center; background: var(--accent); color: #fff; border-radius: 9px; font-size: 11px; margin-left: 6px; padding: 0 5px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--edge); border-radius: 10px; padding: 12px 14px; } .card.wide { grid-column: 1 / -1; }
.card h2 { font-size: 15px; margin: 0 0 8px; } .card h3 { font-size: 13px; margin: 12px 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.muted { color: var(--muted); } .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
button.act { background: var(--accent); color: #fff; border: 0; padding: 7px 12px; border-radius: 6px; cursor: pointer; font-weight: 600; }
button.act.secondary { background: var(--card); color: var(--fg); border: 1px solid var(--edge); } button.act.danger { background: var(--bad); } button.act:disabled { opacity: .5; cursor: default; }
input, textarea, select { width: 100%; box-sizing: border-box; background: var(--card); color: var(--fg); border: 1px solid var(--edge); border-radius: 6px; padding: 6px 8px; font: inherit; }
textarea { min-height: 70px; resize: vertical; } label { display: block; font-size: 12px; color: var(--muted); margin-top: 8px; }
.opt { border: 1px solid var(--edge); border-radius: 8px; padding: 10px 12px; margin-top: 8px; background: var(--card); cursor: pointer; } .opt.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; } .opt .t { font-weight: 600; }
.pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--edge); color: var(--muted); margin-left: 6px; }
.pill.ok { color: var(--ok); border-color: var(--ok); } .pill.warn { color: var(--warn); border-color: var(--warn); } .pill.bad { color: var(--bad); border-color: var(--bad); } .pill.rec { color: var(--accent); border-color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; } td, th { overflow-wrap: anywhere; word-break: break-word; } td, th { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--edge); vertical-align: top; } th { color: var(--muted); font-weight: 600; }
ul { margin: 4px 0; padding-left: 18px; } li { margin: 2px 0; }
.toast { position: fixed; right: 16px; bottom: 16px; background: var(--fg); color: var(--bg); padding: 8px 12px; border-radius: 8px; z-index: 9; max-width: 60ch; } .toast.err { background: var(--bad); color: #fff; }
details summary { cursor: pointer; color: var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; }
.empty { color: var(--muted); padding: 24px; text-align: center; } .banner { border-left: 4px solid var(--warn); background: var(--card); padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; }
.tree { font-size: 13px; } .tree .mod { padding: 3px 0 3px 12px; border-left: 2px solid var(--edge); margin: 2px 0 2px 6px; } .tree .mod .p { font-family: ui-monospace, Menlo, monospace; }
a { color: var(--accent); }
`;

const ROLES = ['charter', 'coders', 'iterate', 'prompts', 'responses', 'requirements', 'specs', 'spec-catalog', 'adr', 'arch', 'acceptance', 'verification', 'scorecard', 'bugs', 'briefs', 'runs', 'reviews', 'decisions', 'refused', 'state', 'ideas', 'knowledge', 'plan', 'backlog', 'journal', 'errors', 'llm-errors', 'infra', 'status'];
const CHARTER_KEYS = ['service', 'goal', 'description', 'repo', 'repoDir', 'repoMode', 'scopePaths', 'testCommand', 'buildCommand', 'readinessChecks', 'auditCron', 'coderAgent', 'coderModel', 'coderMaxTurns', 'coderTimeoutMin', 'coderAllowedTools', 'brainAgent', 'autonomyLevel', 'dailyBudgetUsd', 'notes'];
const LIST_KEYS = ['scopePaths', 'readinessChecks'];
const PERSONA = { proposal: 'product owner', 'spec-approval': 'architect', 'pack-approval': 'architect', merge: 'developer', brain: 'brain' };

class ServiceTeamApp extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }); this._s = {}; this._tab = 'now'; this._form = {}; this._busy = new Set(); this._unsubs = []; this._open = new Set(); }
  set runtime(rt) { this._rt = rt; if (this.isConnected) this._boot(); }
  get runtime() { return this._rt; }
  connectedCallback() { if (this._rt) this._boot(); }
  disconnectedCallback() { for (const u of this._unsubs.splice(0)) { try { u(); } catch { /* gone */ } } clearInterval(this._timer); }

  async _boot() {
    this.shadowRoot.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="empty">Loading the team…</div></div>`;
    await this._load(ROLES);
    for (const role of ['prompts', 'requirements', 'specs', 'acceptance', 'verification', 'runs', 'reviews', 'decisions', 'journal', 'status', 'bugs', 'scorecard', 'infra', 'state', 'spec-catalog']) {
      try { this._unsubs.push(this._rt.watchStore(role, (ev) => { this._s[role] = ev.tokens; this._render(); }, 15000)); } catch { /* covered by the sweep */ }
    }
    this._timer = setInterval(() => this._load(['charter', 'coders', 'responses', 'adr', 'arch', 'ideas', 'knowledge', 'plan', 'errors', 'llm-errors', 'iterate', 'briefs', 'refused']), 30000);
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
  _toast(msg, err) { const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg; this.shadowRoot.appendChild(el); setTimeout(() => el.remove(), 3500); }

  // ---- data ------------------------------------------------------------------------------------
  _charter() { const rows = props(this._s.charter).filter((c) => c.charterId === 'team' || !c.charterId); return newest(rows, 'updatedAt')[0] || {}; }
  _goalUndefined(c) { return !c.goal || /REPLACE.?ME/i.test(String(c.goal)); }
  _byId(role, key) { const rows = props(this._s[role]).map((r) => ({ ...r, __t: String(r.updatedAt || r.finishedAt || r.at || '') })); const by = new Map(); for (const r of newest(rows, '__t').reverse()) if (r[key]) by.set(r[key], r); return [...by.values()]; }
  _requirements() { return newest(this._byId('requirements', 'requirementId'), 'at'); }
  _specs() { return newest(this._byId('specs', 'specId'), 'at'); }
  _runs() { return newest(this._byId('runs', 'runId'), 'at'); }
  _bugs() { return newest(this._byId('bugs', 'bugId'), 'at'); }
  _adrs() { return this._byId('adr', 'adrId').sort((a, b) => String(a.adrId).localeCompare(String(b.adrId))); }
  _ideas() { return newest(this._byId('ideas', 'ideaId'), 'at'); }
  _openPrompts() {
    const answered = new Set(props(this._s.responses).map((r) => r.promptId));
    const decided = new Set(props(this._s.decisions).map((d) => d.promptId));
    const by = new Map();
    for (const p of newest(props(this._s.prompts), 'at').reverse()) if (p.promptId && !answered.has(p.promptId) && !decided.has(p.promptId)) by.set(p.promptId, p);
    return newest([...by.values()], 'at');
  }
  _infra() { return newest(props(this._s.infra).filter((i) => i.kind !== 'pause'), 'at')[0] || null; }
  _paused() { const r = newest(props(this._s.infra).filter((i) => i.kind === 'pause'), 'at')[0]; return !!r && r.state === 'paused'; }
  _working() {
    if (props(this._s.iterate).length) return 'The product owner is preparing the next proposal';
    const run = this._runs().find((r) => r.status === 'coding'); if (run) return `The coder is working on ${run.specId}`;
    const j = newest(props(this._s.journal), 'at')[0];
    if (j && Date.now() - new Date(j.at).getTime() < 8 * 60 * 1000 && /brief|state|verify|pack|catalog/.test(String(j.stage))) return `${j.lane?.replace(/^t-.*-team-/, '') || 'a lane'}: ${j.stage}`;
    return '';
  }

  // ---- render ----------------------------------------------------------------------------------
  _render() {
    const root = this.shadowRoot;
    const c = this._charter(), open = this._openPrompts();
    const status = [this._paused() ? 'PAUSED' : '', `${this._requirements().length} requirements`, `${this._specs().length} specs`, `${open.length} waiting for you`, this._working()].filter(Boolean).join(' · ');
    const tabs = [['now', 'Now'], ['po', 'Product owner'], ['arch', 'Architect'], ['qa', 'QA'], ['dev', 'Developer'], ['brain', 'Brain'], ['setup', 'Setup'], ['journal', 'Journal']];
    const body = { now: this._nowTab, po: this._poTab, arch: this._archTab, qa: this._qaTab, dev: this._devTab, brain: this._brainTab, setup: this._setupTab, journal: this._journalTab }[this._tab].call(this);
    root.innerHTML = `<style>${CSS}</style><div class="wrap">
      <header><h1>${esc(c.service && !/REPLACE/.test(c.service) ? c.service + ' team' : 'Service team')}</h1><span class="status">${esc(status)}</span></header>
      <nav>${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === this._tab ? 'on' : ''}">${l}${k === 'now' && open.length ? `<span class="n">${open.length}</span>` : ''}</button>`).join('')}</nav>
      ${this._paused() ? '<div class="banner">The team is paused. Resume it in Setup.</div>' : ''}
      ${body}</div>`;
    root.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { this._tab = b.dataset.tab; this._render(); }));
    root.querySelectorAll('details').forEach((d) => { const k = this._tab + '|' + (d.querySelector('summary')?.textContent || '').trim().slice(0, 120); if (this._open.has(k)) d.open = true; else if (d.open) this._open.add(k); d.addEventListener('toggle', () => { if (d.open) this._open.add(k); else this._open.delete(k); }); });
    root.querySelectorAll('[data-f]').forEach((el) => { el.addEventListener('input', () => { this._form[el.dataset.f] = el.value; }); if (el.tagName === 'SELECT') el.addEventListener('change', () => { this._form[el.dataset.f] = el.value; }); });
    root.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => this._onAct(el.dataset.act, el.dataset.arg)));
    root.querySelectorAll('.opt[data-opt]').forEach((el) => el.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT') return;
      const key = '__selected.' + el.dataset.prompt; const multi = el.dataset.multi === 'true'; const cur = new Set(arr(this._form[key] || '[]'));
      if (multi) { cur.has(el.dataset.opt) ? cur.delete(el.dataset.opt) : cur.add(el.dataset.opt); } else { cur.clear(); cur.add(el.dataset.opt); }
      this._form[key] = JSON.stringify([...cur]); this._render();
    }));
  }
  _field(name, label, value, kind = 'input', ph = '') { const v = this._form[name] ?? value ?? ''; return `<label>${esc(label)}</label>${kind === 'textarea' ? `<textarea data-f="${name}" placeholder="${esc(ph)}">${esc(v)}</textarea>` : `<input data-f="${name}" value="${esc(v)}" placeholder="${esc(ph)}">`}`; }
  _select(name, label, value, options) { const v = this._form[name] ?? value ?? ''; return `<label>${esc(label)}</label><select data-f="${name}">${options.map(([val, lab]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`; }
  _spill(s) { return `<span class="pill ${['approved', 'verified', 'merged', 'done', 'released', 'pass', 'built', 'approve'].includes(s) ? 'ok' : ['rejected', 'failed', 'fail', 'merge-failed', 'changes'].includes(s) ? 'bad' : ['draft', 'designing', 'coding', 'reviewed', 'implemented'].includes(s) ? 'warn' : ''}">${esc(s || '')}</span>`; }

  _promptCard(p) {
    const kind = String(p.kind || 'proposal'), mode = String(p.mode || 'choice'), options = arr(p.options), selected = new Set(arr(this._form['__selected.' + p.promptId] || '[]'));
    const title = { proposal: mode === 'goal' ? 'The product owner needs the team goal' : mode === 'interview' ? 'The product owner has questions' : 'The product owner proposes the next requirement', 'spec-approval': 'The architect asks you to approve a spec', 'pack-approval': 'The architect asks you to start the coder', merge: 'The developer asks you to merge', brain: 'The brain has a question' }[kind] || 'A question';
    const decision = kind === 'spec-approval' || kind === 'pack-approval' || kind === 'merge';
    const buttons = kind === 'spec-approval' ? [['approve-spec', 'Approve the spec', ''], ['changes-spec', 'Send back with notes', 'secondary'], ['reject-spec', 'Reject', 'danger']]
      : kind === 'pack-approval' ? [['approve-pack', 'Start the coder', ''], ['reject-pack', 'Not now', 'secondary']]
      : kind === 'merge' ? [['merge', 'Merge', ''], ['request-changes', 'Request changes', 'secondary'], ['reject-run', 'Drop the run', 'danger']]
      : [['respond', 'Answer', ''], ['revise', 'Reshape the question', 'secondary'], ['skip', 'Skip, propose something else', 'secondary']];
    return `<div class="card"><h2>${title} <span class="pill">${esc(PERSONA[kind] || kind)}</span><span class="pill">${esc(p.promptId)}</span></h2>
      <div>${esc(p.question)}</div>${p.context ? `<div class="muted" style="margin-top:6px">${esc(p.context)}</div>` : ''}
      ${p.summary ? `<details open><summary>Details</summary><div class="mono">${esc(p.summary)}</div></details>` : ''}
      ${!decision ? options.map((o) => mode === 'interview'
        ? `<div class="opt" data-opt="${esc(o.value)}" data-prompt="${esc(p.promptId)}" data-multi="true"><div class="t">${esc(o.label)}</div><div class="muted">${esc(o.description || '')}</div>${this._field('q.' + p.promptId + '.' + o.value, 'Your answer', '', 'textarea')}</div>`
        : `<div class="opt ${selected.has(String(o.value)) ? 'sel' : ''}" data-opt="${esc(o.value)}" data-prompt="${esc(p.promptId)}" data-multi="false"><div class="t">${esc(o.label)} ${isTrue(o.recommended) ? '<span class="pill rec">recommended</span>' : ''} ${o.kind ? `<span class="pill">${esc(o.kind)}</span>` : ''} ${o.effort ? `<span class="pill">effort ${esc(o.effort)}</span>` : ''} ${o.risk ? `<span class="pill">risk ${esc(o.risk)}</span>` : ''}</div><div class="muted">${esc(o.description || '')}</div>${o.module ? `<div class="muted mono">${esc(o.module)}</div>` : ''}${arr(o.evidence).length ? `<details><summary>evidence</summary>${list(o.evidence)}</details>` : ''}</div>`).join('') : ''}
      ${!decision ? this._field('resp.' + p.promptId, mode === 'goal' ? 'The team goal (one line, then a paragraph)' : 'Your own words (optional)', '', 'textarea') : ''}
      ${this._field('notes.' + p.promptId, decision ? 'Notes for the team (optional; required when sending back)' : 'Notes for the team (optional)', '')}
      ${p.rationale ? `<details><summary>Why</summary><div>${esc(p.rationale)}</div></details>` : ''}
      <div class="row">${buttons.map(([a, l, cls]) => `<button class="act ${cls}" data-act="${a}" data-arg="${esc(p.promptId)}">${l}</button>`).join('')}</div></div>`;
  }

  _nowTab() {
    const open = this._openPrompts(), c = this._charter();
    const parts = open.map((p) => this._promptCard(p));
    const running = this._runs().filter((r) => ['coding', 'built', 'verified'].includes(r.status));
    if (running.length) parts.push(`<div class="card"><h2>In progress</h2><table>${running.map((r) => `<tr><td>${esc(r.runId)}</td><td>${esc(r.specId)}</td><td>${this._spill(r.status)}</td><td class="muted">${esc(r.branch)}</td></tr>`).join('')}</table></div>`);
    if (!open.length) {
      const working = this._working();
      parts.push(`<div class="card"><h2>Nothing waits for you</h2><div class="muted">${working ? working + '…' : this._goalUndefined(c) ? 'The team goal is not defined; the product owner asks for it first.' : 'Ask the product owner for the next requirement, or wait for the product office to allocate one.'}</div>
        ${this._field('it.direction', 'Direction for this iteration (optional)', '')}
        <div class="row"><button class="act" data-act="start-iteration" ${working || this._paused() ? 'disabled' : ''}>Ask for the next requirement</button></div></div>`);
    }
    return `<div class="grid">${parts.join('')}</div>`;
  }

  _poTab() {
    const reqs = this._requirements(), st = newest(props(this._s.state), 'at')[0], a = obj(st?.analysis), m = obj(st?.measured), c = this._charter();
    return `<div class="grid">
      <div class="card wide"><h2>Requirements <span class="pill">${reqs.length}</span></h2>${reqs.length ? reqs.map((r) => `<details><summary><b>${esc(r.requirementId)}</b> ${esc(r.title)} ${this._spill(r.status)} <span class="pill">${esc(r.kind)}</span> <span class="pill">${esc(r.priority)}</span>${r.specId ? `<span class="pill">${esc(r.specId)}</span>` : ''}</summary>
        <div>${esc(r.story)}</div><div class="muted" style="margin-top:6px">${esc(r.summary)}</div><h3>Done when</h3>${list(r.done)}<h3>Scope</h3>${list(r.scope)}<h3>Out of scope</h3>${list(r.outOfScope)}<h3>Risks</h3>${list(r.risks)}<div class="muted mono">module ${esc(r.module)} · ${esc(when(r.at))}</div></details>`).join('') : '<div class="muted">No requirements yet. The product owner proposes them; you choose.</div>'}</div>
      <div class="card"><h2>The module ${st ? `<span class="muted">measured ${esc(when(st.at))} at ${esc(String(st.head || '').slice(0, 10))}</span>` : ''}</h2>
        ${st ? `<div>${esc(a.summary || '')}</div><table><tr><th>Files</th><td>${esc(m.files)} (${Object.entries(obj(m.byExt)).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ')})</td></tr><tr><th>Test files</th><td>${esc(m.tests)}</td></tr><tr><th>Entry points</th><td>${esc(arr(a.entryPoints).join(', '))}</td></tr></table><h3>Debt</h3>${list(a.debt)}<h3>Looks ready</h3>${list(a.health)}` : '<div class="muted">Not measured yet.</div>'}
        <div class="row"><button class="act secondary" data-act="measure-state">Measure the module again</button></div></div>
      <div class="card"><h2>Ideas</h2>${this._field('idea.text', 'An idea for this service', '', 'textarea')}<div class="row"><button class="act" data-act="add-idea">Give the product owner this idea</button></div>
        ${this._ideas().length ? `<table>${this._ideas().slice(0, 20).map((i) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(i.at))}</td><td>${esc(i.text)} <span class="muted">(${esc(i.by)})</span> ${this._spill(i.status)}</td></tr>`).join('')}</table>` : ''}</div>
      <div class="card"><h2>Answers</h2>${newest(props(this._s.responses).filter((r) => r.intent === 'answered'), 'at').slice(0, 15).map((r) => `<div><span class="muted">${esc(when(r.at))}</span> <b>${esc(r.question || r.promptId)}</b><div class="muted">${esc(arr(r.selected).join(', '))} ${esc(r.text || '')} ${r.notes ? '· ' + esc(r.notes) : ''}</div></div>`).join('') || '<div class="muted">No answers yet.</div>'}</div>
    </div>`;
  }

  _archTab() {
    const cat = newest(props(this._s['spec-catalog']), 'at')[0], mods = arr(cat?.modules), specs = this._specs(), adrs = this._adrs();
    const specsOf = (path) => specs.filter((s) => String(s.module || '').replace(/\/$/, '') === path);
    const tree = mods.length ? `<div class="tree">${mods.map((m) => `<div class="mod"><span class="p">${esc(m.path)}</span> <span class="muted">${esc(m.files)} files</span> ${specsOf(m.path).map((s) => `<span class="pill">${esc(s.specId)}</span>`).join('')}</div>`).join('')}</div>` : '<div class="muted">The catalog is built the first time the architect designs a spec, or on request.</div>';
    const apill = (s) => `<span class="pill ${s === 'accepted' ? 'ok' : s === 'rejected' || s === 'superseded' ? 'bad' : 'warn'}">${esc(s)}</span>`;
    return `<div class="grid">
      <div class="card"><h2>Spec catalog ${cat ? `<span class="muted">mirrors the code at ${esc(String(cat.head || '').slice(0, 10))}, ${mods.length} modules, net ${esc(cat.netId)}</span>` : ''}</h2>${tree}
        <div class="row"><button class="act secondary" data-act="build-catalog">Mirror the code again</button></div></div>
      <div class="card wide"><h2>Specs <span class="pill">${specs.length}</span></h2>${specs.length ? specs.map((s) => `<details><summary><b>${esc(s.specId)}</b> ${esc(s.title)} ${this._spill(s.status)} <span class="pill">${esc(s.module)}</span> <span class="pill">${esc(s.requirementId)}</span></summary>
        <div>${esc(s.summary)}</div><h3>Design</h3>${list(s.design)}<h3>Interfaces</h3>${list(s.interfaces)}<h3>Data</h3>${list(s.data)}<h3>Files</h3>${list(s.files)}<h3>Constraints</h3>${list(s.constraints)}<h3>Verify</h3><div>${esc(s.verify)}</div><h3>Risks</h3>${list(s.risks)}
        ${s.mergeSha ? `<div class="muted mono">merged as ${esc(String(s.mergeSha).slice(0, 10))}</div>` : ''}</details>`).join('') : '<div class="muted">No specs yet. Every change has a spec before it is implemented.</div>'}</div>
      <div class="card"><h2>Decisions</h2>${adrs.length ? adrs.map((a) => `<details ${a.status === 'proposed' ? 'open' : ''}><summary><b>${esc(a.adrId)}</b> ${esc(a.title)} ${apill(a.status)}</summary><div class="muted">Context</div><div>${esc(a.context || '')}</div><div class="muted">Decision</div><div>${esc(a.decision || '')}</div><div class="muted">Consequences</div><div>${esc(a.consequences || '')}</div>
        <div class="row">${a.status !== 'accepted' ? `<button class="act" data-act="adr-accept" data-arg="${esc(a.adrId)}">Accept</button>` : `<button class="act secondary" data-act="adr-supersede" data-arg="${esc(a.adrId)}">Supersede</button>`}${a.status === 'proposed' ? `<button class="act danger" data-act="adr-reject" data-arg="${esc(a.adrId)}">Reject</button>` : ''}</div></details>`).join('') : '<div class="muted">No decision records yet; the architect proposes them with a spec.</div>'}</div>
      ${props(this._s.arch).length ? `<div class="card"><h2>Architecture notes</h2>${props(this._s.arch).map((n) => `<div><b>${esc(n.title)}</b> ${esc(n.text)}</div>`).join('')}</div>` : ''}
    </div>`;
  }

  _qaTab() {
    const acc = this._byId('acceptance', 'acceptanceId'), vers = newest(this._byId('verification', 'verificationId'), 'at'), sc = newest(props(this._s.scorecard), 'at')[0], bugs = this._bugs();
    return `<div class="grid">
      <div class="card"><h2>Readiness ${sc ? `<span class="pill ${Number(sc.score) >= 100 ? 'ok' : Number(sc.score) >= 70 ? 'warn' : 'bad'}">${esc(sc.score)}%</span> <span class="muted">${esc(when(sc.at))}</span>` : ''}</h2>
        ${sc ? `<table>${arr(sc.checks).map((x) => `<tr><td>${esc(x.name)}</td><td>${isTrue(x.ok) ? '<span class="pill ok">ok</span>' : '<span class="pill bad">red</span>'}</td><td class="muted">${esc(x.evidence)}</td></tr>`).join('')}</table><div class="muted mono">tests ${esc(JSON.stringify(obj(sc.tests)))}</div>` : '<div class="muted">No audit yet.</div>'}
        <div class="row"><button class="act secondary" data-act="audit-now">Audit now</button></div></div>
      <div class="card"><h2>Bugs <span class="pill">${bugs.filter((b) => b.status === 'open').length} open</span></h2>${bugs.length ? `<table>${bugs.slice(0, 30).map((b) => `<tr><td>${esc(b.bugId)}</td><td>${esc(b.title)} ${this._spill(b.status)}</td><td>${b.status === 'open' ? `<button class="act secondary" data-act="close-bug" data-arg="${esc(b.bugId)}">Close</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="muted">No bugs.</div>'}</div>
      <div class="card wide"><h2>Acceptance criteria <span class="pill">${acc.length}</span></h2>${acc.length ? acc.map((a) => `<details><summary><b>${esc(a.specId)}</b> ${arr(a.criteria).length} criteria ${this._spill(a.status)}</summary><table>${arr(a.criteria).map((cr) => `<tr><td>${esc(cr.id)}</td><td><b>given</b> ${esc(cr.given)} <b>when</b> ${esc(cr.when)} <b>then</b> ${esc(cr.then)}</td><td class="muted mono">${esc(cr.check)}</td></tr>`).join('')}</table><h3>Tests</h3>${list(a.tests)}<h3>Suites</h3>${list(a.suites)}</details>`).join('') : '<div class="muted">QA writes criteria after you approve a spec.</div>'}</div>
      <div class="card wide"><h2>Verifications <span class="pill">${vers.length}</span></h2>${vers.length ? vers.map((v) => { const d = obj(v.diff), su = obj(v.suites); return `<details><summary><b>${esc(v.runId)}</b> ${this._spill(v.verdict)} ${esc(v.summary)} <span class="muted">${esc(when(v.at))}</span></summary>
        <table><tr><th>Build</th><td>${esc(JSON.stringify(obj(v.build)))}</td></tr><tr><th>Suites</th><td>${esc(su.command)} → rc ${esc(su.rc)} in ${esc(su.durationSec)} s, ${esc(JSON.stringify(obj(su.tests)))}</td></tr><tr><th>Files</th><td>${esc(arr(d.files).join(', '))}</td></tr>${arr(d.outOfScope).length ? `<tr><th>Out of scope</th><td class="pill bad">${esc(arr(d.outOfScope).join(', '))}</td></tr>` : ''}${arr(d.unplanned).length ? `<tr><th>Unplanned</th><td>${esc(arr(d.unplanned).join(', '))}</td></tr>` : ''}</table>
        <h3>Criteria</h3><table>${arr(v.criteria).map((cr) => `<tr><td>${esc(cr.id)}</td><td>${esc(cr.then)}</td><td>${this._spill(cr.status)}</td></tr>`).join('')}</table><details><summary>evidence</summary><div class="mono">${esc(arr(v.evidence).join('\n----\n'))}</div></details></details>`; }).join('') : '<div class="muted">No verifications yet.</div>'}</div>
    </div>`;
  }

  _devTab() {
    const runs = this._runs(), reviews = newest(this._byId('reviews', 'reviewId'), 'at'), briefs = newest(this._byId('briefs', 'packId'), 'at'), refused = newest(props(this._s.refused), 'at');
    return `<div class="grid">
      <div class="card wide"><h2>Runs <span class="pill">${runs.length}</span></h2>${runs.length ? runs.map((r) => { const s = obj(r.summary); return `<details><summary><b>${esc(r.runId)}</b> ${esc(r.specId)} ${this._spill(r.status)} <span class="muted">${esc(r.branch)} · ${esc(r.coder)} ${esc(r.model)} · ${esc(r.durationSec || '')}${r.durationSec ? ' s' : ''} ${r.costUsd ? '· ' + esc(r.costUsd) + ' USD' : ''}</span></summary>
        <div>${esc(s.summary || '')}</div>${s.tests ? `<div class="muted">tests: ${esc(typeof s.tests === 'object' ? JSON.stringify(s.tests) : s.tests)}</div>` : ''}${arr(s.deviations).length ? `<h3>Deviations</h3>${list(s.deviations)}` : ''}${s.notes ? `<div class="muted">${esc(s.notes)}</div>` : ''}<h3>Files</h3>${list(r.filesChanged)}<div class="muted mono">${esc(r.diffStat || '')} ${r.mergeSha ? '· merged ' + esc(String(r.mergeSha).slice(0, 10)) : ''} ${r.workspace ? '· ' + esc(r.workspace) : ''}</div>${r.failure && r.status === 'failed' ? `<div class="pill bad">${esc(r.failure)}</div>` : ''}</details>`; }).join('') : '<div class="muted">No runs yet. A run starts when you approve a context pack.</div>'}</div>
      <div class="card"><h2>Reviews</h2>${reviews.length ? reviews.map((v) => `<details><summary><b>${esc(v.runId)}</b> ${this._spill(v.verdict)} ${esc(v.summary)}</summary>${arr(v.points).length ? `<ul>${arr(v.points).map((p) => `<li><span class="pill ${p.severity === 'blocking' ? 'bad' : p.severity === 'major' ? 'warn' : ''}">${esc(p.severity)}</span> ${esc(p.comment)}<div class="muted mono">${esc(p.file)}</div></li>`).join('')}</ul>` : '<div class="muted">no points</div>'}${arr(v.acceptanceMissing).length ? `<h3>Missing acceptance</h3>${list(v.acceptanceMissing)}` : ''}${arr(v.specDeviations).length ? `<h3>Spec deviations</h3>${list(v.specDeviations)}` : ''}</details>`).join('') : '<div class="muted">No reviews yet.</div>'}</div>
      <div class="card"><h2>Context packs</h2>${briefs.length ? briefs.slice(0, 10).map((b) => `<details><summary><b>${esc(b.packId)}</b> ${esc(b.title)} <span class="muted">${esc(when(b.at))}</span></summary><h3>Constraints</h3>${list(b.constraints)}<h3>Files</h3>${list(obj(b.spec).files)}<div class="muted">coder ${esc(b.coder)} ${esc(b.model)} · branch ${esc(b.branch)}</div></details>`).join('') : '<div class="muted">The architect assembles a pack once the acceptance criteria exist.</div>'}
        ${refused.length ? `<h3>Refused by the gate</h3>${refused.slice(0, 5).map((x) => `<div class="muted">${esc(when(x.at))} ${esc(x.packId)}: ${esc(x.reason)}</div>`).join('')}` : ''}</div>
    </div>`;
  }

  _verdicts() {
    const rows = props(this._s.backlog).map((v) => ({ ...v, __t: atKey(v.at) }));
    const by = new Map();
    for (const v of newest(rows, '__t').reverse()) if (v.key) by.set(v.key, v);
    return by;
  }
  _planRows() {
    const plan = newest(props(this._s.plan), 'at')[0] || null;
    const v = this._verdicts();
    const rows = arr(plan?.increments).map((i) => {
      const title = i.title || i.text || '';
      const decided = [...v.values()].find((x) => planKey(x.title) === planKey(title));
      return { ...i, title, verdict: decided?.verdict || '', note: decided?.note || '', key: decided?.key || '' };
    });
    return { plan, rows };
  }
  _brainTab() {
    const { plan, rows } = this._planRows();
    const open = rows.filter((r) => r.verdict !== 'later' && r.verdict !== 'dropped');
    const later = rows.filter((r) => r.verdict === 'later');
    // things deferred before the brain last rewrote the plan are still yours: show them even when the
    // current plan no longer lists them
    const v = this._verdicts();
    const orphanLater = [...v.values()].filter((x) => x.verdict === 'later' && !rows.some((r) => planKey(r.title) === planKey(x.title)));
    const dropped = [...v.values()].filter((x) => x.verdict === 'dropped');
    const facts = props(this._s.knowledge).filter((f) => f.status === 'active').sort((a, b) => String(a.factId).localeCompare(String(b.factId)));
    const kinds = ['decision', 'answer', 'convention', 'platform', 'gap', 'risk', 'question'];
    const busy = this._working();
    const row = (r, origin) => `<tr><td>${esc(r.title)}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}${r.kind ? `<span class="pill">${esc(r.kind)}</span>` : ''}</td>
      <td style="white-space:nowrap"><button class="act" data-act="plan-implement" data-arg="${esc(r.title)}" ${busy ? 'disabled' : ''}>Implement</button>
      ${origin === 'later'
        ? `<button class="act secondary" data-act="plan-clear" data-arg="${esc(r.title)}">Back to the plan</button>`
        : `<button class="act secondary" data-act="plan-later" data-arg="${esc(r.title)}">Later</button>
           <button class="act danger" data-act="plan-drop" data-arg="${esc(r.title)}">Not this</button>`}</td></tr>`;
    return `<div class="grid">
      <div class="card wide"><h2>The plan ${plan ? `<span class="muted">curated ${esc(when(plan.at))}</span>` : ''}</h2>
        ${plan ? `<div class="muted">${esc(plan.summary || '')}</div>` : ''}
        ${open.length ? `<table>${open.map((r) => row(r, 'plan')).join('')}</table>`
                      : `<div class="muted">${plan ? 'Everything on the plan is deferred or declined.' : 'The brain writes the plan after the first merge.'}</div>`}
        ${busy ? '<div class="muted" style="margin-top:8px">Implement is disabled while the team is busy.</div>' : ''}</div>
      <div class="card wide"><h2>Later <span class="pill">${later.length + orphanLater.length}</span></h2>
        <div class="muted">What you kept but did not want now. It stays here until you pick it up.</div>
        ${(later.length + orphanLater.length) ? `<table>${later.map((r) => row(r, 'later')).join('')}${orphanLater.map((r) => row({ ...r, kind: r.kind || '' }, 'later')).join('')}</table>` : '<div class="muted">Nothing deferred.</div>'}</div>
      ${dropped.length ? `<div class="card"><h2>Declined <span class="pill">${dropped.length}</span></h2>
        <div class="muted">The brain will not propose these again.</div>
        <table>${dropped.map((r) => `<tr><td>${esc(r.title)}</td><td style="white-space:nowrap"><button class="act secondary" data-act="plan-clear" data-arg="${esc(r.title)}">Undo</button></td></tr>`).join('')}</table></div>` : ''}
      <div class="card"><h2>What the team knows <span class="pill">${facts.length} active</span></h2>${facts.length ? kinds.filter((k) => facts.some((f) => f.kind === k)).map((k) => `<h3>${esc(k)}</h3><ul>${facts.filter((f) => f.kind === k).map((f) => `<li>${esc(f.text)} <span class="muted">(${esc(f.factId)}, ${esc(f.confidence)})</span></li>`).join('')}</ul>`).join('') : '<div class="muted">Nothing curated yet.</div>'}</div>
      ${props(this._s['llm-errors']).length ? `<div class="card"><h2>Answers that missed their contract</h2>${newest(props(this._s['llm-errors']), '_emittedAt').slice(0, 5).map((e) => `<div class="mono">${esc(JSON.stringify(e).slice(0, 400))}</div>`).join('')}</div>` : ''}
    </div>`;
  }

  _setupTab() {
    const c = this._charter(), infra = this._infra(), tools = obj(infra?.tools), coders = props(this._s.coders).filter((x) => x.agentId);
    return `<div class="grid">
      <div class="card"><h2>Team ${this._goalUndefined(c) ? '<span class="pill warn">goal not defined</span>' : '<span class="pill ok">goal defined</span>'}</h2>
        ${this._field('c.service', 'Service', /REPLACE/.test(String(c.service)) ? '' : c.service)}${this._field('c.goal', 'Team goal, one line', this._goalUndefined(c) ? '' : c.goal)}${this._field('c.description', 'What the service must become and must never do', c.description, 'textarea')}
        ${this._field('c.repo', 'Workspace repository (core, agentic-nets, ci)', c.repo)}${this._field('c.repoDir', 'Service directory in it', c.repoDir)}${this._select('c.repoMode', 'Where the team works', c.repoMode || 'workspace', [['workspace', 'In your own repository (branches appear where you work)'], ['clone', 'In an isolated clone under the team home']])}${this._field('c.scopePaths', 'Further paths the coder may touch (one per line)', arr(c.scopePaths).join('\n'), 'textarea')}
        ${this._field('c.testCommand', 'Test command (run in the service directory)', c.testCommand)}${this._field('c.buildCommand', 'Build command', c.buildCommand)}${this._field('c.readinessChecks', 'Readiness checks (one per line)', arr(c.readinessChecks).join('\n'), 'textarea')}
        ${this._select('c.autonomyLevel', 'Autonomy', c.autonomyLevel || '3', [['1', '1: observe only'], ['2', '2: propose only'], ['3', '3: every pack needs your approval (default)'], ['4', '4: docs and tests alone'], ['5', '5: also refactors alone']])}${this._field('c.dailyBudgetUsd', 'Daily budget (USD)', c.dailyBudgetUsd)}
        <label>Coding agent (empty = the product office's)</label><select data-f="c.coderAgent"><option value="" ${!(this._form['c.coderAgent'] ?? c.coderAgent) ? 'selected' : ''}>inherit from the product office</option>${coders.map((x) => `<option value="${esc(x.agentId)}" ${(this._form['c.coderAgent'] ?? c.coderAgent) === x.agentId ? 'selected' : ''}>${esc(x.title || x.agentId)}</option>`).join('')}</select>
        ${this._field('c.coderModel', 'Model (empty = inherit)', c.coderModel)}${this._field('c.coderMaxTurns', 'Max turns (empty = inherit)', c.coderMaxTurns)}${this._field('c.coderTimeoutMin', 'Timeout in minutes (empty = inherit)', c.coderTimeoutMin)}
        <div class="row"><button class="act" data-act="set-charter">Save the team</button><span class="muted">${c.updatedAt ? 'saved ' + esc(when(c.updatedAt)) : 'seeded, not saved yet'}</span></div></div>
      <div class="card"><h2>Infrastructure ${infra ? `<span class="pill ${isTrue(infra.ok) ? 'ok' : 'bad'}">${isTrue(infra.ok) ? 'ok' : 'problems'}</span>` : ''} ${this._paused() ? '<span class="pill bad">paused</span>' : ''}</h2>
        ${infra ? `<div class="muted">measured ${esc(when(infra.at))}</div><table><tr><th>Session</th><td>${esc(infra.session)} (namespace ${esc(infra.namespace)})</td></tr><tr><th>Coding agents</th><td>claude ${tools.claude ? esc(tools.claude) : '✗'} · codex ${tools.codex ? esc(tools.codex) : '✗'}</td></tr><tr><th>MCP</th><td>${isTrue(infra.mcp) ? 'ready' : 'not reachable'} (${esc(infra.mcpTokenSource)})</td></tr><tr><th>Workspace repository</th><td>${isTrue(infra.workspaceRepo) ? 'found' : 'missing'}</td></tr><tr><th>Repository</th><td><span class="mono">${esc(infra.repoRoot || '')}</span><div class="muted">${infra.repoMode === 'clone' ? 'isolated clone' : 'your own repository'}${isTrue(infra.clone) ? ', on ' + esc(infra.repoBranch || '?') + ', ' + (isTrue(infra.repoDirty) ? 'uncommitted changes' : 'clean') + ', ' + esc(String(infra.cloneHead || '').slice(0, 10)) : ', MISSING'}</div></td></tr><tr><th>Service directory</th><td>${isTrue(infra.serviceDir) ? 'found' : 'missing'}</td></tr><tr><th>Registered with the office</th><td>${isTrue(infra.registered) ? 'yes' : 'no'}</td></tr></table>` : '<div class="muted">Not measured yet.</div>'}
        <div class="row"><button class="act secondary" data-act="check-infra">Check</button><button class="act" data-act="provision">Provision (token, clone, register)</button>${this._paused() ? '<button class="act" data-act="resume">Resume</button>' : '<button class="act danger" data-act="pause">Pause the team</button>'}</div></div>
      ${newest(props(this._s.errors), 'at').length ? `<div class="card wide"><h2>Errors</h2>${newest(props(this._s.errors), 'at').slice(0, 10).map((e) => `<div><span class="muted">${esc(when(e.at))} ${esc(e.lane)}/${esc(e.stage)}</span> ${esc(e.message)}</div>`).join('')}</div>` : ''}
    </div>`;
  }

  _journalTab() { const rows = newest(props(this._s.journal), 'at').slice(0, 150); return `<div class="card"><h2>Journal</h2>${rows.length ? `<table>${rows.map((j) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(j.at))}</td><td class="muted">${esc(String(j.lane || '').replace(/^t-.*?-team-/, ''))}/${esc(j.stage)}</td><td>${esc(j.summary)}</td></tr>`).join('')}</table>` : '<div class="muted">Nothing yet.</div>'}</div>`; }

  // ---- actions ---------------------------------------------------------------------------------
  async _onAct(act, arg) {
    const at = nowIso(); const f = (k) => String(this._form[k] ?? '').trim(); const c = this._charter();
    const p = arg ? this._openPrompts().find((x) => x.promptId === arg) : null;
    switch (act) {
      case 'check-infra': case 'provision': case 'pause': case 'resume': case 'measure-state': case 'build-catalog': case 'audit-now': return this._invoke(act, {}, act);
      case 'set-charter': {
        const input = { updatedAt: at, status: 'ready' };
        for (const k of CHARTER_KEYS) { const raw = this._form['c.' + k]; if (LIST_KEYS.includes(k)) input[k] = raw !== undefined ? linesOf(raw) : arr(c[k]); else input[k] = raw !== undefined ? String(raw).trim() : String(c[k] ?? ''); }
        if (/REPLACE.?ME/i.test(input.goal)) input.goal = ''; if (!input.goal) input.goal = this._goalUndefined(c) ? 'REPLACE ME' : c.goal;
        if (/REPLACE.?ME/i.test(input.service) || !input.service) input.service = /REPLACE/.test(String(c.service)) ? 'REPLACE ME' : c.service;
        if (arr(c.tokenLanes).length) input.tokenLanes = arr(c.tokenLanes);
        return this._invoke('set-charter', input, act);
      }
      case 'start-iteration': return this._invoke('start-iteration', { iterationId: `it-${stamp()}`, at, reason: 'app', direction: f('it.direction'), notes: '' }, act);
      case 'respond': case 'revise': case 'skip': {
        if (!p) return;
        const intent = act === 'respond' ? (p.kind === 'brain' ? 'knowledge' : 'answer') : 'revise';
        let selected = arr(this._form['__selected.' + p.promptId] || '[]'); let text = f('resp.' + p.promptId);
        if (act === 'skip') { text = ['Skip this; propose something different.', text].filter(Boolean).join(' '); selected = []; }
        if (p.mode === 'interview' && intent !== 'revise') { const answers = arr(p.options).map((o) => { const v = f('q.' + p.promptId + '.' + o.value); if (!v) return ''; return String(o.label || '').trim() === String(p.question || '').trim() ? v : `${o.label}: ${v}`; }).filter(Boolean); if (!answers.length && !text) return this._toast('Answer at least one question', true); text = [...answers, text].filter(Boolean).join('\n'); }
        if (intent === 'answer' && p.mode === 'choice' && !selected.length && !text) return this._toast('Pick an option or write your own', true);
        if (act === 'revise' && !text) return this._toast('Say how the question should be reshaped', true);
        if (intent === 'answer' && p.mode === 'goal' && !text) return this._toast('Write the team goal', true);
        const r = await this._invoke('respond', { promptId: p.promptId, iterationId: p.iterationId || '', intent, selected: selected.join(','), text, notes: f('notes.' + p.promptId), at }, act + arg);
        delete this._form['__selected.' + p.promptId]; delete this._form['resp.' + p.promptId]; delete this._form['notes.' + p.promptId]; return r;
      }
      case 'approve-spec': case 'reject-spec': case 'changes-spec': {
        if (!p) return; const notes = f('notes.' + p.promptId);
        if (act === 'changes-spec') { if (!notes) return this._toast('Say what must change', true); return this._invoke('respond', { promptId: p.promptId, iterationId: p.iterationId || '', intent: 'revise', selected: [], text: notes, notes: '', at }, act + arg); }
        return this._invoke(act, { specId: p.specId, requirementId: p.requirementId || '', promptId: p.promptId, notes, at }, act + arg);
      }
      case 'approve-pack': case 'reject-pack': { if (!p) return; return this._invoke(act, { specId: p.specId, packId: p.packId || '', promptId: p.promptId, notes: f('notes.' + p.promptId), at }, act + arg); }
      case 'merge': case 'request-changes': case 'reject-run': {
        if (!p) return; const notes = f('notes.' + p.promptId);
        if (act === 'request-changes' && !notes) return this._toast('Tell the coder what to change', true);
        return this._invoke(act, { runId: p.runId, specId: p.specId, promptId: p.promptId, notes, at }, act + arg);
      }
      case 'plan-implement': case 'plan-later': case 'plan-drop': case 'plan-clear': {
        const { rows } = this._planRows();
        const v = this._verdicts();
        const known = rows.find((r) => r.title === arg) || [...v.values()].find((x) => x.title === arg);
        const title = known?.title || arg; if (!title) return;
        if (act === 'plan-implement') {
          // hand it to the product owner as the direction for the next iteration, exactly the way the
          // product office allocates one
          if (this._working()) return this._toast('The team is busy; try again when it is idle', true);
          return this._invoke('start-iteration', { iterationId: `it-${stamp()}`, at, reason: 'plan',
            direction: title, notes: known?.note || '' }, act + title);
        }
        const verdict = act === 'plan-later' ? 'later' : act === 'plan-drop' ? 'dropped' : 'cleared';
        return this._invoke('defer-increment', { key: planKey(title), title, kind: known?.kind || '',
          verdict, note: f('note.' + planKey(title)), at: atMs() }, act + title);
      }
      case 'add-idea': { if (!f('idea.text')) return this._toast('Write the idea first', true); const ideaId = `idea-${String(this._ideas().length + 1).padStart(3, '0')}`; const r = await this._invoke('add-idea', { ideaId, text: f('idea.text'), at }, act); this._form['idea.text'] = ''; return r; }
      case 'close-bug': { const b = this._bugs().find((x) => x.bugId === arg); if (!b) return; return this._invoke('close-bug', { bugId: b.bugId, title: b.title, status: 'closed', check: b.check || '', runId: b.runId || '', specId: b.specId || '', at: b.at, by: b.by || '', closedAt: at }, act + arg); }
      case 'adr-accept': case 'adr-reject': case 'adr-supersede': { const a = this._adrs().find((x) => x.adrId === arg); if (!a) return; const status = { 'adr-accept': 'accepted', 'adr-reject': 'rejected', 'adr-supersede': 'superseded' }[act]; return this._invoke('decide-adr', { adrId: a.adrId, specId: a.specId || '', title: a.title, context: a.context || '', decision: a.decision || '', consequences: a.consequences || '', status, at: a.at || at, by: a.by || 'architect', updatedAt: at, decidedBy: 'person' }, act + arg); }
      default: return undefined;
    }
  }
}

if (!customElements.get('agenticos-service-team-v1')) customElements.define('agenticos-service-team-v1', ServiceTeamApp);
export default ServiceTeamApp;
