/**
 * MCP resources — read surfaces and the knowledge base that teaches clients
 * how to use Agentic-Nets well (distilled from the agenticos-control plugin's
 * skill references and hard-won operating experience).
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { KNOWLEDGE } from './knowledge/index.js';
import { TEMPLATES } from './templates/index.js';
import { nativeCatalog } from './tools/catalog.js';

export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    'models',
    'agenticnets://models',
    { title: 'Allowed models', description: 'The model allowlist, default model, and mode', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            { allowed: ctx.scope.allowed, default: ctx.scope.defaultModel, mode: ctx.config.mode, session: ctx.config.session },
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'templates',
    'agenticnets://templates',
    { title: 'Starter templates', description: 'Deployable templates with their parameters', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            Object.values(TEMPLATES).map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              params: t.params ?? {},
              tags: t.tags ?? [],
            })),
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'tool-catalog',
    'agenticnets://tool-catalog',
    {
      title: 'Native tool catalog',
      description: 'Every platform-native tool exposed by this server (UPPERCASE names — same catalog agent transitions use in-net)',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            nativeCatalog().map((t) => ({
              name: t.name,
              description: t.description,
              params: Object.keys(t.input_schema?.properties ?? {}),
              required: t.input_schema?.required ?? [],
            })),
            null,
            1,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'hub',
    'agenticnets://hub',
    { title: 'NetHub — local catalog + remotes', description: 'Published artifacts on this instance and the registered peer remotes', mimeType: 'application/json' },
    async (uri) => {
      const [catalog, remotes] = await Promise.all([
        ctx.master.hubCatalog().catch(() => ({ note: 'hub catalog unavailable' })),
        ctx.master.hubListRemotes().catch(() => ({ remotes: [] })),
      ]);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ catalog, remotes }, null, 1) }] };
    },
  );

  server.registerResource(
    'tool-nets',
    'agenticnets://tool-nets',
    { title: 'Tool-net library', description: 'Reusable tool-nets you can invoke_tool_net', mimeType: 'application/json' },
    async (uri) => {
      const res = await ctx.executorFor(ctx.scope.defaultModel).execute('LIST_TOOL_NETS', {}).catch(() => null);
      const data = res?.success ? res.data : { note: 'no tool-nets found or library unavailable', tools: [] };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 1) }] };
    },
  );

  // Every hard cap, default and enum a client must respect, in ONE place.
  //
  // Why this exists: these were discoverable only by tripping over them. The 8192-char HTTP body
  // clip was found by fetching a page and noticing `body` was exactly 8192 chars — and only got a
  // human-readable explanation because that particular body ALSO failed JSON parsing, which routed
  // a note into `_parseError`. A valid-JSON payload over the cap has no such channel and would have
  // been silently truncated. A cap that silently reshapes results has to be published.
  server.registerResource(
    'limits',
    'agenticnets://limits',
    {
      title: 'Hard limits, defaults and enums',
      description: 'Every cap and default a client must respect — read before designing a pipeline around a payload size',
      mimeType: 'application/json',
    },
    async (uri) => {
      const limits = {
        note:
          'Values a client cannot discover from a tool schema. Where a cap CLIPS rather than errors, ' +
          'the truncation is marked in the payload — but design around the cap rather than relying on the marker.',
        http: {
          responseBodyClipChars: 8192,
          appliesTo: 'http-kind transitions and any @response.json / default emit whose body is not JSON',
          behaviour:
            'the raw body is clipped and the token carries _parseError naming the clip; a JSON body under the ' +
            'cap is passed through whole',
          workaround:
            'select fields at the source (e.g. a REST API with field selection) rather than fetching a page ' +
            'and parsing it downstream',
          defaultTimeoutMs: 30000,
        },
        llm: {
          defaultTimeoutMs: 240000,
          note: 'LlmActionHandler itself defaults to 60s, which real grounded prompts exceed — inscriptions built here set 240s explicitly',
        },
        agent: {
          defaultMaxIterations: 12,
          note: 'each iteration is a billed model call; an oscillating agent burns its whole budget before stopping',
        },
        tokens: {
          reservationTtlMs: 60000,
          note:
            'a bound token is locked for this long. It is also the retry cadence of a lane that cannot emit, ' +
            'and how long a stopped lane used to hold its input before stop learned to sweep its own locks',
          propertyTypes:
            'token properties are stored as STRINGS — a number written as 23813 reads back as "23813", ' +
            'an array as JSON text (parse before use; twice for LLM output). ArcQL numeric comparisons DO ' +
            'work despite this: `$.points > 100` and `ORDER BY $.points DESC` compare numerically when both ' +
            'sides parse as numbers. A QUOTED literal stays an exact string match, so `$.zip == "01234"` ' +
            'keeps its leading zero — quote when you mean text, do not quote when you mean a number',
        },
        reads: {
          queryTokensDefaultArcql: 'FROM $ LIMIT 100',
          queryTokensDefaultMaxValueLength: 500,
          eventTrailDefaultLimit: 50,
          eventTrailMaxLimit: 200,
          note: 'event_trail clamps limit to 200 — page backwards with `before`/`nextBeforeSeq` rather than one big window',
        },
        scheduling: {
          cronFields: 6,
          cronFormat: 'sec min hour day month weekday — a 5-field crontab line is REJECTED, not silently accepted',
          onEmptyDefault: 'fire',
          onEmptyNote:
            'a scheduled lane defaults to ticking even on an empty input place and never consuming; pass ' +
              'onEmpty:"skip" to AND-gate the schedule with token availability',
          timezone: 'cron accepts an IANA timezone; unset = server zone; scheduler_status echoes the effective zone',
          invalid: 'malformed schedules fail closed with eligibility INVALID_SCHEDULE and never fire',
        },
        transitions: {
          kinds: ['map', 'llm', 'http', 'command', 'agent', 'link'],
          modes: ['SINGLE', 'FOREACH'],
          foreachBatch: 'batchSize (default 1, max 100) binds LIMIT n + take ALL; each token executes independently',
          statuses: ['undeployed', 'DEPLOYED', 'starting', 'RUNNING', 'STOPPED', 'ERROR', 'external'],
          health: ['HEALTHY', 'WARNING', 'BLOCKED', 'ERROR'],
          fireOnceRestriction: 'disabled for action.type=llm|agent — use start_transition or host_transition; deterministic lanes default preserveRunning:true for lifecycle-safe smoke tests',
          batchTools: ['add_transitions', 'delete_tokens'],
          httpEmitSources: {
            text: '@response.text = raw CSV/XML/plaintext/body',
            meta: '@response.meta = real status/content type/length/duration + masked effective request',
          },
        },
        session: {
          modelAllowlist: ctx.scope.allowed,
          allowlistPersistence:
            'a model created by create_model is remembered durably (default) so a later session can still ' +
            'inspect, retune and pause_model it; a grant to a PRE-EXISTING model stays session-scoped unless ' +
            'persistAllowlist:true is passed. Disable with AGENTICOS_PERSIST_ALLOWLIST=false.',
          allowlistPath: ctx.config.allowlistPath,
        },
      };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(limits, null, 1) }] };
    },
  );

  server.registerResource(
    'docs',
    new ResourceTemplate('agenticnets://docs/{topic}', {
      list: async () => ({
        resources: Object.entries(KNOWLEDGE).map(([topic, d]) => ({
          uri: `agenticnets://docs/${topic}`,
          name: d.title,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    { title: 'Agentic-Nets knowledge base', description: Object.keys(KNOWLEDGE).join(' | ') },
    async (uri, { topic }) => {
      const doc = KNOWLEDGE[String(topic)];
      if (!doc) throw new Error(`unknown doc topic '${topic}' (have: ${Object.keys(KNOWLEDGE).join(', ')})`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.text }] };
    },
  );
}
