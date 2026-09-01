/**
 * Web Investigator dashboard — trusted-element web component (self-contained ESM).
 *
 * Reads ONLY through the injected `runtime` bridge (readStore/watchStore/invoke) and renders
 * the investigation as a decision surface: coverage matrix, true gaps, fresh competitor
 * articles with own-coverage verdicts, the latest analysis, the task queue and the crawl
 * controls. Every field label is generic — the domain lives in the runtime tokens, never here.
 *
 * Token properties arrive as STRINGS (numbers included) and nested structures as JSON text;
 * num()/arr() below are the only two ways this file reads them.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const arr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const obj = (v) => {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
const newestFirst = (tokens, field) =>
  [...tokens].sort((a, b) =>
    String(b.properties?.[field] ?? '').localeCompare(String(a.properties?.[field] ?? '')));

const CSS = `
:host { display: block; container-type: inline-size;
  font-family: var(--sans, system-ui, sans-serif); color: var(--fg, #e6e6e6); }
* { box-sizing: border-box; }
.wrap { display: grid; gap: 14px; }
.bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  background: var(--panel, #16181d); border: 1px solid var(--edge, #2a2d34);
  border-radius: 10px; padding: 10px 14px; }
.stat { display: flex; flex-direction: column; min-width: 84px; }
.stat b { font-size: 20px; line-height: 1.1; }
.stat span { color: var(--muted, #9aa1ab); font-size: 11px; text-transform: uppercase;
  letter-spacing: .04em; }
.spacer { flex: 1; }
button { font: inherit; color: var(--fg, #e6e6e6); background: var(--card, #1d2026);
  border: 1px solid var(--edge, #2a2d34); border-radius: 7px; padding: 5px 11px;
  cursor: pointer; }
button:hover { border-color: var(--acc, #5aa2ff); }
button.acc { background: var(--acc, #2f6fdd); border-color: transparent; color: #fff; }
button.ghost { background: transparent; }
button:disabled { opacity: .45; cursor: default; }
.grid { display: grid; gap: 14px; grid-template-columns: 1fr; }
@container (min-width: 880px) { .grid { grid-template-columns: 3fr 2fr; } }
.card { background: var(--panel, #16181d); border: 1px solid var(--edge, #2a2d34);
  border-radius: 10px; padding: 14px; min-width: 0; }
.card h3 { margin: 0 0 4px; font-size: 14px; }
.card .sub { color: var(--muted, #9aa1ab); font-size: 12px; margin: 0 0 10px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--muted, #9aa1ab); font-weight: 500; font-size: 11px;
  text-transform: uppercase; letter-spacing: .04em; padding: 4px 8px 6px 0; }
td { padding: 5px 8px 5px 0; border-top: 1px solid var(--edge, #23262d); vertical-align: top; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
.cat { font-weight: 600; }
.covbar { display: inline-block; width: 74px; height: 7px; border-radius: 4px;
  background: color-mix(in srgb, var(--err, #d9534f) 55%, transparent); overflow: hidden;
  vertical-align: middle; }
.covbar i { display: block; height: 100%;
  background: color-mix(in srgb, var(--acc, #4a8f5c) 80%, transparent); }
.badge { display: inline-block; font-size: 10.5px; padding: 1px 7px; border-radius: 9px;
  border: 1px solid var(--edge, #2a2d34); color: var(--muted, #9aa1ab); white-space: nowrap; }
.badge.hot { color: #fff; background: var(--err, #b33); border-color: transparent; }
.badge.warm { color: #fff; background: var(--acc, #2f6fdd); border-color: transparent; }
.badge.ok { border-color: var(--acc, #4a8f5c); color: var(--acc, #7fc08d); }
.row { display: flex; gap: 8px; align-items: baseline; padding: 7px 0;
  border-top: 1px solid var(--edge, #23262d); }
.row:first-of-type { border-top: 0; }
.row .t { flex: 1; min-width: 0; }
.row .t a { color: inherit; text-decoration: none; }
.row .t a:hover { color: var(--acc, #5aa2ff); }
.row .meta { color: var(--muted, #9aa1ab); font-size: 11.5px; margin-top: 1px;
  overflow-wrap: anywhere; }
.row .acts { display: flex; gap: 5px; flex-shrink: 0; }
.row .acts button { padding: 2px 8px; font-size: 12px; }
details.digest > summary { cursor: pointer; font-weight: 600; font-size: 13px; padding: 5px 0; }
details.digest p { margin: 4px 0 10px; font-size: 13px; line-height: 1.45;
  color: color-mix(in srgb, var(--fg, #e6e6e6) 88%, transparent); }
.rec { border: 1px solid var(--edge, #2a2d34); border-radius: 8px; padding: 9px 11px;
  margin: 8px 0; font-size: 13px; line-height: 1.4; }
.rec .acts { margin-top: 7px; display: flex; gap: 6px; }
form.inline { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
form.inline input, form.inline select { flex: 1; min-width: 130px; font: inherit;
  color: var(--fg, #e6e6e6); background: var(--card, #1d2026);
  border: 1px solid var(--edge, #2a2d34); border-radius: 7px; padding: 5px 9px; }
.task-done { opacity: .55; }
.toast { position: sticky; bottom: 8px; display: none; margin-top: 6px; padding: 8px 12px;
  border-radius: 8px; font-size: 13px; background: var(--card, #1d2026);
  border: 1px solid var(--acc, #2f6fdd); }
.toast.err { border-color: var(--err, #b33); }
.toast.show { display: block; }
.empty { color: var(--muted, #9aa1ab); font-size: 13px; padding: 8px 0; }
.footnote { color: var(--muted, #9aa1ab); font-size: 11.5px; margin-top: 8px; }
`;

class WebInvestigatorDashboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._stores = {};
    this._unsubs = [];
    this._busy = new Set();
  }

  set runtime(rt) {
    this._rt = rt;
    if (this.isConnected) this._boot();
  }
  get runtime() {
    return this._rt;
  }

  connectedCallback() {
    if (this._rt) this._boot();
  }
  disconnectedCallback() {
    for (const u of this._unsubs.splice(0)) {
      try { u(); } catch { /* already gone */ }
    }
  }

  async _boot() {
    this.shadowRoot.innerHTML =
      `<style>${CSS}</style><div class="wrap"><div class="empty">Loading…</div></div>`;
    await this._load();
    // Live refresh only for the stores a decision changes; the corpus reloads on demand.
    for (const role of ['tasks', 'decisions', 'requests']) {
      this._unsubs.push(
        this._rt.watchStore(role, (ev) => {
          this._stores[role] = ev.tokens;
          this._render();
        }, 4000),
      );
    }
  }

  async _load() {
    const roles = ['brief', 'taxonomy', 'digest', 'brand-new', 'recent', 'insights',
      'frontier', 'queries', 'tasks', 'decisions', 'requests', 'owned', 'drafts'];
    await Promise.all(roles.map(async (r) => {
      try { this._stores[r] = await this._rt.readStore(r); }
      catch { this._stores[r] = []; }
    }));
    this._render();
  }

  // ---- data shaping -------------------------------------------------------

  /**
   * The facts token is TRANSIENT — the analysis lane consumes it — so nothing here may
   * depend on it. Category tokens persist and carry the coverage split; the recency
   * stores persist and carry the fresh articles. Facts, when present, only enriches.
   */
  _facts() {
    const t = (this._stores.taxonomy || []).find((x) => x.properties?.kind === 'facts');
    return t ? { token: t, parsed: obj(t.properties.factsJson) || {}, fresh: arr(t.properties.freshTextJson) } : null;
  }
  _categories() {
    return (this._stores.taxonomy || [])
      .map((x) => x.properties)
      .filter((p) => p?.category && p.category !== 'unrelated' && p.kind !== 'facts');
  }
  _freshRows(facts) {
    if (facts?.fresh?.length) return facts.fresh;
    // Fallback: build the list from the persistent recency buckets (no own-coverage verdict).
    const fromStore = (role, recency) => (this._stores[role] || []).map((t) => ({
      title: t.properties?.title, url: t.properties?.url, category: t.properties?.category,
      publishedAt: t.properties?.publishedAt, recency,
      host: String(t.properties?.url || '').split('/')[2]?.replace(/^www\./, '') || '',
    }));
    return [...fromStore('brand-new', 'brand-new'), ...fromStore('recent', 'recent')]
      .filter((a) => a.title && a.url)
      .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
  }
  _digest() {
    const rows = (this._stores.digest || []).filter((t) => t.properties?.kind === 'landscape-analysis');
    return newestFirst(rows, 'generatedAt')[0] || null;
  }
  _dismissed() {
    return new Set((this._stores.decisions || [])
      .map((d) => d.properties?.subject || d.properties?.url).filter(Boolean));
  }

  // ---- actions ------------------------------------------------------------

  async _invoke(action, input, busyKey) {
    if (this._busy.has(busyKey)) return;
    this._busy.add(busyKey);
    this._render();
    try {
      await this._rt.invoke(action, input, { idempotencyKey: busyKey.slice(0, 200) });
      this._toast(`${action} ✓`);
      await this._load();
    } catch (e) {
      const code = e?.code || '';
      this._toast(
        code === 'conflict' ? 'Someone else changed this — view refreshed.'
          : (e?.message || `${action} failed`),
        true,
      );
      if (code === 'conflict') await this._load();
    } finally {
      this._busy.delete(busyKey);
      this._render();
    }
  }

  _accept(title, extras = {}) {
    const taskId = `task-${slug(title)}`;
    this._invoke('accept-recommendation', { taskId, title, ...extras }, `acc:${taskId}`);
  }
  _dismiss(subject, reason) {
    const decisionId = `dec-${slug(subject)}`;
    this._invoke('dismiss', { decisionId, subject, ...(reason ? { reason } : {}) }, `dis:${decisionId}`);
  }
  _covered(url, ownSlug) {
    const decisionId = `cov-${slug(url)}`;
    this._invoke('mark-covered', { decisionId, url, ...(ownSlug ? { ownSlug } : {}) }, `cov:${decisionId}`);
  }
  _complete(taskId, note) {
    this._invoke('complete-task', { taskId, ...(note ? { note } : {}) }, `done:${taskId}:${slug(note || '')}`);
  }
  _run(what) {
    const requestId = `run-${what}-${crypto.randomUUID().slice(0, 8)}`;
    this._invoke('request-run', { requestId, run: what }, `run:${requestId}`);
  }

  _toast(msg, isErr = false) {
    const el = this.shadowRoot.querySelector('.toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `toast show${isErr ? ' err' : ''}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.className = 'toast'; }, 4200);
  }

  // ---- rendering ----------------------------------------------------------

  _render() {
    const s = this._stores;
    const facts = this._facts();
    const digest = this._digest();
    const brief = (s.brief || [])[0]?.properties || {};
    const tasks = s.tasks || [];
    const open = tasks.filter((t) => t.properties?.status === 'accepted');
    const cats = this._categories();
    const findings = cats.reduce((n, c) => n + num(c.total), 0);
    const own = (s.owned || []).length;
    const uncovered = cats.reduce((n, c) => n + num(c.ownUncovered), 0);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="bar">
        <div class="stat"><b>${findings}</b><span>findings</span></div>
        <div class="stat"><b>${uncovered}</b><span>uncovered</span></div>
        <div class="stat"><b>${own}</b><span>own articles</span></div>
        <div class="stat"><b>${open.length}</b><span>open tasks</span></div>
        <div class="spacer"></div>
        <button data-run="taxonomy" ${this._runBusy() ? 'disabled' : ''}>Run rollup</button>
        <button data-run="owned" ${this._runBusy() ? 'disabled' : ''}>Re-index own site</button>
        <button data-run="health" ${this._runBusy() ? 'disabled' : ''}>Crawl health</button>
        <button class="acc" data-run="write" ${this._runBusy() ? 'disabled' : ''}
          title="Assemble the next accepted task and let the staff writer draft it">Draft article</button>
        <button class="ghost" data-refresh title="Reload every store">↻</button>
      </div>
      <div class="grid">
        <div style="display:grid;gap:14px;min-width:0">
          ${this._matrixCard(cats)}
          ${this._freshCard(facts)}
          ${this._digestCard(digest)}
        </div>
        <div style="display:grid;gap:14px;min-width:0;align-content:start">
          ${this._tasksCard(tasks)}
          ${this._draftsCard(s.drafts || [])}
          ${this._crawlCard(s, brief)}
          ${this._decisionsCard(s.decisions || [])}
        </div>
      </div>
      <div class="toast"></div>`;

    this._wire(wrap, facts, digest);
    this.shadowRoot.innerHTML = `<style>${CSS}</style>`;
    this.shadowRoot.appendChild(wrap);
  }

  _runBusy() {
    return [...this._busy].some((k) => k.startsWith('run:'));
  }

  _matrixCard(categories) {
    const cats = [...categories].sort((a, b) => num(b.ownUncovered) - num(a.ownUncovered));
    if (!cats.length) return `<div class="card"><h3>Coverage</h3><div class="empty">No rollup yet — press “Run rollup”.</div></div>`;
    const rows = cats.map((c) => {
      const total = num(c.total);
      const cov = num(c.ownCovered);
      const pct = total ? Math.round((cov / total) * 100) : 0;
      return `<tr>
        <td class="cat">${esc(c.category)}</td>
        <td class="n">${num(c.brandNew) || ''}</td><td class="n">${num(c.recent) || ''}</td>
        <td class="n">${num(c.archive)}</td><td class="n">${total}</td>
        <td><span class="covbar" title="${cov}/${total} covered by own articles"><i style="width:${pct}%"></i></span>
            <span class="badge ${num(c.ownUncovered) ? '' : 'ok'}">${num(c.ownUncovered)} open</span></td>
      </tr>`;
    }).join('');
    return `<div class="card">
      <h3>Coverage by category</h3>
      <p class="sub">Competitor volume by recency, and how much of it your own inventory already answers.</p>
      <div style="overflow-x:auto"><table>
        <tr><th>category</th><th class="n">new</th><th class="n">recent</th><th class="n">archive</th><th class="n">total</th><th>own coverage</th></tr>
        ${rows}
      </table></div></div>`;
  }

  _freshCard(facts) {
    const fresh = this._freshRows(facts);
    if (!fresh.length) return '';
    const dismissed = this._dismissed();
    const tasksById = new Set((this._stores.tasks || []).map((t) => t.properties?.taskId));
    const rows = fresh.map((a, i) => {
      const hasVerdict = a.coveredByOwn !== undefined;
      const covered = String(a.coveredByOwn) === 'true' || a.coveredByOwn === true;
      const accepted = tasksById.has(`task-${slug(a.title)}`);
      const gone = dismissed.has(a.url);
      const badge = covered
        ? `<span class="badge ok" title="closest own article: ${esc(a.closestOwnSlug || '')}">covered</span>`
        : `<span class="badge ${a.recency === 'brand-new' ? 'hot' : 'warm'}">${esc(a.recency)}</span>`;
      return `<div class="row">
        <div class="t">
          <div><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></div>
          <div class="meta">${esc(a.publishedAt || '')} · ${esc(a.host || '')} · ${esc(a.category || '')}
            ${!hasVerdict ? '' : covered ? ` · own: ${esc(a.closestOwnSlug || '')}` : ' · no own equivalent'}</div>
        </div>
        <div>${badge}</div>
        <div class="acts">
          ${accepted ? '<span class="badge ok">task ✓</span>' : gone ? '<span class="badge">dismissed</span>' : `
          <button class="acc" data-fresh-accept="${i}" title="Create an article task with this evidence">Accept</button>
          ${covered ? '' : `<button data-fresh-covered="${i}" title="I already cover this">Covered</button>`}
          <button class="ghost" data-fresh-dismiss="${i}">✕</button>`}
        </div>
      </div>`;
    }).join('');
    return `<div class="card"><h3>Fresh competitor articles</h3>
      <p class="sub">What the competition published inside the recency windows, with your coverage verdict.</p>
      ${rows}</div>`;
  }

  _digestCard(digest) {
    if (!digest) return `<div class="card"><h3>Latest analysis</h3><div class="empty">No analysis yet.</div></div>`;
    const p = digest.properties;
    const recs = arr(p.recommendations);
    const dismissed = this._dismissed();
    const tasksBy = new Set((this._stores.tasks || []).map((t) => t.properties?.taskId));
    const section = (label, text, openAttr = '') => text
      ? `<details class="digest" ${openAttr}><summary>${label}</summary><p>${esc(text)}</p></details>` : '';
    const recCards = recs.map((r, i) => {
      const first = String(r).split(/[.!?]\s/)[0].slice(0, 90);
      const accepted = tasksBy.has(`task-${slug(first)}`);
      const gone = dismissed.has(String(r).slice(0, 120));
      return `<div class="rec">${esc(r)}
        <div class="acts">
          ${accepted ? '<span class="badge ok">task ✓</span>' : gone ? '<span class="badge">dismissed</span>' : `
          <button class="acc" data-rec-accept="${i}">Accept as task</button>
          <button class="ghost" data-rec-dismiss="${i}">Dismiss</button>`}
        </div></div>`;
    }).join('');
    return `<div class="card">
      <h3>Latest analysis</h3>
      <p class="sub">${esc(p.generatedAt || '')} · ${esc(p.totalFindings || '?')} findings</p>
      ${section('Fresh signal — what they are actually writing', p.freshSignal, 'open')}
      ${section('Your position', p.ownPosition)}
      ${section('Gaps', p.gaps)}
      ${section('Owned angles', p.ownedAngles)}
      ${section('Freshness', p.freshness)}
      ${recCards || '<div class="empty">No recommendations in this analysis.</div>'}
    </div>`;
  }

  _tasksCard(tasks) {
    const drafted = new Set((this._stores.drafts || []).map((d) => d.properties?.taskId));
    const rows = newestFirst(tasks, 'createdAt').map((t) => {
      const p = t.properties;
      const done = p.status === 'done';
      return `<div class="row ${done ? 'task-done' : ''}">
        <div class="t">
          <div>${esc(p.title)}</div>
          <div class="meta">${esc(p.taskId)}${p.gapCategory ? ` · ${esc(p.gapCategory)}` : ''}${p.doneNote ? ` · ${esc(p.doneNote)}` : ''}
            ${p.competitorUrl ? ` · <a href="${esc(p.competitorUrl)}" target="_blank" rel="noopener">evidence</a>` : ''}</div>
        </div>
        <div>${done ? '<span class="badge ok">done</span>' : '<span class="badge warm">accepted</span>'}
          ${drafted.has(p.taskId) ? ' <span class="badge ok">draft ✓</span>' : ''}</div>
        <div class="acts">${done ? '' : `<button data-task-done="${esc(p.taskId)}">Done</button>`}</div>
      </div>`;
    }).join('');
    return `<div class="card"><h3>Article tasks</h3>
      <p class="sub">Accepted recommendations with their evidence. “Draft article” above writes the next one; “Done” records the outcome atomically.</p>
      ${rows || '<div class="empty">Nothing accepted yet — the gap lists on the left feed this queue.</div>'}</div>`;
  }

  _draftsCard(drafts) {
    if (!drafts.length) return '';
    const rows = newestFirst(drafts, 'ts').map((d, i) => {
      const p = d.properties;
      const md = String(p.draftMarkdown || '');
      return `<details class="digest">
        <summary>${esc(p.title)} <span class="badge">${esc(p.wordCount || '?')} words</span></summary>
        <div class="acts" style="margin:6px 0"><button data-draft-copy="${i}">Copy markdown</button></div>
        <p style="white-space:pre-wrap;font-family:var(--mono,monospace);font-size:12px;max-height:340px;overflow:auto">${esc(md)}</p>
      </details>`;
    }).join('');
    return `<div class="card"><h3>Drafts</h3>
      <p class="sub">Written by the staff-writer lane from the task's evidence. Copy, publish, then mark the task Done.</p>
      ${rows}</div>`;
  }

  _crawlCard(s, brief) {
    return `<div class="card"><h3>Steer the crawl</h3>
      <p class="sub">frontier ${(s.frontier || []).length} queued · ${(s.queries || []).length} search queries · topic: ${esc(brief.topic || '—')}</p>
      <form class="inline" data-form="url">
        <input name="url" type="url" required placeholder="https:// … queue a page for the crawl">
        <button class="acc">Queue URL</button>
      </form>
      <form class="inline" data-form="query">
        <input name="query" required placeholder="search query for the widening lane">
        <button>Queue query</button>
      </form>
      <div class="footnote">Run-now requests are executed by the net's own lane — the app only records them.</div>
    </div>`;
  }

  _decisionsCard(decisions) {
    const rows = newestFirst(decisions, 'createdAt').slice(0, 8).map((d) => {
      const p = d.properties;
      return `<div class="row">
        <div class="t"><div>${esc(p.subject || p.url || p.taskId || p.decisionId)}</div>
          <div class="meta">${esc(p.reason || p.note || p.ownSlug || '')}</div></div>
        <span class="badge">${esc(p.verdict || 'decision')}</span>
      </div>`;
    }).join('');
    return `<div class="card"><h3>Decision log</h3>${rows || '<div class="empty">No decisions yet.</div>'}</div>`;
  }

  _wire(wrap, facts, digest) {
    wrap.querySelector('[data-refresh]')?.addEventListener('click', () => this._load());
    for (const b of wrap.querySelectorAll('[data-run]')) {
      b.addEventListener('click', () => this._run(b.dataset.run));
    }
    const fresh = this._freshRows(facts);
    for (const b of wrap.querySelectorAll('[data-fresh-accept]')) {
      b.addEventListener('click', () => {
        const a = fresh[Number(b.dataset.freshAccept)];
        if (!a) return;
        this._accept(a.title, {
          gapCategory: a.category || '', competitorUrl: a.url || '',
          rationale: a.coveredByOwn === undefined ? 'Fresh competitor article.'
            : a.coveredByOwn ? 'Defence: competitor went narrower than the existing own article.'
              : 'Fresh competitor article with no own equivalent.',
          source: `facts ${facts?.token?.properties?.generatedAt || 'recency stores'}`,
        });
      });
    }
    for (const b of wrap.querySelectorAll('[data-fresh-covered]')) {
      b.addEventListener('click', () => {
        const a = fresh[Number(b.dataset.freshCovered)];
        if (a) this._covered(a.url, a.closestOwnSlug || '');
      });
    }
    for (const b of wrap.querySelectorAll('[data-fresh-dismiss]')) {
      b.addEventListener('click', () => {
        const a = fresh[Number(b.dataset.freshDismiss)];
        if (a) this._dismiss(a.url, 'dismissed from fresh list');
      });
    }
    const recs = digest ? arr(digest.properties.recommendations) : [];
    for (const b of wrap.querySelectorAll('[data-rec-accept]')) {
      b.addEventListener('click', () => {
        const r = String(recs[Number(b.dataset.recAccept)] || '');
        if (!r) return;
        const title = r.split(/[.!?]\s/)[0].slice(0, 90);
        this._accept(title, {
          rationale: r.slice(0, 900),
          source: `landscape-analysis ${digest.properties.generatedAt || ''}`,
        });
      });
    }
    for (const b of wrap.querySelectorAll('[data-rec-dismiss]')) {
      b.addEventListener('click', () => {
        const r = String(recs[Number(b.dataset.recDismiss)] || '');
        if (r) this._dismiss(r.slice(0, 120), 'dismissed from analysis');
      });
    }
    for (const b of wrap.querySelectorAll('[data-task-done]')) {
      b.addEventListener('click', () => {
        const note = prompt('Outcome (e.g. the published URL) — optional:') || '';
        this._complete(b.dataset.taskDone, note);
      });
    }
    wrap.querySelector('[data-form="url"]')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const url = new FormData(ev.target).get('url');
      if (url) { this._invoke('queue-url', { url: String(url) }, `url:${slug(String(url))}`); ev.target.reset(); }
    });
    const drafts = newestFirst(this._stores.drafts || [], 'ts');
    for (const b of wrap.querySelectorAll('[data-draft-copy]')) {
      b.addEventListener('click', () => {
        const md = String(drafts[Number(b.dataset.draftCopy)]?.properties?.draftMarkdown || '');
        navigator.clipboard?.writeText(md).then(
          () => this._toast('Markdown copied.'),
          () => this._toast('Clipboard unavailable in this context.', true),
        );
      });
    }
    wrap.querySelector('[data-form="query"]')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const query = new FormData(ev.target).get('query');
      if (query) { this._invoke('queue-query', { query: String(query) }, `q:${slug(String(query))}`); ev.target.reset(); }
    });
  }
}

if (!customElements.get('agenticos-web-investigator-v1')) {
  customElements.define('agenticos-web-investigator-v1', WebInvestigatorDashboard);
}
