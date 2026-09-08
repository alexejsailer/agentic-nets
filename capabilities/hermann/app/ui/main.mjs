/**
 * Hermann: the application on top of the runtime nets (trusted-element web component, self-contained ESM).
 *
 * Six sections: Setup, Goal, Next (the iteration: a choice, an interview or a goal definition, then
 * the spec to approve), Work (runs, verification, review, merge), Quality (scorecard, factor cards),
 * Journal. Everything shown is read from stores through the injected runtime bridge; every button
 * writes a token through a declared action. Nothing here computes a number a script did not measure.
 *
 * Token properties arrive as STRINGS; nested structures as JSON text (arr()/obj() are the only readers).
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
const safeHref = (u) => { try { const p = new URL(String(u || '')); return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : ''; } catch { return ''; } };
const link = (url, label) => { const h = safeHref(url); return h ? `<a href="${esc(h)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label); };
const linesOf = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
async function idempotencyKey(action, input) {
  const canon = JSON.stringify({ action, input }, Object.keys(input).sort().concat('action', 'input'));
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon));
    return `${action}:${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch { return `${action}:${crypto.randomUUID()}`; }
}

const CSS = `
:host { display: block; container-type: inline-size; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  --fg: #1c1f24; --muted: #5d6673; --panel: #ffffff; --edge: #dfe3e8; --card: #f6f7f9; --accent: #1f6feb; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --bg: #f0f2f5; }
@media (prefers-color-scheme: dark) { :host { --fg: #e6e6e6; --muted: #9aa1ab; --panel: #16181d; --edge: #2a2d34; --card: #1d2026; --accent: #58a6ff; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --bg: #0f1115; } }
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
`;

const ROLES = ['config', 'goal', 'adr', 'cards', 'infra', 'repo', 'iterate', 'prompts', 'responses', 'specs', 'decisions', 'runs',
  'verification', 'reviews', 'scorecard', 'reports', 'journal', 'errors', 'llm-errors', 'setup-cmd', 'audit-request'];
const CONFIG_FIELDS = [
  ['artifactId', 'Service name (artifactId, repository)'], ['groupId', 'Group id'], ['packageName', 'Package (empty = derived)'], ['description', 'Description'],
  ['javaVersion', 'Java'], ['bootVersion', 'Spring Boot ("current" = current GA)'], ['dependencies', 'Initializr dependencies (comma list)'],
  ['claudeModel', 'Coder model'], ['claudeMaxTurns', 'Coder max turns'], ['implementTimeoutMin', 'Coder timeout (minutes)'],
  ['giteaImage', 'Git host image'], ['giteaPort', 'Git host port'], ['hermannHome', 'Working directory'],
];

class HermannApp extends HTMLElement {
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
    this.shadowRoot.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="empty">Loading Hermann…</div></div>`;
    await this._load(ROLES);
    for (const role of ['prompts', 'specs', 'runs', 'verification', 'reviews', 'journal']) {
      try {
        this._unsubs.push(this._rt.watchStore(role, (ev) => { this._s[role] = ev.tokens; this._render(); }, 15000));
      } catch { /* watch not granted: the sweep covers it */ }
    }
    this._timer = setInterval(() => this._load(['scorecard', 'infra', 'repo', 'errors', 'llm-errors', 'decisions', 'responses', 'adr', 'goal', 'config']), 30000);
  }
  async _load(roles) {
    await Promise.all(roles.map(async (r) => {
      try { this._s[r] = await this._rt.readStore(r, { limit: 300 }); } catch { this._s[r] = this._s[r] || []; }
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
  _config() { return newest(props(this._s.config), 'updatedAt')[0] || {}; }
  _goal() { return newest(props(this._s.goal), 'updatedAt')[0] || {}; }
  _goalUndefined(g) { return !g.title || /REPLACE.?ME/i.test(String(g.title)) || /REPLACE.?ME/i.test(String(g.description || '')); }
  _adrs() {
    const by = new Map();
    for (const a of newest(props(this._s.adr), 'updatedAt').reverse()) if (a.adrId) by.set(a.adrId, a);
    return [...by.values()].sort((a, b) => String(a.adrId).localeCompare(String(b.adrId)));
  }
  _infra() { return newest(props(this._s.infra), 'at')[0] || null; }
  _repo() { return newest(props(this._s.repo), 'updatedAt')[0] || null; }
  _scorecard() { return newest(props(this._s.scorecard), 'at')[0] || null; }
  _openPrompt() {
    const answered = new Set(props(this._s.responses).map((r) => r.promptId));
    const open = props(this._s.prompts).filter((p) => p.promptId && !answered.has(p.promptId));
    return newest(open, 'at')[0] || open[open.length - 1] || null;
  }
  _decisionsFor(kind, key) { return props(this._s.decisions).filter((d) => d.kind === kind && d[key]); }
  _draftSpec() {
    const decided = new Set(this._decisionsFor('spec-approval', 'specId').map((d) => d.specId));
    const drafts = props(this._s.specs).filter((s) => s.specId && s.status === 'draft' && !decided.has(s.specId));
    return drafts[drafts.length - 1] || null;
  }
  _runs() {
    const ver = props(this._s.verification), rev = props(this._s.reviews), dec = this._decisionsFor('merge', 'runId');
    return newest(props(this._s.runs), 'at').map((r) => ({
      run: r,
      verification: newest(ver.filter((v) => v.runId === r.runId), 'at')[0] || null,
      review: newest(rev.filter((v) => v.runId === r.runId), 'at')[0] || null,
      decisions: dec.filter((d) => d.runId === r.runId),
    }));
  }
  _working() {
    const j = newest(props(this._s.journal), 'at')[0];
    if (!j) return '';
    const stage = String(j.stage || '');
    const inFlight = { context: 'Hermann is thinking about the next iteration', code: /starts/.test(j.summary || '') ? 'The coder is implementing the spec' : '', verify: /verifying/.test(j.summary || '') ? 'Verification is running' : '' }[stage];
    return inFlight || '';
  }

  // ---- render ------------------------------------------------------------------
  _render() {
    const root = this.shadowRoot;
    const g = this._goal(), repo = this._repo(), sc = this._scorecard(), prompt = this._openPrompt(), draft = this._draftSpec();
    const awaiting = (prompt ? 1 : 0) + (draft ? 1 : 0) + this._runs().filter((x) => x.run.status === 'pr-open' && x.verification?.status === 'pass' && !x.decisions.length).length;
    const status = [
      repo ? `${repo.repoId} @ ${String(repo.headSha || '').slice(0, 7)} (Boot ${repo.bootVersion}, Java ${repo.javaVersion})` : 'no service yet',
      sc ? `scorecard ${sc.total}/36 grade ${sc.grade}` : 'no scorecard',
      this._working(),
    ].filter(Boolean).join(' · ');
    const tabs = [['setup', 'Setup'], ['goal', 'Goal & Architecture'], ['next', 'Next iteration'], ['work', 'Work'], ['quality', 'Quality'], ['journal', 'Journal']];
    const body = { setup: this._setup, goal: this._goalTab, next: this._next, work: this._work, quality: this._quality, journal: this._journal }[this._tab].call(this);
    root.innerHTML = `<style>${CSS}</style><div class="wrap">
      <header><h1>Hermann</h1><span class="status">${esc(status)}</span></header>
      <nav>${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === this._tab ? 'on' : ''}">${l}${k === 'next' && awaiting ? `<span class="n">${awaiting}</span>` : ''}</button>`).join('')}</nav>
      ${body}</div>`;
    root.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { this._tab = b.dataset.tab; this._render(); }));
    this._wire(root);
  }
  _field(name, label, value, kind = 'input', ph = '') {
    const v = this._form[name] ?? value ?? '';
    return `<label>${esc(label)}</label>${kind === 'textarea' ? `<textarea data-f="${name}" placeholder="${esc(ph)}">${esc(v)}</textarea>` : `<input data-f="${name}" value="${esc(v)}" placeholder="${esc(ph)}">`}`;
  }
  _wire(root) {
    root.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', () => { this._form[el.dataset.f] = el.value; }));
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
    const cfg = this._config(), infra = this._infra(), repo = this._repo();
    const tools = obj(infra?.tools), gitea = obj(infra?.gitea), docker = obj(infra?.docker);
    return `<div class="grid">
      <div class="card"><h2>Infrastructure ${infra ? `<span class="pill ${isTrue(infra.ok) ? 'ok' : 'bad'}">${isTrue(infra.ok) ? 'ok' : 'problems'}</span>` : ''}</h2>
        ${infra ? `<div class="muted">measured ${esc(when(infra.at))}</div>
        <table><tr><th>Docker</th><td>${esc(docker.version || 'not reachable')}</td></tr>
        <tr><th>Git host</th><td>${esc(gitea.state || 'absent')} ${gitea.version ? 'gitea ' + esc(gitea.version) : ''} ${infra.giteaUrl ? link(infra.giteaUrl, infra.giteaUrl) : ''}</td></tr>
        <tr><th>Java</th><td>${esc(tools.java || '')}</td></tr><tr><th>Maven</th><td>${esc(tools.maven || '')}</td></tr>
        <tr><th>Coder</th><td>${esc(tools.claude || 'claude missing')}</td></tr>
        <tr><th>Scanners</th><td>${['trivy', 'semgrep', 'gitleaks'].map((t) => `${t} ${tools[t] ? '✓' : '✗'}`).join(' · ')}</td></tr>
        <tr><th>Disk free</th><td>${esc(infra.diskFreeGb || '?')} GB</td></tr></table>
        ${arr(infra.problems).length ? `<ul>${arr(infra.problems).map((p) => `<li class="muted">${esc(p)}</li>`).join('')}</ul>` : ''}` : '<div class="muted">Not measured yet.</div>'}
        <div class="row"><button class="act secondary" data-act="check-infra">Check infrastructure</button>
        <button class="act" data-act="provision-git-host">${gitea.state === 'running' ? 'Re-provision git host (rotate token)' : 'Provision git host'}</button></div></div>
      <div class="card"><h2>Service ${repo ? `<span class="pill ok">${esc(repo.status)}</span>` : ''}</h2>
        ${repo ? `<table><tr><th>Repository</th><td>${link(repo.htmlUrl, repo.repoId)}</td></tr><tr><th>Head</th><td class="mono">${esc(String(repo.headSha || '').slice(0, 12))}</td></tr>
        <tr><th>Stack</th><td>Spring Boot ${esc(repo.bootVersion)}, Java ${esc(repo.javaVersion)}</td></tr><tr><th>Local path</th><td class="mono">${esc(repo.localPath)}</td></tr>
        <tr><th>Last merge</th><td>${esc(repo.lastMergedSpec || 'none')} ${repo.lastMergedAt ? esc(when(repo.lastMergedAt)) : ''}</td></tr></table>` : '<div class="muted">No service bootstrapped. Set the service name below, provision the git host, then bootstrap.</div>'}
        <div class="row"><button class="act" data-act="bootstrap-service" ${repo ? 'disabled' : ''}>Bootstrap service</button>
        <button class="act secondary" data-act="run-audit" ${repo ? '' : 'disabled'}>Run twelve-factor audit</button></div></div>
      <div class="card"><h2>Configuration</h2>
        ${CONFIG_FIELDS.map(([k, l]) => this._field('cfg.' + k, l, cfg[k])).join('')}
        <div class="row"><button class="act" data-act="set-config">Save configuration</button><span class="muted">${cfg.updatedAt ? 'saved ' + esc(when(cfg.updatedAt)) : ''}</span></div></div>
    </div>`;
  }

  _goalTab() {
    const g = this._goal(), adrs = this._adrs();
    const pill = (s) => `<span class="pill ${s === 'accepted' ? 'ok' : s === 'rejected' || s === 'superseded' ? 'bad' : 'warn'}">${esc(s)}</span>`;
    return `<div class="grid">
      <div class="card"><h2>Goal ${this._goalUndefined(g) ? '<span class="pill warn">not defined</span>' : '<span class="pill ok">defined</span>'}</h2>
        ${this._field('goal.title', 'Goal in one line', this._goalUndefined(g) ? '' : g.title)}
        ${this._field('goal.description', 'Who uses it, what it must do, what it must never do', this._goalUndefined(g) ? '' : g.description, 'textarea')}
        ${this._field('goal.principles', 'Principles (one per line)', arr(g.principles).join('\n'), 'textarea')}
        ${this._field('goal.constraints', 'Constraints (one per line)', arr(g.constraints).join('\n'), 'textarea')}
        <div class="row"><button class="act" data-act="set-goal">Save goal</button><span class="muted">${g.updatedAt ? 'saved ' + esc(when(g.updatedAt)) : ''}</span></div></div>
      <div class="card"><h2>Architecture decisions</h2>
        ${adrs.length ? adrs.map((a) => `<details><summary><b>${esc(a.adrId)}</b> ${esc(a.title)} ${pill(a.status)}</summary>
          <div class="muted">Context</div><div>${esc(a.context || '')}</div><div class="muted">Decision</div><div>${esc(a.decision || '')}</div><div class="muted">Consequences</div><div>${esc(a.consequences || '')}</div>
          <div class="row">${a.status !== 'accepted' ? `<button class="act" data-act="adr-accept" data-arg="${esc(a.adrId)}">Accept</button>` : `<button class="act secondary" data-act="adr-supersede" data-arg="${esc(a.adrId)}">Supersede</button>`}
          ${a.status === 'proposed' ? `<button class="act secondary" data-act="adr-reject" data-arg="${esc(a.adrId)}">Reject</button>` : ''}</div></details>`).join('') : '<div class="muted">None yet. Accepted decisions are part of every brief the coder and the reviewer read.</div>'}
        <h3>Propose a decision</h3>
        ${this._field('adr.title', 'Title', '')}${this._field('adr.context', 'Context', '', 'textarea')}${this._field('adr.decision', 'Decision', '', 'textarea')}${this._field('adr.consequences', 'Consequences', '', 'textarea')}
        <div class="row"><button class="act" data-act="add-adr">Add decision (proposed)</button></div></div>
    </div>`;
  }

  _next() {
    const prompt = this._openPrompt(), draft = this._draftSpec(), g = this._goal();
    const parts = [];
    if (prompt) {
      const options = arr(prompt.options);
      const selected = new Set(arr(this._form.__selected || '[]'));
      const mode = String(prompt.mode || 'choice');
      parts.push(`<div class="card"><h2>${mode === 'goal' ? 'Hermann needs the goal' : mode === 'interview' ? 'Hermann has questions' : 'Hermann proposes the next iteration'} <span class="pill">${esc(prompt.promptId)}</span></h2>
        <div>${esc(prompt.question)}</div>${prompt.context ? `<div class="muted" style="margin-top:6px">${esc(prompt.context)}</div>` : ''}
        ${mode === 'goal' ? `<div class="row"><span class="muted">Define the goal in the Goal tab, then answer here (or paste one of the examples).</span></div>` : ''}
        ${options.map((o) => mode === 'interview'
          ? `<div class="opt" data-opt="${esc(o.value)}" data-multi="true"><div class="t">${esc(o.label)}</div><div class="muted">${esc(o.description || '')}</div>${this._field('q.' + o.value, 'Your answer', '', 'textarea')}</div>`
          : `<div class="opt ${selected.has(String(o.value)) ? 'sel' : ''}" data-opt="${esc(o.value)}" data-multi="${mode === 'goal' ? 'false' : 'false'}"><div class="t">${esc(o.label)} ${isTrue(o.recommended) ? '<span class="pill rec">recommended</span>' : ''} ${o.effort ? `<span class="pill">effort ${esc(o.effort)}</span>` : ''} ${o.risk ? `<span class="pill">risk ${esc(o.risk)}</span>` : ''} ${arr(o.factors).length ? `<span class="pill">factors ${esc(arr(o.factors).join(','))}</span>` : ''}</div><div class="muted">${esc(o.description || '')}</div></div>`).join('')}
        ${this._field('resp.text', mode === 'goal' ? 'The goal (one line, then a paragraph)' : 'Your own words (optional; a free-text option or additional guidance)', '', 'textarea')}
        ${this._field('resp.notes', 'Notes for the spec (optional)', '')}
        ${prompt.rationale ? `<details><summary>Why these options</summary><div>${esc(prompt.rationale)}</div></details>` : ''}
        <div class="row"><button class="act" data-act="respond">Answer</button><button class="act secondary" data-act="revise">Reshape the question</button><button class="act secondary" data-act="reject-prompt">Skip</button></div></div>`);
    }
    if (draft) {
      const li = (v) => arr(v).map((x) => `<li>${esc(typeof x === 'object' ? `${x.name}: ${x.purpose} (default ${x.default ?? ''})` : x)}</li>`).join('');
      parts.push(`<div class="card"><h2>Spec to approve: ${esc(draft.specId)} <span class="pill warn">draft</span></h2>
        <div><b>${esc(draft.title)}</b></div><div>${esc(draft.summary)}</div><div class="muted" style="margin-top:6px">${esc(draft.story)}</div>
        <h3>Acceptance criteria</h3><ul>${li(draft.acceptance)}</ul><h3>API</h3><ul>${li(draft.api)}</ul><h3>Data</h3><ul>${li(draft.data)}</ul>
        <h3>Configuration</h3><ul>${li(draft.config)}</ul><h3>Tests</h3><ul>${li(draft.tests)}</ul><h3>Factors</h3><ul>${li(draft.factors)}</ul>
        <h3>Out of scope</h3><ul>${li(draft.outOfScope)}</ul>${arr(draft.risks).length ? `<h3>Risks</h3><ul>${li(draft.risks)}</ul>` : ''}
        ${this._field('spec.notes', 'Notes for the coder (optional)', '')}
        <div class="row"><button class="act" data-act="approve-spec" data-arg="${esc(draft.specId)}">Approve and implement</button><button class="act secondary" data-act="reject-spec" data-arg="${esc(draft.specId)}">Reject</button></div></div>`);
    }
    if (!prompt && !draft) {
      const working = this._working();
      parts.push(`<div class="card"><h2>Next iteration</h2>
        ${working ? `<div>${esc(working)}…</div>` : `<div class="muted">${this._goalUndefined(g) ? 'The goal is not defined yet; Hermann will ask for it first.' : 'Nothing is waiting for you. Ask Hermann what to do next.'}</div>`}
        <div class="row"><button class="act" data-act="start-iteration" ${working ? 'disabled' : ''}>Ask Hermann for the next iteration</button></div></div>`);
    }
    return `<div class="grid">${parts.join('')}</div>`;
  }

  _work() {
    const rows = this._runs();
    if (!rows.length) return '<div class="card"><div class="muted">No runs yet. Approve a spec in Next iteration.</div></div>';
    return `<div class="grid">${rows.map(({ run, verification: v, review: r, decisions: d }) => {
      const merged = run.status === 'merged' || d.some((x) => x.verdict === 'merge');
      const changes = d.some((x) => x.verdict === 'changes');
      const canMerge = !merged && run.status === 'pr-open' && v?.status === 'pass';
      return `<div class="card"><h2>${esc(run.specId)} <span class="muted">${esc(run.title || '')}</span> <span class="pill ${merged ? 'ok' : run.status === 'failed' ? 'bad' : 'warn'}">${esc(merged ? 'merged' : run.status)}</span> <span class="pill">attempt ${esc(run.attempt)}</span></h2>
        <table><tr><th>Branch</th><td class="mono">${esc(run.branch)} @ ${esc(String(run.headSha || '').slice(0, 7))}</td></tr>
        <tr><th>Pull request</th><td>${run.prUrl ? link(run.prUrl, '#' + run.prIndex) : 'not opened'}</td></tr>
        <tr><th>Build</th><td>${isTrue(run.buildOk) ? 'green' : 'RED'}: ${esc(run.testsRun)} tests, ${esc(run.testsFailed)} failed; ${esc(run.diffStat)}</td></tr>
        <tr><th>Coder</th><td>${esc(run.coderDurationSec)}s, ${esc(run.coderTurns || '?')} turns${run.coderCostUsd ? `, $${Number(run.coderCostUsd).toFixed(2)}` : ''}</td></tr>
        <tr><th>Verification</th><td>${v ? `<span class="pill ${v.status === 'pass' ? 'ok' : 'bad'}">${esc(v.status)}</span> ${esc(v.testsRun)} tests, startup ${esc(v.startupSeconds)}s, shutdown ${esc(v.shutdownSeconds)}s, logs ${isTrue(v.logsStructured) ? 'structured' : 'unstructured'}` : (isTrue(run.buildOk) ? 'running…' : 'skipped')}</td></tr>
        <tr><th>Review</th><td>${r ? `<span class="pill ${r.verdict === 'approve' ? 'ok' : 'warn'}">${esc(r.verdict)}</span> ${esc(r.summary)}` : (v?.status === 'pass' ? 'running…' : '')}</td></tr></table>
        <details><summary>Coder summary and notes</summary><div>${esc(run.coderSummary)}</div><div class="muted">${esc(run.coderNotes || '')}</div>${run.buildTail ? `<div class="mono">${esc(run.buildTail)}</div>` : ''}</details>
        ${v ? `<details><summary>Verification evidence</summary><ul>${arr(v.evidence).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
        ${r ? `<details><summary>Review points (${arr(r.points).length})</summary><ul>${arr(r.points).map((p) => `<li><b>${esc(p.severity)}</b> ${esc(p.file)}: ${esc(p.comment)}</li>`).join('')}</ul>${arr(r.acceptanceMissing).length ? `<div class="muted">Missing: ${esc(arr(r.acceptanceMissing).join('; '))}</div>` : ''}</details>` : ''}
        ${!merged ? `${this._field('run.notes.' + run.runId, 'Notes (for a change request)', '')}
        <div class="row"><button class="act" data-act="merge" data-arg="${esc(run.runId)}" ${canMerge ? '' : 'disabled'}>Merge</button><button class="act secondary" data-act="request-changes" data-arg="${esc(run.runId)}" ${changes ? 'disabled' : ''}>Request changes</button></div>` : `<div class="muted">merged as ${esc(String(run.mergedSha || '').slice(0, 7))} ${esc(when(run.mergedAt))}</div>`}</div>`;
    }).join('')}</div>`;
  }

  _quality() {
    const sc = this._scorecard(), cards = props(this._s.cards).sort((a, b) => String(a.factor).localeCompare(String(b.factor)));
    const reports = sc ? props(this._s.reports).filter((r) => r.sha === sc.sha) : [];
    const rep = (n) => reports.find((r) => r.factor === n);
    const errs = newest(props(this._s.errors), 'at').slice(0, 8), llm = newest(props(this._s['llm-errors']), 'at').slice(0, 5);
    return `<div class="grid">
      <div class="card"><h2>Twelve-factor scorecard ${sc ? `<span class="pill ${sc.grade === 'A' ? 'ok' : sc.grade === 'B' ? 'warn' : 'bad'}">grade ${esc(sc.grade)}</span>` : ''}</h2>
        ${sc ? `<div class="big">${esc(sc.total)}<span class="muted" style="font-size:14px"> / 36 at ${esc(sc.sha7)} · ${esc(when(sc.at))}</span></div>
        <table><tr><th>Factor</th><th>Score</th><th>Evidence / fix</th></tr>${arr(sc.factors).map((f) => { const r = rep(f.factor); return `<tr><td>${esc(f.factor)} ${esc(f.name)}</td><td><span class="pill ${f.status === 'pass' ? 'ok' : f.status === 'weak' ? 'warn' : 'bad'}">${esc(f.score)}/3</span></td><td>${f.status === 'pass' ? `<span class="muted">${esc(arr(r?.evidence)[0] || '')}</span>` : `${esc(arr(r?.evidence).join(' · '))}<div class="muted">fix: ${esc(f.fix)}</div>`}</td></tr>`; }).join('')}</table>` : '<div class="muted">No scorecard yet.</div>'}
        <div class="row"><button class="act secondary" data-act="run-audit">Run audit now</button></div></div>
      <div class="card"><h2>The twelve factors</h2>${cards.map((c) => `<details><summary><b>${esc(c.title)}</b> <span class="muted">${esc(c.tagline)}</span></summary><div class="muted">Rule</div><div>${esc(c.rule)}</div><div class="muted">Practice</div><div>${esc(c.practice)}</div><div class="muted">Check</div><div>${esc(c.check)}</div></details>`).join('')}</div>
      ${errs.length || llm.length ? `<div class="card"><h2>Errors</h2>${errs.map((e) => `<div><span class="muted">${esc(when(e.at))} ${esc(e.lane)}/${esc(e.stage)}</span> ${esc(e.message)}</div>`).join('')}${llm.map((e) => `<div><span class="muted">answer contract</span> ${esc(arr(e.problems).join('; ') || e.problems)}</div>`).join('')}</div>` : ''}
    </div>`;
  }

  _journal() {
    const rows = newest(props(this._s.journal), 'at').slice(0, 120);
    return `<div class="card"><h2>Journal</h2>${rows.length ? `<table>${rows.map((j) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(j.at))}</td><td class="muted">${esc(j.stage)}</td><td>${esc(j.summary)}</td></tr>`).join('')}</table>` : '<div class="muted">Empty.</div>'}</div>`;
  }

  // ---- actions -----------------------------------------------------------------
  async _onAct(act, arg) {
    const at = nowIso();
    const f = (k) => String(this._form[k] ?? '').trim();
    const cfg = this._config(), g = this._goal();
    switch (act) {
      case 'check-infra': case 'provision-git-host': case 'bootstrap-service':
        return this._invoke(act, {}, act);
      case 'run-audit':
        return this._invoke('run-audit', { at, repoId: this._repo()?.repoId || '' }, act);
      case 'set-config': {
        const input = { updatedAt: at, status: 'ready' };
        for (const [k] of CONFIG_FIELDS) input[k] = this._form['cfg.' + k] ?? cfg[k] ?? '';
        for (const k of ['giteaSshPort', 'giteaUser', 'giteaContainer', 'giteaVolume', 'blockingSeverity']) if (cfg[k]) input[k] = cfg[k];
        if (arr(cfg.tokenLanes).length) input.tokenLanes = arr(cfg.tokenLanes);
        return this._invoke('set-config', input, act);
      }
      case 'set-goal': {
        const title = f('goal.title') || (this._goalUndefined(g) ? '' : g.title);
        if (!title) return this._toast('Give the goal a title', true);
        return this._invoke('set-goal', { title, description: f('goal.description') || g.description || '', principles: linesOf(this._form['goal.principles'] ?? arr(g.principles).join('\n')), constraints: linesOf(this._form['goal.constraints'] ?? arr(g.constraints).join('\n')), updatedAt: at }, act);
      }
      case 'add-adr': {
        if (!f('adr.title') || !f('adr.decision')) return this._toast('A decision needs a title and the decision itself', true);
        const adrId = `adr-${String(this._adrs().length + 1).padStart(3, '0')}`;
        return this._invoke('add-adr', { adrId, title: f('adr.title'), context: f('adr.context'), decision: f('adr.decision'), consequences: f('adr.consequences'), updatedAt: at }, act);
      }
      case 'adr-accept': case 'adr-reject': case 'adr-supersede': {
        const a = this._adrs().find((x) => x.adrId === arg); if (!a) return;
        const status = { 'adr-accept': 'accepted', 'adr-reject': 'rejected', 'adr-supersede': 'superseded' }[act];
        return this._invoke('decide-adr', { adrId: a.adrId, title: a.title, context: a.context || '', decision: a.decision, consequences: a.consequences || '', status, updatedAt: at }, act + arg);
      }
      case 'start-iteration':
        return this._invoke('start-iteration', { iterationId: `it-${stamp()}`, at }, act);
      case 'respond': case 'revise': case 'reject-prompt': {
        const p = this._openPrompt(); if (!p) return;
        const intent = act === 'respond' ? 'answer' : act === 'revise' ? 'revise' : 'reject';
        let selected = arr(this._form.__selected || '[]');
        let text = f('resp.text');
        if (p.mode === 'interview' && intent === 'answer') {
          const answers = arr(p.options).map((o) => { const v = f('q.' + o.value); return v ? `${o.label}: ${v}` : ''; }).filter(Boolean);
          if (!answers.length && !text) return this._toast('Answer at least one question', true);
          text = [...answers, text].filter(Boolean).join('\n'); selected = arr(p.options).filter((o) => f('q.' + o.value)).map((o) => o.value);
        }
        if (intent === 'answer' && p.mode === 'choice' && !selected.length && !text) return this._toast('Pick an option or write your own', true);
        if (intent === 'revise' && !text) return this._toast('Say how the question should be reshaped', true);
        if (intent === 'answer' && p.mode === 'goal' && this._goalUndefined(this._goal()) && !text) return this._toast('Define the goal first (Goal tab) or write it here', true);
        const r = await this._invoke('respond', { promptId: p.promptId, iterationId: p.iterationId, intent, selected, text, notes: f('resp.notes'), at }, act);
        if (intent === 'answer' && p.mode === 'goal' && text && this._goalUndefined(this._goal())) {
          const [first, ...rest] = text.split('\n');
          await this._invoke('set-goal', { title: first.trim(), description: rest.join('\n').trim() || first.trim(), principles: arr(this._goal().principles), constraints: arr(this._goal().constraints), updatedAt: nowIso() }, 'set-goal');
        }
        this._form.__selected = '[]'; this._form['resp.text'] = ''; this._form['resp.notes'] = '';
        return r;
      }
      case 'approve-spec': return this._invoke('approve-spec', { specId: arg, notes: f('spec.notes'), at }, act + arg);
      case 'reject-spec': return this._invoke('reject-spec', { specId: arg, notes: f('spec.notes'), at }, act + arg);
      case 'merge': return this._invoke('merge', { runId: arg, notes: f('run.notes.' + arg), at }, act + arg);
      case 'request-changes': {
        if (!f('run.notes.' + arg)) return this._toast('Write what should change', true);
        return this._invoke('request-changes', { runId: arg, notes: f('run.notes.' + arg), at }, act + arg);
      }
      default: return undefined;
    }
  }
}

if (!customElements.get('agenticos-hermann-v1')) customElements.define('agenticos-hermann-v1', HermannApp);
export default HermannApp;
