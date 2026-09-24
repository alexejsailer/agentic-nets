/**
 * Steward: the application on top of the Steward nets (trusted-element web component, self-contained ESM).
 *
 * Six sections: Setup (the charter, the repository, the coder, pause), Next step (what the Steward waits
 * for: a question, a proposal, the goal, or a spec to approve), Work (runs, verification, rollback),
 * Health (what was measured), Brain (plan, facts, decisions), Journal. Everything shown is read from
 * stores through the injected runtime bridge; every button writes a token through a declared action.
 * Nothing here computes a number a script did not measure.
 *
 * Token properties arrive as STRINGS; nested structures as JSON text (arr()/obj() are the only readers).
 * The Setup tab and the pause action are part of the protected set: a spec that removes them is refused.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const arr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
};
const obj = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
};
const isTrue = (v) => String(v ?? '').toLowerCase() === 'true';
const when = (s) => {
  if (!s) return '';
  const d = new Date(String(s));
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const props = (tokens) => (tokens || []).map((t) => t.properties || {});
const newest = (rows, field) => [...rows].sort((a, b) => String(b[field] ?? '').localeCompare(String(a[field] ?? '')));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const stamp = () => nowIso().replace(/[-:]/g, '').replace('T', '');
const linesOf = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
const num = (v, d = 2) => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(d) : String(v ?? ''); };
const signed = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? (n > 0 ? `+${n}` : `${n}`) : ''; };
async function idempotencyKey(action, input) {
  const canon = JSON.stringify({ action, input }, Object.keys(input).sort().concat('action', 'input'));
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon));
    return `${action}:${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch { return `${action}:${crypto.randomUUID()}`; }
}

const CSS = `
:host { display: block; container-type: inline-size; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  --fg: #1c1f24; --muted: #5d6673; --panel: #ffffff; --edge: #dfe3e8; --card: #f6f7f9; --accent: #7a3ec2; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --bg: #f0f2f5; }
@media (prefers-color-scheme: dark) { :host { --fg: #e6e6e6; --muted: #9aa1ab; --panel: #16181d; --edge: #2a2d34; --card: #1d2026; --accent: #b388ff; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --bg: #0f1115; } }
.wrap { color: var(--fg); background: var(--bg); padding: 12px; min-height: 100%; box-sizing: border-box; }
header { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: baseline; padding: 6px 4px 10px; }
header h1 { font-size: 20px; margin: 0; }
header .status { color: var(--muted); font-size: 13px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
nav button { background: var(--panel); border: 1px solid var(--edge); color: var(--fg); padding: 6px 12px; border-radius: 16px; cursor: pointer; }
nav button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
nav button .n { display: inline-block; min-width: 18px; text-align: center; background: var(--accent); color: #fff; border-radius: 9px; font-size: 11px; margin-left: 6px; padding: 0 5px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--edge); border-radius: 10px; padding: 12px 14px; }
.card h2 { font-size: 15px; margin: 0 0 8px; }
.card h3 { font-size: 13px; margin: 12px 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.muted { color: var(--muted); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
button.act { background: var(--accent); color: #fff; border: 0; padding: 7px 12px; border-radius: 6px; cursor: pointer; font-weight: 600; }
button.act.secondary { background: var(--card); color: var(--fg); border: 1px solid var(--edge); }
button.act.danger { background: var(--bad); }
button.act:disabled { opacity: .5; cursor: default; }
input, textarea, select { width: 100%; box-sizing: border-box; background: var(--card); color: var(--fg); border: 1px solid var(--edge); border-radius: 6px; padding: 6px 8px; font: inherit; }
textarea { min-height: 70px; resize: vertical; }
label { display: block; font-size: 12px; color: var(--muted); margin-top: 8px; }
.opt { border: 1px solid var(--edge); border-radius: 8px; padding: 10px 12px; margin-top: 8px; background: var(--card); cursor: pointer; }
.opt.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.opt .t { font-weight: 600; }
.pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--edge); color: var(--muted); margin-left: 6px; }
.pill.ok { color: var(--ok); border-color: var(--ok); } .pill.warn { color: var(--warn); border-color: var(--warn); } .pill.bad { color: var(--bad); border-color: var(--bad); } .pill.rec { color: var(--accent); border-color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td, th { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--edge); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
ul { margin: 4px 0; padding-left: 18px; } li { margin: 2px 0; }
.big { font-size: 28px; font-weight: 700; }
.toast { position: fixed; right: 16px; bottom: 16px; background: var(--fg); color: var(--bg); padding: 8px 12px; border-radius: 8px; z-index: 9; max-width: 60ch; }
.toast.err { background: var(--bad); color: #fff; }
details summary { cursor: pointer; color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; }
.empty { color: var(--muted); padding: 24px; text-align: center; }
.banner { border-left: 4px solid var(--warn); background: var(--card); padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; }
`;

const ROLES = ['charter', 'coders', 'infra', 'repo', 'iterate', 'prompts', 'responses', 'specs', 'refused', 'decisions', 'runs', 'verification', 'health', 'lanes', 'map', 'budget',
  'journal', 'errors', 'llm-errors', 'knowledge', 'plan', 'adr', 'curations', 'signals', 'ideas'];
const CHARTER_KEYS = ['goal', 'description', 'principles', 'constraints', 'scope', 'autonomyLevel', 'dailyBudgetUsd', 'observeCron', 'home', 'repoUrl', 'repoBranch', 'packDir', 'mcpUrl',
  'coderAgent', 'coderModel', 'coderMaxTurns', 'coderAllowedTools', 'coderTimeoutMin', 'brainAgent', 'brainModel'];
const LIST_KEYS = ['principles', 'constraints', 'scope'];
const LEVELS = [['1', '1: observe only'], ['2', '2: propose only, apply nothing'], ['3', '3: apply with approval (default)'], ['4', '4: tune and view alone'], ['5', '5: also crystallise alone']];
const KINDS = ['tune', 'view', 'crystallise', 'add-lane', 'remove-lane', 'add-net', 'add-script', 'tool-net', 'app'];

class StewardApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._s = {};
    this._tab = 'next';
    this._form = {};
    this._busy = new Set();
    this._unsubs = [];
  }
  set runtime(rt) { this._rt = rt; if (this.isConnected) this._boot(); }
  get runtime() { return this._rt; }
  connectedCallback() { if (this._rt) this._boot(); }
  disconnectedCallback() { for (const u of this._unsubs.splice(0)) { try { u(); } catch { /* gone */ } } clearInterval(this._timer); }

  async _boot() {
    this.shadowRoot.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="empty">Loading the Steward…</div></div>`;
    await this._load(ROLES);
    for (const role of ['prompts', 'specs', 'runs', 'verification', 'journal', 'knowledge', 'plan', 'health', 'infra', 'repo', 'decisions', 'refused']) {
      try {
        this._unsubs.push(this._rt.watchStore(role, (ev) => { this._s[role] = ev.tokens; this._render(); }, 15000));
      } catch { /* watch not granted: the sweep covers it */ }
    }
    this._timer = setInterval(() => this._load(['charter', 'coders', 'responses', 'adr', 'lanes', 'map', 'budget', 'errors', 'llm-errors', 'iterate']), 30000);
  }
  async _load(roles) {
    await Promise.all(roles.map(async (r) => {
      try { this._s[r] = await this._rt.readStore(r, { limit: 400 }); } catch { this._s[r] = this._s[r] || []; }
    }));
    this._render();
  }
  async _invoke(action, input, busyKey) {
    if (this._busy.has(busyKey)) return;
    this._busy.add(busyKey); this._render();
    try {
      await this._rt.invoke(action, input, { idempotencyKey: await idempotencyKey(action, input) });
      this._toast(`${action} ✓`);
      await this._load(ROLES);
    } catch (e) {
      this._toast(e?.message || `${action} failed`, true);
    } finally { this._busy.delete(busyKey); this._render(); }
  }
  _toast(msg, err) {
    const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg;
    this.shadowRoot.appendChild(el); setTimeout(() => el.remove(), err ? 6000 : 2500);
  }

  // ---- data shaping ------------------------------------------------------------
  _charter() { const rows = props(this._s.charter).filter((c) => c.charterId === 'steward' || !c.charterId); return newest(rows, 'updatedAt')[0] || {}; }
  _goalUndefined(c) { return !c.goal || /REPLACE.?ME/i.test(String(c.goal)); }
  _infra() { return newest(props(this._s.infra).filter((i) => i.kind !== 'pause'), 'at')[0] || null; }
  _pauseRecord() { return newest(props(this._s.infra).filter((i) => i.kind === 'pause'), 'at')[0] || null; }
  _paused() { const r = this._pauseRecord(); return !!r && r.state === 'paused'; }
  _repo() { return newest(props(this._s.repo), 'updatedAt')[0] || null; }
  _health() { return newest(props(this._s.health), 'at')[0] || null; }
  _budget() { return newest(props(this._s.budget), 'day')[0] || null; }
  _map() { return newest(props(this._s.map), 'at')[0] || null; }
  _ideas() {
    const by = new Map();
    for (const i of newest(props(this._s.ideas), 'at').reverse()) if (i.ideaId) by.set(i.ideaId, i);
    return [...by.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  _adrs() {
    const by = new Map();
    for (const a of newest(props(this._s.adr), 'updatedAt').reverse()) if (a.adrId) by.set(a.adrId, a);
    return [...by.values()].sort((a, b) => String(a.adrId).localeCompare(String(b.adrId)));
  }
  _spec(id) { return newest(props(this._s.specs).filter((s) => s.specId === id), 'at')[0] || null; }
  _decided() { return new Set([...props(this._s.decisions).filter((d) => d.kind === 'spec-approval').map((d) => d.specId), ...props(this._s.runs).map((r) => r.specId)]); }
  _openApproval() {
    const decided = this._decided();
    const open = props(this._s.prompts).filter((p) => p.kind === 'approval' && p.specId && !decided.has(p.specId));
    return newest(open, 'at')[0] || null;
  }
  _openQuestion() {
    const answered = new Set([...props(this._s.responses).map((r) => r.promptId), ...props(this._s.specs).map((sp) => sp.promptId)]);
    const latestPerIteration = new Map();
    for (const p of newest(props(this._s.prompts).filter((p) => p.kind !== 'approval'), 'at').reverse()) if (p.promptId) latestPerIteration.set(p.iterationId || p.promptId, p);
    const open = [...latestPerIteration.values()].filter((p) => !answered.has(p.promptId));
    return newest(open, 'at')[0] || null;
  }
  _runs() {
    const ver = props(this._s.verification);
    return newest(props(this._s.runs), 'at').map((r) => ({ run: r, verification: newest(ver.filter((v) => v.runId === r.runId), 'at')[0] || null }));
  }
  _working() {
    const r = props(this._s.runs).find((x) => ['coding', 'building', 'verifying', 'releasing'].includes(String(x.status)));
    if (r) return { coding: `The coder is applying ${r.specId}`, building: `Building ${r.specId}`, verifying: `Verifying ${r.specId}`, releasing: `Releasing ${r.specId}` }[r.status];
    if (props(this._s.specs).some((s) => s.status === 'draft')) return 'The gate is checking a spec';
    if (props(this._s.iterate).length) return 'The Steward is thinking about the next step';
    const j = newest(props(this._s.journal), 'at')[0];
    if (j && j.stage === 'context' && Date.now() - new Date(j.at).getTime() < 10 * 60 * 1000) return 'The Steward is thinking about the next step';
    return '';
  }

  // ---- render ------------------------------------------------------------------
  _render() {
    const root = this.shadowRoot;
    const c = this._charter(), repo = this._repo(), h = this._health(), approval = this._openApproval(), question = this._openQuestion();
    const awaiting = (approval ? 1 : 0) + (question ? 1 : 0);
    const status = [
      this._paused() ? 'PAUSED' : '',
      repo ? `pack ${repo.installedVersion || repo.packVersion || '?'} @ ${String(repo.headSha || '').slice(0, 7)}` : 'not provisioned',
      h ? `${h.summary}` : 'not observed yet',
      this._working(),
    ].filter(Boolean).join(' · ');
    const tabs = [['setup', 'Setup'], ['next', 'Next step'], ['work', 'Work'], ['health', 'Health'], ['brain', 'Brain'], ['journal', 'Journal']];
    const body = { setup: this._setup, next: this._next, work: this._work, health: this._healthTab, brain: this._brain, journal: this._journal }[this._tab].call(this);
    root.innerHTML = `<style>${CSS}</style><div class="wrap">
      <header><h1>Steward</h1><span class="status">${esc(status)}</span></header>
      <nav>${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === this._tab ? 'on' : ''}">${l}${k === 'next' && awaiting ? `<span class="n">${awaiting}</span>` : ''}</button>`).join('')}</nav>
      ${this._paused() ? '<div class="banner">The Steward is paused: nothing proposes, codes or installs. Resume it in Setup.</div>' : ''}
      ${body}</div>`;
    root.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { this._tab = b.dataset.tab; this._render(); }));
    this._wire(root);
  }
  _field(name, label, value, kind = 'input', ph = '') {
    const v = this._form[name] ?? value ?? '';
    return `<label>${esc(label)}</label>${kind === 'textarea' ? `<textarea data-f="${name}" placeholder="${esc(ph)}">${esc(v)}</textarea>` : `<input data-f="${name}" value="${esc(v)}" placeholder="${esc(ph)}">`}`;
  }
  _select(name, label, value, options) {
    const v = this._form[name] ?? value ?? '';
    return `<label>${esc(label)}</label><select data-f="${name}">${options.map(([val, lab]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  }
  _wire(root) {
    root.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', () => { this._form[el.dataset.f] = el.value; });
      if (el.tagName === 'SELECT') el.addEventListener('change', () => { this._form[el.dataset.f] = el.value; this._render(); });
    });
    root.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => this._onAct(el.dataset.act, el.dataset.arg)));
    root.querySelectorAll('.opt[data-opt]').forEach((el) => el.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT') return;
      const multi = el.dataset.multi === 'true';
      const cur = new Set(arr(this._form.__selected || '[]'));
      if (multi) { cur.has(el.dataset.opt) ? cur.delete(el.dataset.opt) : cur.add(el.dataset.opt); } else { cur.clear(); cur.add(el.dataset.opt); }
      this._form.__selected = JSON.stringify([...cur]); this._render();
    }));
  }

  _setup() {
    const c = this._charter(), infra = this._infra(), repo = this._repo(), paused = this._paused();
    const tools = obj(infra?.tools), mcp = obj(infra?.mcp), rs = obj(infra?.repo);
    const coders = props(this._s.coders).filter((x) => x.agentId);
    const coderId = this._form['c.coderAgent'] ?? c.coderAgent ?? 'claude-code';
    return `<div class="grid">
      <div class="card"><h2>Charter ${this._goalUndefined(c) ? '<span class="pill warn">goal not defined</span>' : '<span class="pill ok">goal defined</span>'}</h2>
        ${this._field('c.goal', 'Goal in one line (what this model should become)', this._goalUndefined(c) ? '' : c.goal)}
        ${this._field('c.description', 'Who it serves, what it must do, what it must never do', c.description, 'textarea')}
        ${this._field('c.principles', 'Principles (one per line)', arr(c.principles).join('\n'), 'textarea')}
        ${this._field('c.constraints', 'Constraints (one per line)', arr(c.constraints).join('\n'), 'textarea')}
        ${this._field('c.scope', 'Scope: net ids the Steward may change, one per line; empty = only the nets it created; * = everything in the model', arr(c.scope).join('\n'), 'textarea')}
        ${this._select('c.autonomyLevel', 'Autonomy level', c.autonomyLevel || '3', LEVELS)}
        ${this._field('c.dailyBudgetUsd', 'Daily budget (USD) for the model and the coder', c.dailyBudgetUsd)}
        ${this._field('c.observeCron', 'Observe schedule (6-field cron, Europe/Berlin)', c.observeCron)}
        <div class="row"><button class="act" data-act="set-charter">Save charter</button><span class="muted">${c.updatedAt ? 'saved ' + esc(when(c.updatedAt)) : 'seeded, not saved yet'}</span></div></div>
      <div class="card"><h2>Infrastructure ${infra ? `<span class="pill ${isTrue(infra.ok) ? 'ok' : 'bad'}">${isTrue(infra.ok) ? 'ok' : 'problems'}</span>` : ''} ${paused ? '<span class="pill bad">paused</span>' : ''}</h2>
        ${infra ? `<div class="muted">measured ${esc(when(infra.at))}</div>
        <table><tr><th>Coding agents</th><td>claude ${tools.claude ? esc(tools.claude) : '✗'} · codex ${tools.codex ? esc(tools.codex) : '✗'}</td></tr>
        <tr><th>node / git / python</th><td>${esc(tools.node || '✗')} · ${esc(tools.git || '✗')} · ${esc(tools.python3 || '✗')}</td></tr>
        <tr><th>MCP endpoint</th><td>${esc(mcp.url || '')} ${mcp.ready === true || isTrue(mcp.ready) ? '<span class="pill ok">ready</span>' : '<span class="pill bad">not ready</span>'} <span class="muted">token from ${esc(infra.mcpTokenSource || '?')}</span></td></tr>
        <tr><th>Repository</th><td>${rs.present === true || isTrue(rs.present) ? `cloned at <span class="mono">${esc(rs.path || '')}</span> ${rs.headSha ? '@ ' + esc(String(rs.headSha).slice(0, 7)) : ''}${rs.dirty === true || isTrue(rs.dirty) ? ' <span class="pill warn">dirty</span>' : ''}` : 'not cloned'}</td></tr>
        <tr><th>Disk free</th><td>${esc(infra.diskFreeGb || '?')} GB in ${esc(infra.home || '')}</td></tr></table>
        ${arr(infra.problems).length ? `<ul>${arr(infra.problems).map((p) => `<li class="muted">${esc(p)}</li>`).join('')}</ul>` : ''}` : '<div class="muted">Not measured yet.</div>'}
        <div class="row"><button class="act secondary" data-act="check-infra">Check infrastructure</button>
        <button class="act" data-act="provision">${rs.present === true || isTrue(rs.present) ? 'Re-provision (rotate token, pull)' : 'Provision (token + clone)'}</button></div>
        <h3>Pause</h3>
        <div class="muted">${paused ? `Paused ${esc(when(this._pauseRecord()?.at))}: ${arr(this._pauseRecord()?.lanes).length} lane(s) stopped. The setup lane stays up so resume works.` : 'Stops every lane except the setup lane. Nothing proposes, codes or installs until you resume.'}</div>
        <div class="row">${paused ? '<button class="act" data-act="resume">Resume</button>' : '<button class="act danger" data-act="pause">Pause the Steward</button>'}</div></div>
      <div class="card"><h2>Repository and pack ${repo ? `<span class="pill ok">${esc(repo.status || 'ok')}</span>` : ''}</h2>
        ${repo ? `<table><tr><th>Clone</th><td class="mono">${esc(repo.localPath)}</td></tr><tr><th>Head</th><td class="mono">${esc(String(repo.headSha || '').slice(0, 12))}</td></tr>
        <tr><th>Installed pack</th><td>${esc(repo.installedVersion || repo.packVersion || '?')}${repo.previousVersion ? ` <span class="muted">(previous ${esc(repo.previousVersion)})</span>` : ''}</td></tr>
        <tr><th>Last release</th><td>${esc(repo.lastReleasedSpec || 'none')} ${repo.lastReleasedAt ? esc(when(repo.lastReleasedAt)) : ''}</td></tr>
        <tr><th>Own nets</th><td>${esc(arr(repo.ownNets).join(', ') || 'the four Steward nets')}</td></tr></table>` : '<div class="muted">Not cloned. Save the repository settings, then provision.</div>'}
        ${this._field('c.repoUrl', 'Repository URL (the pack lives here)', c.repoUrl)}
        ${this._field('c.repoBranch', 'Branch', c.repoBranch)}
        ${this._field('c.packDir', 'Pack directory inside the repository', c.packDir)}
        ${this._field('c.home', 'Working directory on the executor host', c.home)}
        ${this._field('c.mcpUrl', 'Agentic-Nets MCP endpoint the scripts measure through', c.mcpUrl)}
        <div class="row"><button class="act" data-act="set-charter">Save repository settings</button></div></div>
      <div class="card"><h2>Coder</h2>
        <div class="muted">Which headless agent applies an approved spec inside the pack repository. Definitions live in the coders place; choose here, override the model.</div>
        <label>Agent</label><select data-f="c.coderAgent">${coders.map((x) => `<option value="${esc(x.agentId)}" ${coderId === x.agentId ? 'selected' : ''}>${esc(x.title || x.agentId)}${x.binary && tools[x.binary] === '' ? ' (binary missing)' : ''}</option>`).join('')}</select>
        ${coders.filter((x) => x.agentId === coderId).map((x) => `<div class="muted" style="margin-top:6px">${esc(x.description || '')}<br><span class="mono">${esc(arr(x.command).join(' '))}</span><br>models: ${esc(arr(x.models).join(', ') || x.defaultModel || '')}</div>`).join('')}
        ${this._field('c.coderModel', 'Model (empty = the agent default)', c.coderModel)}
        ${this._field('c.coderMaxTurns', 'Max turns (empty = the agent default)', c.coderMaxTurns)}
        ${this._field('c.coderTimeoutMin', 'Timeout in minutes (empty = the agent default)', c.coderTimeoutMin)}
        ${this._field('c.coderAllowedTools', 'Allowed tools (empty = the agent default)', c.coderAllowedTools, 'textarea')}
        <h3>The brain's curator</h3>
        <label>Curator</label><select data-f="c.brainAgent"><option value="llm" ${(this._form['c.brainAgent'] ?? c.brainAgent ?? 'llm') === 'llm' ? 'selected' : ''}>One-shot model call (the curate lane)</option>${coders.map((x) => `<option value="${esc(x.agentId)}" ${(this._form['c.brainAgent'] ?? c.brainAgent) === x.agentId ? 'selected' : ''}>${esc(x.title || x.agentId)}, headless in the repository</option>`).join('')}</select>
        ${this._field('c.brainModel', 'Curator model (empty = the agent default)', c.brainModel)}
        <div class="row"><button class="act" data-act="set-charter">Save coder and curator</button></div></div>
    </div>`;
  }

  _specCard(sp, prompt) {
    const li = (v) => arr(v).map((x) => `<li>${esc(typeof x === 'object' ? JSON.stringify(x) : x)}</li>`).join('');
    return `<div class="card"><h2>Spec to approve: ${esc(sp.specId)} <span class="pill warn">${esc(sp.kind)}</span></h2>
      <div><b>${esc(sp.title)}</b></div><div>${esc(sp.summary)}</div><div class="muted" style="margin-top:6px">${esc(sp.why)}</div>
      ${prompt?.context ? `<div class="banner" style="margin-top:8px">${esc(prompt.context)}</div>` : ''}
      <h3>Nets</h3><div>${esc(arr(sp.nets).join(', ') || 'none')}</div>
      <h3>Lanes and places touched</h3><div class="mono">${esc(arr(sp.touches).join(', ') || 'none')}</div>
      <h3>Changes, in order</h3><ul>${li(sp.changes)}</ul>
      <h3>Files</h3><ul>${li(sp.files)}</ul>
      <h3>Verify after install</h3><div>${esc(sp.verify)}</div>
      ${sp.blastRadius ? `<h3>Blast radius</h3><div>${esc(sp.blastRadius)}</div>` : ''}
      ${this._field('spec.notes', 'Notes for the coder (optional)', '')}
      <div class="row"><button class="act" data-act="approve-spec" data-arg="${esc(sp.specId)}">Approve and apply</button><button class="act secondary" data-act="reject-spec" data-arg="${esc(sp.specId)}">Reject</button></div></div>`;
  }

  _next() {
    const approval = this._openApproval(), question = this._openQuestion(), c = this._charter();
    const parts = [];
    if (approval) {
      const sp = this._spec(approval.specId);
      parts.push(sp ? this._specCard(sp, approval) : `<div class="card"><h2>Approval</h2><div>${esc(approval.question)}</div><div class="muted">${esc(approval.context)}</div></div>`);
    }
    if (question) {
      const p = question, options = arr(p.options), selected = new Set(arr(this._form.__selected || '[]')), mode = String(p.mode || 'choice');
      const title = p.kind === 'brain' ? 'The brain has a question' : mode === 'goal' ? 'The Steward needs the goal' : mode === 'interview' ? 'The Steward has questions' : 'The Steward proposes the next step';
      parts.push(`<div class="card"><h2>${title} <span class="pill">${esc(p.promptId)}</span></h2>
        <div>${esc(p.question)}</div>${p.context ? `<div class="muted" style="margin-top:6px">${esc(p.context)}</div>` : ''}
        ${mode === 'goal' ? '<div class="row"><span class="muted">Define the goal in Setup, or write it here: one line, then a paragraph.</span></div>' : ''}
        ${options.map((o) => mode === 'interview'
          ? `<div class="opt" data-opt="${esc(o.value)}" data-multi="true"><div class="t">${esc(o.label)}</div><div class="muted">${esc(o.description || '')}</div>${this._field('q.' + o.value, 'Your answer', '', 'textarea')}</div>`
          : `<div class="opt ${selected.has(String(o.value)) ? 'sel' : ''}" data-opt="${esc(o.value)}" data-multi="false"><div class="t">${esc(o.label)} ${isTrue(o.recommended) ? '<span class="pill rec">recommended</span>' : ''} ${o.kind ? `<span class="pill">${esc(o.kind)}</span>` : ''} ${o.effort ? `<span class="pill">effort ${esc(o.effort)}</span>` : ''} ${o.risk ? `<span class="pill">risk ${esc(o.risk)}</span>` : ''} ${arr(o.nets).length ? `<span class="pill">${esc(arr(o.nets).join(', '))}</span>` : ''}</div><div class="muted">${esc(o.description || '')}</div>${o.evidence ? `<div class="muted mono">${esc(o.evidence)}</div>` : ''}</div>`).join('')}
        ${this._field('resp.text', mode === 'goal' ? 'The goal (one line, then a paragraph)' : 'Your own words (optional: a different direction, or guidance for the spec)', '', 'textarea')}
        ${this._field('resp.notes', 'Notes for the spec (optional)', '')}
        ${p.rationale ? `<details><summary>Why these options</summary><div>${esc(p.rationale)}</div></details>` : ''}
        <div class="row"><button class="act" data-act="respond">Answer</button><button class="act secondary" data-act="revise">Reshape the question</button><button class="act secondary" data-act="skip">Skip, propose something else</button></div></div>`);
    }
    if (!approval && !question) {
      const working = this._working();
      const refused = newest(props(this._s.refused), 'at')[0];
      parts.push(`<div class="card"><h2>Next step</h2>
        ${working ? `<div>${esc(working)}…</div>` : `<div class="muted">${this._goalUndefined(c) ? 'The goal is not defined yet; the Steward asks for it first.' : this._paused() ? 'Paused.' : 'Nothing is waiting for you. Ask the Steward what to do next, or observe the model now.'}</div>`}
        ${refused && !working ? `<div class="muted" style="margin-top:6px">Last refusal by the gate: ${esc(refused.specId)}: ${esc(refused.reason)}</div>` : ''}
        <div class="row"><button class="act" data-act="start-iteration" ${working || this._paused() ? 'disabled' : ''}>Ask the Steward for the next step</button><button class="act secondary" data-act="observe-now" ${this._paused() ? 'disabled' : ''}>Observe now</button></div></div>`);
    }
    const ideas = this._ideas();
    parts.push(`<div class="card"><h2>Ideas ${ideas.filter((i) => i.status === 'open').length ? `<span class="pill">${ideas.filter((i) => i.status === 'open').length} open</span>` : ''}</h2>
      <div class="muted">A net, a lane, a tool net or a script this model could gain. Every proposal must offer at least one option that serves an open idea; the brain adds ideas after a release.</div>
      ${this._field('idea.text', 'Your idea', '', 'textarea')}<div class="row"><button class="act" data-act="add-idea">Give the Steward this idea</button></div>
      ${ideas.length ? `<table>${ideas.slice(0, 20).map((i) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(i.at))}</td><td>${esc(i.text)} <span class="muted">(${esc(i.by)})</span></td><td><span class="pill ${i.status === 'taken' ? 'ok' : i.status === 'dropped' ? 'bad' : 'warn'}">${esc(i.status)}${i.specId ? ' ' + esc(i.specId) : ''}</span>${i.status === 'open' ? ` <button class="act secondary" data-act="drop-idea" data-arg="${esc(i.ideaId)}">Drop</button>` : ''}</td></tr>`).join('')}</table>` : ''}</div>`);
    return `<div class="grid">${parts.join('')}</div>`;
  }

  _work() {
    const rows = this._runs();
    const refused = newest(props(this._s.refused), 'at').slice(0, 10);
    const rolled = new Set(props(this._s.decisions).filter((d) => d.kind === 'rollback').map((d) => d.runId));
    if (!rows.length && !refused.length) return '<div class="card"><div class="muted">No runs yet. Approve a spec in Next step.</div></div>';
    const cards = rows.map(({ run, verification: v }) => {
      const st = String(run.status || '');
      const pill = st === 'released' ? 'ok' : ['failed', 'rolled-back'].includes(st) ? 'bad' : 'warn';
      const busy = ['coding', 'building', 'verifying', 'releasing'].includes(st);
      const canRollback = st === 'released' && run.previousVersion && !rolled.has(run.runId);
      const steps = arr(run.buildSteps).filter((s) => !/: ok$/.test(String(s)));
      return `<div class="card"><h2>${esc(run.specId)} <span class="muted">${esc(run.title || '')}</span> <span class="pill ${pill}">${esc(busy ? st + '…' : st)}</span> <span class="pill">${esc(run.kind)}</span></h2>
        <table><tr><th>Pack version</th><td>${esc(run.previousVersion || '?')} → <b>${esc(run.packVersion || '?')}</b>${run.tag ? ` <span class="pill">${esc(run.tag)}</span>` : ''}</td></tr>
        <tr><th>Branch</th><td class="mono">${esc(run.branch)} @ ${esc(String(run.headSha || '').slice(0, 7))}</td></tr>
        <tr><th>Build</th><td>${busy && st === 'coding' ? 'the coder is working…' : `${isTrue(run.buildOk) ? 'green' : 'RED'}; ${esc(run.diffStat || '')}${steps.length ? `<div class="mono">${esc(steps.join('\n'))}</div>` : ''}`}</td></tr>
        <tr><th>Coder</th><td>${run.coderAgent ? esc(run.coderAgent) + (run.coderModel ? ' / ' + esc(run.coderModel) : '') + ': ' : ''}${esc(run.coderDurationSec || '')}s, ${esc(run.coderTurns || '?')} turns${run.coderCostUsd ? `, $${num(run.coderCostUsd)}` : ''}</td></tr>
        <tr><th>Verification</th><td>${v ? `<span class="pill ${v.status === 'pass' ? 'ok' : 'bad'}">${esc(v.status)}</span>${v.rolledBackTo ? ` rolled back to ${esc(v.rolledBackTo)}` : ''}` : (busy ? 'pending' : '')}</td></tr></table>
        <details><summary>Coder summary and notes</summary><div>${esc(run.coderSummary)}</div><div class="muted">${esc(run.coderNotes || '')}</div><div class="muted">${esc(arr(run.filesChanged).join(', '))}</div></details>
        ${v ? `<details><summary>Verification checks (${arr(v.checks).length})</summary><ul>${arr(v.checks).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
        ${st === 'released' ? `${this._field('run.notes.' + run.runId, 'Why roll back (optional)', '')}<div class="row"><button class="act danger" data-act="rollback" data-arg="${esc(run.runId)}" ${canRollback ? '' : 'disabled'}>Roll back to ${esc(run.previousVersion || '?')}</button><span class="muted">released ${esc(when(run.releasedAt))}</span></div>` : ''}
        ${st === 'rolled-back' ? `<div class="muted">rolled back to ${esc(run.rolledBackTo || v?.rolledBackTo || '?')} ${esc(when(run.rolledBackAt || run.verifiedAt))}${run.rollbackNotes ? ': ' + esc(run.rollbackNotes) : ''}</div>` : ''}</div>`;
    });
    if (refused.length) cards.push(`<div class="card"><h2>Refused by the gate</h2><table>${refused.map((r) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(r.at))}</td><td>${esc(r.specId)} <span class="pill">${esc(r.kind)}</span></td><td>${esc(r.reason)}</td></tr>`).join('')}</table></div>`);
    return `<div class="grid">${cards.join('')}</div>`;
  }

  _healthTab() {
    const h = this._health(), b = this._budget(), m = this._map();
    const lanes = h ? props(this._s.lanes).filter((l) => l.observationId === h.observationId) : [];
    lanes.sort((a, b2) => String(a.transitionId).localeCompare(String(b2.transitionId)));
    const trend = obj(h?.trend);
    const errs = newest(props(this._s.errors), 'at').slice(0, 8), llm = newest(props(this._s['llm-errors']), 'at').slice(0, 5);
    const t = (k) => { const s = signed(trend[k]); return s ? ` <span class="muted">(${esc(s)})</span>` : ''; };
    return `<div class="grid">
      <div class="card"><h2>Health ${h ? `<span class="muted">${esc(when(h.at))} · ${esc(h.reason)}</span>` : ''}</h2>
        ${h ? `<div>${esc(h.summary)}</div>
        <table><tr><th>Lanes</th><td>${esc(h.running)} running${t('running')}, ${esc(h.stopped)} stopped, ${esc(h.errorState)} in error</td></tr>
        <tr><th>Fires (window)</th><td>${esc(h.fires)} with ${esc(h.fireErrors)} errors${t('fireErrors')}</td></tr>
        <tr><th>Model calls</th><td>${esc(h.llmCalls)} with ${esc(h.llmErrors)} errors${t('llmErrors')}; ${esc(h.contractMisses)} contract misses</td></tr>
        <tr><th>Stranded</th><td>${arr(h.stranded).length ? arr(h.stranded).map((s) => `${esc(s.place)} (${esc(s.tokens)} tokens; ${esc(arr(s.lanes).join(', '))})`).join('; ') : 'none'}${t('stranded')}</td></tr>
        <tr><th>Overdue schedules</th><td>${esc(arr(h.overdue).join(', ') || 'none')}</td></tr>
        <tr><th>Executor</th><td>${esc(h.executor || '?')}${isTrue(h.paused) ? ' <span class="pill bad">model paused</span>' : ''}</td></tr>
        <tr><th>Cost 24h</th><td>$${num(h.costUsd24h)}${t('costUsd24h')}${arr(h.topCost).length ? `<div class="muted">${arr(h.topCost).map((x) => `${esc(x.lane)} $${num(x.usd)}`).join(' · ')}</div>` : ''}</td></tr></table>
        ${arr(h.recentErrors).length ? `<details><summary>Recent fire errors</summary><ul>${arr(h.recentErrors).map((e) => `<li class="muted">${esc(e)}</li>`).join('')}</ul></details>` : ''}` : '<div class="muted">Not observed yet.</div>'}
        <div class="row"><button class="act secondary" data-act="observe-now" ${this._paused() ? 'disabled' : ''}>Observe now</button></div></div>
      <div class="card"><h2>Budget ${b ? `<span class="muted">${esc(b.day)}</span>` : ''}</h2>
        ${b ? `<div class="big">$${num(b.spentUsd)}<span class="muted" style="font-size:14px"> of $${num(b.limitUsd)} today</span></div>${isTrue(b.exhausted) ? '<div class="pill bad">exhausted: the gate asks before every change</div>' : `<div class="muted">$${num(b.remainingUsd)} remaining</div>`}` : '<div class="muted">No ledger yet.</div>'}
        <h3>The map</h3>
        ${m ? `<div>${esc(m.summary)}</div><table><tr><th>Session</th><th>Net</th><th>Places</th><th>Lanes</th></tr>${arr(m.nets).map((n) => `<tr><td>${esc(n.session)}</td><td>${esc(n.netId)}</td><td>${esc(n.places)}</td><td>${esc(n.transitions)}</td></tr>`).join('')}</table>` : '<div class="muted">No map yet.</div>'}</div>
      <div class="card"><h2>Lanes ${lanes.length ? `<span class="pill">${lanes.length}</span>` : ''}</h2>
        ${lanes.length ? `<div style="overflow-x:auto"><table><tr><th>Lane</th><th>Kind</th><th>Status</th><th>Schedule</th><th>Fires</th><th>Errors</th><th>Cost</th></tr>${lanes.map((l) => `<tr><td class="mono">${esc(l.transitionId)}</td><td>${esc(l.kind)}</td><td><span class="pill ${l.status === 'RUNNING' ? 'ok' : l.status === 'ERROR' ? 'bad' : ''}">${esc(l.status)}</span></td><td class="muted">${esc(l.schedule || '')}${isTrue(l.overdue) ? ' <span class="pill bad">overdue</span>' : ''}</td><td>${esc(l.fires)}</td><td>${esc(l.llmErrors)}</td><td>${Number(l.costUsd) ? '$' + num(l.costUsd) : ''}</td></tr>`).join('')}</table></div>` : '<div class="muted">No lane measurements yet.</div>'}</div>
      ${errs.length || llm.length ? `<div class="card"><h2>Errors</h2>${errs.map((e) => `<div><span class="muted">${esc(when(e.at))} ${esc(e.lane)}/${esc(e.stage)}</span> ${esc(e.message)}</div>`).join('')}${llm.map((e) => `<div><span class="muted">answer contract</span> ${esc(arr(e.problems).join('; ') || e.problems || e.error || '')}</div>`).join('')}</div>` : ''}
    </div>`;
  }

  _brain() {
    const plan = newest(props(this._s.plan), 'at')[0] || null;
    const facts = props(this._s.knowledge).filter((f) => f.status === 'active').sort((a, b) => String(a.factId).localeCompare(String(b.factId)));
    const retired = props(this._s.knowledge).filter((f) => f.status === 'retired').length;
    const adrs = this._adrs();
    const kinds = ['decision', 'answer', 'convention', 'platform', 'gap', 'risk', 'question'];
    const pill = (st) => `<span class="pill ${st === 'released' ? 'ok' : st === 'in-progress' ? 'warn' : st === 'dropped' ? 'bad' : ''}">${esc(st)}</span>`;
    const apill = (s) => `<span class="pill ${s === 'accepted' ? 'ok' : s === 'rejected' || s === 'superseded' ? 'bad' : 'warn'}">${esc(s)}</span>`;
    return `<div class="grid">
      <div class="card"><h2>The plan ${plan ? `<span class="muted">curated ${esc(when(plan.at))}</span>` : ''}</h2>
        ${plan ? `<div class="muted">${esc(plan.summary || '')}</div><table>${arr(plan.increments).map((i) => `<tr><td>${esc(i.id)}</td><td>${esc(i.title)}${arr(i.dependsOn).length ? `<div class="muted">after ${esc(arr(i.dependsOn).join(', '))}</div>` : ''}</td><td>${pill(i.status)}${i.kind ? ` <span class="pill">${esc(i.kind)}</span>` : ''}${i.specId ? ` <span class="pill">${esc(i.specId)}</span>` : ''}</td></tr>`).join('')}</table>` : '<div class="muted">No plan yet. The brain writes one after the first release.</div>'}
        <div class="row"><button class="act secondary" data-act="curate-now" ${this._paused() ? 'disabled' : ''}>Curate now (observe the last release)</button></div></div>
      <div class="card"><h2>What the Steward knows <span class="pill">${facts.length} active</span> ${retired ? `<span class="pill">${retired} retired</span>` : ''}</h2>
        ${facts.length ? kinds.filter((k) => facts.some((f) => f.kind === k)).map((k) => `<h3>${esc(k)}</h3><ul>${facts.filter((f) => f.kind === k).map((f) => `<li>${esc(f.text)} <span class="muted">(${esc(f.scope)}, ${esc(f.confidence)}, ${esc(f.source)})</span></li>`).join('')}</ul>`).join('') : '<div class="muted">Nothing curated yet. Every release produces signals; the curator turns them into facts with a source and a confidence.</div>'}</div>
      <div class="card"><h2>Decisions</h2>
        ${adrs.length ? adrs.map((a) => `<details ${a.status === 'proposed' ? 'open' : ''}><summary><b>${esc(a.adrId)}</b> ${esc(a.title)} ${apill(a.status)}</summary>
          <div class="muted">Context</div><div>${esc(a.context || '')}</div><div class="muted">Decision</div><div>${esc(a.decision || '')}</div><div class="muted">Consequences</div><div>${esc(a.consequences || '')}</div>
          <div class="row">${a.status !== 'accepted' ? `<button class="act" data-act="adr-accept" data-arg="${esc(a.adrId)}">Accept</button>` : `<button class="act secondary" data-act="adr-supersede" data-arg="${esc(a.adrId)}">Supersede</button>`}
          ${a.status === 'proposed' ? `<button class="act secondary" data-act="adr-reject" data-arg="${esc(a.adrId)}">Reject</button>` : ''}</div></details>`).join('') : '<div class="muted">None yet. The brain proposes a decision for every choice the coder made that constrains future changes; accepted ones bind every later brief.</div>'}
        <h3>The closed grammar</h3><div class="muted">A spec is one of: ${KINDS.join(', ')}. Anything else is refused by the gate, as is anything that touches the lanes and places that govern the Steward.</div></div>
    </div>`;
  }

  _journal() {
    const rows = newest(props(this._s.journal), 'at').slice(0, 150);
    return `<div class="card"><h2>Journal</h2>${rows.length ? `<table>${rows.map((j) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(j.at))}</td><td class="muted">${esc(j.stage)}</td><td>${esc(j.summary)}</td></tr>`).join('')}</table>` : '<div class="muted">Empty.</div>'}</div>`;
  }

  // ---- actions -----------------------------------------------------------------
  async _onAct(act, arg) {
    const at = nowIso();
    const f = (k) => String(this._form[k] ?? '').trim();
    const c = this._charter();
    switch (act) {
      case 'check-infra': case 'provision': case 'pause': case 'resume': case 'observe-now': case 'curate-now':
        return this._invoke(act, {}, act);
      case 'set-charter': {
        const input = { updatedAt: at, status: 'ready' };
        for (const k of CHARTER_KEYS) {
          const raw = this._form['c.' + k];
          if (LIST_KEYS.includes(k)) input[k] = raw !== undefined ? linesOf(raw) : arr(c[k]);
          else input[k] = raw !== undefined ? String(raw).trim() : String(c[k] ?? (k === 'coderAgent' ? 'claude-code' : k === 'brainAgent' ? 'llm' : k === 'autonomyLevel' ? '3' : ''));
        }
        if (input.goal && /REPLACE.?ME/i.test(input.goal)) input.goal = '';
        if (!input.goal) input.goal = this._goalUndefined(c) ? 'REPLACE ME' : c.goal;
        if (arr(c.tokenLanes).length) input.tokenLanes = arr(c.tokenLanes);
        if (c.notes) input.notes = c.notes;
        return this._invoke('set-charter', input, act);
      }
      case 'start-iteration':
        return this._invoke('start-iteration', { iterationId: `it-${stamp()}`, at, reason: 'app' }, act);
      case 'respond': case 'revise': case 'skip': {
        const p = this._openQuestion(); if (!p) return;
        const intent = act === 'respond' ? (p.kind === 'brain' ? 'knowledge' : 'answer') : 'revise';
        let selected = arr(this._form.__selected || '[]');
        let text = f('resp.text');
        if (act === 'skip') { text = ['Skip this; propose something different.', text].filter(Boolean).join(' '); selected = []; }
        if (p.mode === 'interview' && intent !== 'revise') {
          const answers = arr(p.options).map((o) => { const v = f('q.' + o.value); return v ? `${o.label}: ${v}` : ''; }).filter(Boolean);
          if (!answers.length && !text) return this._toast('Answer at least one question', true);
          text = [...answers, text].filter(Boolean).join('\n'); selected = arr(p.options).filter((o) => f('q.' + o.value)).map((o) => o.value);
        }
        if (intent === 'answer' && p.mode === 'choice' && !selected.length && !text) return this._toast('Pick an option or write your own', true);
        if (intent === 'knowledge' && !text) return this._toast('Write the answer', true);
        if (act === 'revise' && !text) return this._toast('Say how the question should be reshaped', true);
        if (intent === 'answer' && p.mode === 'goal' && this._goalUndefined(c) && !text) return this._toast('Define the goal in Setup or write it here', true);
        if (intent === 'answer' && p.mode === 'goal' && text && this._goalUndefined(c)) {
          const [first, ...rest] = text.split('\n');
          const input = { updatedAt: at, status: 'ready', goal: first.trim(), description: rest.join('\n').trim() || c.description || '' };
          for (const k of CHARTER_KEYS) if (!(k in input)) input[k] = LIST_KEYS.includes(k) ? arr(c[k]) : String(c[k] ?? '');
          if (arr(c.tokenLanes).length) input.tokenLanes = arr(c.tokenLanes);
          await this._invoke('set-charter', input, 'set-charter');
        }
        const r = await this._invoke('respond', { promptId: p.promptId, iterationId: p.iterationId, intent, selected, text, notes: f('resp.notes'), at }, act);
        this._form.__selected = '[]'; this._form['resp.text'] = ''; this._form['resp.notes'] = '';
        return r;
      }
      case 'approve-spec': return this._invoke('approve-spec', { specId: arg, notes: f('spec.notes'), at }, act + arg);
      case 'reject-spec': {
        await this._invoke('reject-spec', { specId: arg, notes: f('spec.notes'), at }, act + arg);
        return this._invoke('start-iteration', { iterationId: `it-${stamp()}`, at: nowIso(), reason: `rejected-${arg}` }, 'start-iteration');
      }
      case 'rollback': return this._invoke('rollback', { runId: arg, notes: f('run.notes.' + arg), at }, act + arg);
      case 'add-idea': {
        if (!f('idea.text')) return this._toast('Write the idea first', true);
        const ideaId = `idea-${String(this._ideas().length + 1).padStart(3, '0')}`;
        const r = await this._invoke('add-idea', { ideaId, text: f('idea.text'), at }, act);
        this._form['idea.text'] = ''; return r;
      }
      case 'drop-idea': {
        const i = this._ideas().find((x) => x.ideaId === arg); if (!i) return;
        return this._invoke('drop-idea', { ideaId: i.ideaId, text: i.text, by: i.by || 'person', at }, act + arg);
      }
      case 'adr-accept': case 'adr-reject': case 'adr-supersede': {
        const a = this._adrs().find((x) => x.adrId === arg); if (!a) return;
        const status = { 'adr-accept': 'accepted', 'adr-reject': 'rejected', 'adr-supersede': 'superseded' }[act];
        return this._invoke('decide-adr', { adrId: a.adrId, title: a.title, context: a.context || '', decision: a.decision, consequences: a.consequences || '', status, updatedAt: at }, act + arg);
      }
      default: return undefined;
    }
  }
}

if (!customElements.get('agenticos-steward-v1')) customElements.define('agenticos-steward-v1', StewardApp);
export default StewardApp;
