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
// Blob text is fetched straight from the blobstore: same host as the page, port 8090 — the
// rule Studio's own blob viewer uses. The store sends read-only CORS headers for exactly this.
const blobUrl = (urn) =>
  `${location.protocol}//${location.hostname}:8090/api/blobs/${String(urn).replace(/^urn:agenticos:blob:/, '')}`;
function stripHeader(raw) {
  // The writer stores a provenance header, a blank line, then the article.
  const cut = raw.indexOf('\n\n');
  return cut > 0 && cut < 400 ? raw.slice(cut + 2) : raw;
}
async function readBlob(urn, rt) {
  if (!urn) throw new Error('this draft has no blob pointer');
  if (rt && typeof rt.readBlob === 'function') {
    // Studio's application runtime reads through the platform path (gateway → master → the
    // store that owns the locator) with Studio's own credential — no store port, no CORS.
    const r = await rt.readBlob(urn, { maxLength: 400000 });
    return stripHeader(String(r?.content ?? ''));
  }
  const r = await fetch(blobUrl(urn));
  if (!r.ok) throw new Error(`blobstore answered ${r.status}`);
  return stripHeader(await r.text());
}

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
    for (const role of ['tasks', 'decisions', 'requests', 'policies']) {
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
      'frontier', 'queries', 'tasks', 'decisions', 'requests', 'owned', 'drafts',
      'sources', 'growth', 'policies', 'usage'];
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
  _policies() {
    const out = {};
    for (const t of newestFirst(this._stores.policies || [], 'setAt').reverse()) {
      const p = t.properties || {};
      const host = String(p.host || '').toLowerCase().replace(/^www\./, '');
      if (host && p.policy) out[host] = p.policy;
    }
    return out;
  }
  _reviews() {
    const out = {};
    for (const t of newestFirst(this._stores.decisions || [], 'reviewedAt').reverse()) {
      const p = t.properties || {};
      if (p.verdict === 'draft-reviewed' && p.taskId) out[`${p.taskId}#${p.revision || '1'}`] = p;
    }
    return out;
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
  _run(what, extra = {}) {
    const requestId = `run-${what}-${crypto.randomUUID().slice(0, 8)}`;
    this._invoke('request-run', { requestId, run: what, ...extra }, `run:${requestId}`);
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
        <button data-run="recrawl" ${this._runBusy() ? 'disabled' : ''}
          title="Re-queue every known source's entry pages so new articles get discovered">Re-crawl sources</button>
        <button data-run="sitemap" ${this._runBusy() ? 'disabled' : ''}
          title="Discover each source's sitemap and queue its articles (bounded per run; repeat to sweep more)">Harvest sitemaps</button>
        <button class="acc" data-run="write" ${this._runBusy() ? 'disabled' : ''}
          title="Assemble the next accepted task and let the staff writer draft it">Draft article</button>
        <button class="ghost" data-refresh title="Reload every store">↻</button>
      </div>
      <div class="grid">
        <div style="display:grid;gap:14px;min-width:0">
          ${this._matrixCard(cats)}
          ${this._expansionCard()}
          ${this._costCard()}
          ${this._freshCard(facts)}
          ${this._digestCard(digest)}
        </div>
        <div style="display:grid;gap:14px;min-width:0;align-content:start">
          ${this._helpCard()}
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

  _helpCard() {
    return `<div class="card"><details class="digest">
      <summary>❓ How this works — the net behind this page</summary>
      <p><b>This page is a window, not a database.</b> Every number and article you see is a token
      in an event-sourced Petri net; every button writes a token back into it. The net does the
      work — this app only reads state and records your decisions.</p>
      <p><b>The pipeline.</b> URLs enter the <i>frontier</i> → a fetch script downloads, dates and
      scores each page and discovers new links → a free gate drops off-topic pages → a small model
      categorises survivors → findings land in the recency buckets (brand-new / recent / archive)
      → a rollup script counts everything and joins it against <i>your own</i> site's inventory →
      an analyst model writes the landscape analysis you see on the left. Your own site is never
      crawled — only its sitemap is indexed, so "uncovered" means <i>you</i> have no equivalent.</p>
      <p><b>Your decision loop.</b>
      <i>Accept</i> turns a recommendation or fresh article into a task carrying its evidence.
      <i>Draft article</i> (or the daily schedule) has the staff writer draft the oldest open task
      — one per run, never twice for the same task. <i>✍ Fable</i> on a task is the deliberate
      version: it drafts <i>that</i> assignment with the Fable model, on demand only (nothing
      schedules it), storing the article as a blob and adding a new revision rather than replacing
      what is already there — so you can compare writers on the same brief. Copy the draft from the
      Drafts card, publish it, then click <i>Done</i> on the task. <i>Dismiss</i> and <i>Covered</i>
      record the opposite calls so the analysis stops re-recommending them.</p>
      <p><b>Steering.</b> <i>Queue URL</i> feeds a page straight into the crawl. <i>Queue query</i>
      widens it via a search API (needs its key configured). <i>Run rollup</i> recomputes counts +
      analysis now; <i>Re-index own site</i> refreshes your inventory; <i>Crawl health</i> writes
      fetch diagnostics into Insights. All of these only record a request token — the net's own
      lanes build and execute the actual commands.</p>
      <p><b>Where to look deeper.</b> The net itself (places, lanes, live tokens) is on the Studio
      canvas — open the model's <i>scout</i> net or its stage views (crawl / analysis /
      reporting). Raw tokens live in the Token Workbench on any place named on this page.</p>
    </details></div>`;
  }

  _expansionCard() {
    const sources = (this._stores.sources || []).map((t) => t.properties);
    const growth = newestFirst(this._stores.growth || [], 'ts').reverse().map((t) => t.properties);
    if (!sources.length && !growth.length) return '';

    // source mix — findings per source type, as labelled bars
    const byType = {};
    for (const p of sources) byType[p.sourceType || 'other'] = (byType[p.sourceType || 'other'] || 0) + num(p.articles);
    const totalArts = Object.values(byType).reduce((a, b) => a + b, 0) || 1;
    const mix = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
      <div style="display:flex;align-items:center;gap:8px;margin:3px 0">
        <span style="width:86px;font-size:12px;color:var(--muted,#9aa1ab)">${esc(k)}</span>
        <span style="flex:1;height:9px;border-radius:5px;background:var(--card,#1d2026);overflow:hidden">
          <i style="display:block;height:100%;width:${Math.max(3, Math.round((v / totalArts) * 100))}%;
             background:var(--acc,#2f6fdd)"></i></span>
        <b style="font-size:12px;min-width:30px;text-align:right">${v}</b>
      </div>`).join('');

    // sources table — the expansion evidence per host, and the one judgment the crawl can act on
    const policies = this._policies();
    const policyCell = (host) => {
      const cur = policies[String(host || '').toLowerCase().replace(/^www\./, '')] || 'allow';
      return ['allow', 'index-only', 'ignore'].map((pol) =>
        `<button data-policy="${esc(pol)}" data-policy-host="${esc(host)}" ${cur === pol ? 'disabled' : ''}
           title="${pol === 'allow' ? 'Crawl and classify this host (default)'
             : pol === 'index-only' ? 'Fetch this host for its links only; never classify its pages'
             : 'Never fetch this host again'}"
           style="${cur === pol ? 'font-weight:700' : 'opacity:.75'}">${esc(pol)}</button>`).join(' ');
    };
    const rows = sources.sort((a, b) => num(b.articles) - num(a.articles)).map((p) => `
      <tr><td class="cat">${esc(p.host)}</td><td><span class="badge">${esc(p.sourceType)}</span></td>
      <td class="n">${num(p.articles)}</td><td class="n">${num(p.brandNew) + num(p.recent) || ''}</td>
      <td class="n">${num(p.categories)}</td><td>${esc(p.firstSeenAt || '')}</td>
      <td class="acts">${policyCell(p.host)}</td></tr>`).join('');

    // growth chart — findings + hosts over the snapshot series, hand-rolled SVG
    let chart = '';
    if (growth.length >= 2) {
      const W = 560, H = 120, P = 24;
      const maxF = Math.max(...growth.map((g) => num(g.findings)), 1);
      const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, growth.length - 1);
      const yF = (v) => H - P - ((v / maxF) * (H - 2 * P));
      const line = (get) => growth.map((g, i) => `${x(i).toFixed(1)},${yF(get(g)).toFixed(1)}`).join(' ');
      chart = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-height:130px" role="img"
          aria-label="findings over time">
        <polyline points="${line((g) => num(g.findings))}" fill="none"
          stroke="var(--acc,#2f6fdd)" stroke-width="2"/>
        <polyline points="${line((g) => num(g.hosts) * (maxF / Math.max(1, Math.max(...growth.map((h) => num(h.hosts))))))}"
          fill="none" stroke="var(--muted,#9aa1ab)" stroke-width="1.5" stroke-dasharray="4 3"/>
        <text x="${P}" y="12" fill="var(--muted,#9aa1ab)" font-size="10">findings (solid) · hosts (dashed, scaled) · ${growth.length} snapshots</text>
      </svg>`;
    } else if (growth.length === 1) {
      chart = `<div class="footnote">First snapshot recorded (${esc(growth[0].ts || '')}) — the chart draws itself as the series grows.</div>`;
    }
    const last = growth[growth.length - 1] || {};
    return `<div class="card"><h3>Sources & expansion</h3>
      <p class="sub">Where the findings come from, and how the investigation is growing. The <b>policy</b> is your judgment the crawl acts on: <i>index-only</i> keeps a host for its links, <i>ignore</i> drops it from fetch, harvest and recrawl.
        ${num(last.newFindings) ? `<span class="badge warm">+${num(last.newFindings)} findings last rollup</span>` : ''}
        ${num(last.newHosts) ? `<span class="badge warm">+${num(last.newHosts)} hosts</span>` : ''}</p>
      ${mix}
      <div style="overflow-x:auto;margin-top:8px"><table>
        <tr><th>source</th><th>type</th><th class="n">articles</th><th class="n">fresh</th><th class="n">cats</th><th>first seen</th><th>policy</th></tr>
        ${rows}
      </table></div>
      ${chart}</div>`;
  }

  _costCard() {
    const days = newestFirst((this._stores.usage || []).filter((t) => t.properties?.kind === 'usage-day'), 'day')
      .map((t) => t.properties);
    const latest = days[0];
    const lanes = latest ? arr(latest.lanes).filter((l) => l && l.transitionId).slice(0, 6) : [];
    const fmt = (n) => Number(n || 0).toLocaleString();
    const dayRows = days.slice(0, 7).map((d) => `
      <tr><td class="cat">${esc(d.day)}</td><td class="n">${fmt(d.totalTokens)}</td>
      <td class="n">${fmt(d.modelTokens)}</td><td class="n">${fmt(d.fires)}</td><td>${esc(d.topLane || '')}</td></tr>`).join('');
    const laneRows = lanes.map((l) => `
      <tr><td class="cat">${esc(l.transitionId)}</td><td><span class="badge">${esc(l.kind || '')}</span>${
        l.group ? ` <span class="badge">${esc(l.group)}/${esc(l.tier || '')}</span>` : ''}</td>
      <td class="n">${fmt(l.tokens)}</td><td class="n">${fmt(l.fires)}</td>
      <td class="n">${l.fires ? fmt(Math.round(Number(l.tokens || 0) / Number(l.fires))) : ''}</td>
      <td class="n">${esc(l.avgIterations ?? '')}</td></tr>`).join('');
    return `<div class="card"><h3>Cost</h3>
      <p class="sub">Measured tokens per day and per lane, so the burn sits next to the buttons that cause it. Filed nightly by the usage lane; <b>Refresh cost</b> files today so far.
        <button data-refresh-cost style="margin-left:8px" title="Files today's usage now: the request and its command token commit together">Refresh cost</button></p>
      ${days.length ? `<div style="overflow-x:auto"><table>
        <tr><th>day</th><th class="n">tokens</th><th class="n">model tokens</th><th class="n">fires</th><th>top lane</th></tr>${dayRows}</table></div>` : '<div class="empty">No usage filed yet — press Refresh cost.</div>'}
      ${lanes.length ? `<div style="overflow-x:auto;margin-top:8px"><table>
        <tr><th>lane (${esc(latest.day)})</th><th>kind</th><th class="n">tokens</th><th class="n">fires</th><th class="n">per fire</th><th class="n">iters</th></tr>${laneRows}</table></div>` : ''}
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
        <div class="acts">${done ? '' : `<button data-fable="${esc(p.taskId)}" title="Draft this assignment with Claude Code running the Fable model">✍ Fable</button>
          <button data-task-done="${esc(p.taskId)}">Done</button>`}</div>
      </div>`;
    }).join('');
    return `<div class="card"><h3>Article tasks</h3>
      <p class="sub">Accepted recommendations with their evidence. “Draft article” above writes the next undrafted one; <b>✍ Fable</b> drafts <i>this</i> assignment with the Fable model (a new revision each time, the article itself stored as a blob); “Done” records the outcome atomically.</p>
      ${rows || '<div class="empty">Nothing accepted yet — the gap lists on the left feed this queue.</div>'}</div>`;
  }

  _draftsCard(drafts) {
    if (!drafts.length) return '';
    const reviews = this._reviews();
    const rows = newestFirst(drafts, 'ts').map((d, i) => {
      const p = d.properties;
      // Drafts filed before 1.4 carried the article inline; newer ones keep it in the blob and
      // the token holds only a preview, the outline and the pointers.
      const inline = String(p.draftMarkdown || '');
      const writer = String(p.writerModel || '').trim();
      const outline = arr(p.outline);
      const hosts = arr(p.sourceHosts);
      const review = reviews[`${p.taskId}#${p.revision || '1'}`];
      const reviewBtn = (rating, label) => `<button data-review="${esc(rating)}" data-review-idx="${i}"
        ${review?.rating === rating ? 'disabled style="font-weight:700"' : ''}>${label}</button>`;
      return `<details class="digest" data-draft="${i}">
        <summary>${esc(p.title)} <span class="badge">${esc(p.wordCount || '?')} words</span>${
          writer && writer !== 'default' ? ` <span class="badge ok">${esc(writer)}</span>` : ''}${
          Number(p.revision) > 1 ? ` <span class="badge">rev ${esc(p.revision)}</span>` : ''}${
          p.sourcesUsed ? ` <span class="badge">${esc(p.sourcesUsed)} sources</span>` : ''}${
          review ? ` <span class="badge ${review.rating === 'discarded' ? 'warm' : 'ok'}">${esc(review.rating)}</span>` : ''}</summary>
        <div class="acts" style="margin:6px 0">
          ${inline ? '' : `<button data-draft-open="${i}">Open article</button>`}
          <button data-draft-copy="${i}">Copy markdown</button>
          ${p.knowledgeBlobUrn ? `<button data-draft-knowledge="${i}" title="The evidence pack the writer was given">What the writer saw</button>` : ''}
          <span class="meta" style="margin-left:8px">after reading:</span>
          ${reviewBtn('used', 'used as is')} ${reviewBtn('edited', 'edited heavily')} ${reviewBtn('discarded', 'discarded')}
        </div>
        <pre class="draft-knowledge" hidden style="white-space:pre-wrap;font-size:11px;max-height:50vh;overflow:auto"></pre>
        ${p.blobUrn ? `<div class="meta">stored as <code>${esc(p.blobUrn)}</code>${hosts.length ? ` · evidence from ${esc(hosts.join(', '))}` : ''}</div>` : ''}
        ${outline.length ? `<div class="meta">${outline.map(esc).join(' · ')}</div>` : ''}
        <p class="draft-body" style="white-space:pre-wrap;font-family:var(--mono,monospace);font-size:12px;max-height:340px;overflow:auto">${esc(inline || p.preview || '')}${!inline && p.preview ? ' …' : ''}</p>
      </details>`;
    }).join('');
    return `<div class="card"><h3>Drafts</h3>
      <p class="sub">Written by a staff-writer lane from a knowledge pack drawn across the corpus, and kept as a blob — the token only describes it. Open, copy, publish, then mark the task Done. A badge names the model when it was not the default writer.</p>
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
      <form class="inline" data-form="source">
        <input name="url" type="url" required placeholder="https:// … onboard a whole site (sitemap harvest)">
        <button>Add source</button>
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
    for (const b of wrap.querySelectorAll('[data-fable]')) {
      b.addEventListener('click', () => {
        this._run('write-fable', { taskId: b.dataset.fable, writerModel: 'fable' });
        this._toast('Fable is drafting this assignment — the draft appears below when it lands.');
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
    const draftText = (p) => (p?.draftMarkdown ? Promise.resolve(String(p.draftMarkdown)) : readBlob(p?.blobUrn, this._rt));
    for (const b of wrap.querySelectorAll('[data-draft-open]')) {
      b.addEventListener('click', async () => {
        const i = Number(b.dataset.draftOpen);
        const box = wrap.querySelector(`details[data-draft="${i}"] .draft-body`);
        b.disabled = true;
        try {
          box.textContent = await draftText(drafts[i]?.properties);
          box.style.maxHeight = '70vh';
          b.textContent = 'Opened';
        } catch (e) {
          b.disabled = false;
          this._toast(`Could not read the article blob: ${e?.message || e}`, true);
        }
      });
    }
    for (const b of wrap.querySelectorAll('[data-draft-copy]')) {
      b.addEventListener('click', async () => {
        let md = '';
        try { md = await draftText(drafts[Number(b.dataset.draftCopy)]?.properties); }
        catch (e) { this._toast(`Could not read the article blob: ${e?.message || e}`, true); return; }
        navigator.clipboard?.writeText(md).then(
          () => this._toast('Markdown copied.'),
          () => this._toast('Clipboard unavailable in this context.', true),
        );
      });
    }
    for (const b of wrap.querySelectorAll('[data-draft-knowledge]')) {
      b.addEventListener('click', async () => {
        const i = Number(b.dataset.draftKnowledge);
        const urn = drafts[i]?.properties?.knowledgeBlobUrn;
        const box = wrap.querySelector(`details[data-draft="${i}"] .draft-knowledge`);
        if (!urn || !box) return;
        if (!box.hidden) { box.hidden = true; return; }
        b.disabled = true;
        try { box.textContent = await readBlob(urn, this._rt); box.hidden = false; }
        catch (e) { this._toast(`Could not read the knowledge pack: ${e?.message || e}`, true); }
        finally { b.disabled = false; }
      });
    }
    for (const b of wrap.querySelectorAll('[data-review]')) {
      b.addEventListener('click', () => {
        const p = drafts[Number(b.dataset.reviewIdx)]?.properties || {};
        const revision = String(p.revision || '1');
        this._invoke('review-draft', {
          taskId: p.taskId, revision, rating: b.dataset.review,
          writerModel: String(p.writerModel || 'default'), reviewedAt: new Date().toISOString(),
        }, `rev:${p.taskId}:${revision}:${b.dataset.review}`);
      });
    }
    wrap.querySelector('[data-refresh-cost]')?.addEventListener('click', () => {
      // A command-emitting action: master writes the usage CommandToken in the same transaction
      // as this request record, so no request-to-command lane sits in between.
      const requestId = `refresh-cost-${crypto.randomUUID().slice(0, 8)}`;
      this._invoke('refresh-cost', { requestId, since: '24h' }, `cost:${requestId}`);
    });
    for (const b of wrap.querySelectorAll('[data-policy]')) {
      b.addEventListener('click', () => {
        const host = String(b.dataset.policyHost || '').toLowerCase().replace(/^www\./, '');
        this._invoke('set-source-policy', { host, policy: b.dataset.policy, setAt: new Date().toISOString() },
          `pol:${host}:${b.dataset.policy}:${Date.now()}`);
      });
    }
    wrap.querySelector('[data-form="source"]')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const url = new FormData(ev.target).get('url');
      if (url) {
        this._invoke('add-source', { url: String(url) }, `src:${slug(String(url))}`);
        ev.target.reset();
      }
    });
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
