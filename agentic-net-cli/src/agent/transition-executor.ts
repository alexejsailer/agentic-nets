import type { LlmProvider } from '../llm/provider.js';
import type { NodeApi } from '../gateway/node-api.js';
import type { ToolExecutor } from './tool-executor.js';
import type { AgentEvent } from './runtime.js';
import { agentLoop } from './runtime.js';
import { buildSystemPrompt } from './prompts.js';
import { parseRole, getAvailableTools } from './roles.js';
import { buildToolSchemas } from './tools.js';

export interface TransitionExecutionResult {
  success: boolean;
  summary?: string;
  error?: string;
  iterationsUsed: number;
  emittedTokens: number;
  consumedTokens: number;
}

const MAX_NL_INTERPOLATION_CHARS = 2_000;
const MAX_NL_DIRECT_LOOKUP_CHARS = 6_000;
const MAX_BOUND_CONTEXT_CHARS = 8_000;
const MAX_TOKENS_PER_PRESET_IN_CONTEXT = 2;
const MAX_TOKEN_PREVIEW_CHARS = 1_800;
const DEFAULT_LOCAL_AGENT_MAX_ITERATIONS = 8;
const HARD_CAP_LOCAL_AGENT_MAX_ITERATIONS = 12;
const SUB_AGENT_MAX_TOOL_CALLS = 10;
const SUB_AGENT_MAX_THINK_CALLS = 1;
const SUB_AGENT_MAX_CONSECUTIVE_SAME_TOOL_CALLS = 2;
const SUB_AGENT_USER_MESSAGE = 'Execute the transition task from the system prompt. Use tools as needed, then call DONE or FAIL.';
const LLM_DEFAULT_SYSTEM_PROMPT = 'You are a classifier/transformer that analyzes input and returns structured JSON. Return JSON only.';

/**
 * Execute an agent transition locally using the CLI/Telegram's own LLM provider.
 * Reads the inscription, binds preset tokens via ArcQL, runs a sub-agent loop
 * with the resolved NL instruction, and validates that runtime postset tokens
 * were emitted by the local execution path.
 */
export async function executeTransitionLocally(
  nodeApi: NodeApi,
  llm: LlmProvider,
  toolExecutor: ToolExecutor,
  modelId: string,
  sessionId: string,
  opts: {
    transitionId: string;
    maxIterations?: number;
    onProgress?: (event: AgentEvent) => void;
  },
): Promise<TransitionExecutionResult> {
  const { transitionId, onProgress } = opts;
  let iterationsUsed = 0;
  let emittedTokens = 0;
  let consumedTokens = 0;

  // 1. Read inscription
  const inscription = await readInscription(nodeApi, modelId, transitionId);
  if (!inscription) {
    return { success: false, error: `No inscription found for transition '${transitionId}'`, iterationsUsed: 0, emittedTokens: 0, consumedTokens: 0 };
  }

  // 2. Validate: local execution supports agent and llm action types
  const actionType = inscription.action?.type;
  if (actionType !== 'agent' && actionType !== 'llm') {
    return {
      success: false,
      error: `EXECUTE_TRANSITION only supports agent/llm transitions (got '${actionType}'). Use FIRE_ONCE for map/http/pass/command.`,
      iterationsUsed: 0, emittedTokens: 0, consumedTokens: 0,
    };
  }

  if (actionType === 'llm') {
    return executeLlmTransitionLocally(nodeApi, llm, modelId, transitionId, inscription);
  }

  // 3. Bind presets (fetch tokens via ArcQL)
  const { bindings, bindingModels } = await bindPresets(nodeApi, modelId, inscription.presets || {});
  const missingPresetBindings = findMissingPresetBindings(inscription.presets || {}, bindings);
  if (missingPresetBindings.length > 0) {
    return {
      success: false,
      error: `No tokens bound for required presets: ${formatMissingPresetBindings(missingPresetBindings)}. Seed input runtime places and retry.`,
      iterationsUsed: 0,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  // 4. Resolve NL expression
  const nlExpression = inscription.action?.nl || '';
  const resolvedNl = resolveNlExpression(nlExpression, bindings);
  if (!resolvedNl) {
    return { success: false, error: `Could not resolve NL expression: '${nlExpression}'`, iterationsUsed: 0, emittedTokens: 0, consumedTokens: 0 };
  }

  // 4.5. Snapshot postset counts before execution. We use this to ensure the
  // transition actually produced runtime outputs, rather than auto-emitting.
  const postsets = inscription.postsets || {};
  const postsetPlacePaths = collectPostsetPlacePaths(postsets);
  let preCounts: Map<string, number>;
  try {
    preCounts = await snapshotPostsetCounts(nodeApi, modelId, postsets);
  } catch (err: any) {
    return {
      success: false,
      error: `Failed postset preflight snapshot: ${err.message}`,
      iterationsUsed: 0,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  // 5. Build sub-agent prompt with bound token context
  const roleStr = inscription.action?.role || 'rw';
  const subRole = parseRole(roleStr);

  const tokenContext = buildBoundTokenContext(bindings);

  const taskDescription = `${resolvedNl}${tokenContext}`;
  const subSystemPrompt = buildSystemPrompt({ role: subRole, modelId, sessionId, task: taskDescription });

  // 6. Build tool schemas — remove EXECUTE_TRANSITION to prevent recursion
  const subTools = getAvailableTools(subRole);
  subTools.delete('EXECUTE_TRANSITION' as any);
  const subToolSchemas = buildToolSchemas(subTools);

  // 7. Run sub-agent loop
  const inscriptionMaxIterations = typeof inscription.action?.maxIterations === 'number'
    ? inscription.action.maxIterations
    : undefined;
  const requestedMaxIterations = typeof opts.maxIterations === 'number'
    ? opts.maxIterations
    : undefined;
  const configuredMaxIter = requestedMaxIterations ?? inscriptionMaxIterations ?? DEFAULT_LOCAL_AGENT_MAX_ITERATIONS;
  const maxIter = clampToRange(configuredMaxIter, 1, HARD_CAP_LOCAL_AGENT_MAX_ITERATIONS);
  let summary = '';
  let failed = false;
  let failMessage = '';
  let toolCalls = 0;
  let sawEvents = false;
  let pendingCreateTokenPath: string | null = null;
  let explicitPostsetEmits = 0;

  try {
    for await (const event of agentLoop(
      llm,
      toolExecutor,
      subSystemPrompt,
      SUB_AGENT_USER_MESSAGE,
      subToolSchemas,
      undefined,
      {
        maxIterations: maxIter,
        maxToolCalls: Math.min(SUB_AGENT_MAX_TOOL_CALLS, Math.max(1, maxIter * 2)),
        maxThinkCalls: SUB_AGENT_MAX_THINK_CALLS,
        maxConsecutiveSameToolCalls: SUB_AGENT_MAX_CONSECUTIVE_SAME_TOOL_CALLS,
      },
    )) {
      sawEvents = true;
      if (event.type === 'tool_call') {
        toolCalls++;
        if (event.tool === 'CREATE_TOKEN') {
          pendingCreateTokenPath = normalizePath(String(event.input?.placePath || ''));
        } else {
          pendingCreateTokenPath = null;
        }
      } else if (event.type === 'tool_result') {
        const hasError = !!(event.result && typeof event.result === 'object' && 'error' in event.result);
        if (pendingCreateTokenPath && !hasError && postsetPlacePaths.has(pendingCreateTokenPath)) {
          explicitPostsetEmits++;
        }
        pendingCreateTokenPath = null;
      }

      // Forward progress events
      if (onProgress) {
        onProgress(event);
      }

      switch (event.type) {
        case 'done':
          summary = event.content || 'Task completed.';
          break;
        case 'fail':
          failed = true;
          failMessage = event.content || 'Task failed.';
          break;
        case 'error':
          failed = true;
          failMessage = event.content || 'Unknown error.';
          break;
      }
    }
    iterationsUsed = toolCalls > 0 ? toolCalls : (sawEvents ? 1 : 0);
  } catch (err: any) {
    return {
      success: false,
      error: `Sub-agent execution error: ${err.message}`,
      iterationsUsed,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  if (failed) {
    // On failure: skip emission/consumption
    return { success: false, error: failMessage, iterationsUsed, emittedTokens: 0, consumedTokens: 0 };
  }

  // 8. Measure emitted outputs from actual postset deltas.
  let postCounts: Map<string, number>;
  try {
    postCounts = await snapshotPostsetCounts(nodeApi, modelId, postsets);
  } catch (err: any) {
    return {
      success: false,
      error: `Failed postset snapshot after execution: ${err.message}. Input tokens were not consumed.`,
      iterationsUsed,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }
  const emittedByDelta = countPositiveDeltas(preCounts, postCounts);
  emittedTokens = explicitPostsetEmits > 0 ? explicitPostsetEmits : emittedByDelta;

  const requiredPostsets = Object.keys(postsets).filter((name) => !!postsets[name]?.placeId);
  if (requiredPostsets.length > 0 && emittedTokens <= 0) {
    return {
      success: false,
      error: `Transition '${transitionId}' completed but emitted no runtime tokens to postsets [${requiredPostsets.join(', ')}]. Input tokens were not consumed.`,
      iterationsUsed,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  // 9. Consume input tokens if consume:true
  const presets = inscription.presets || {};
  for (const [presetName, preset] of Object.entries(presets) as [string, any][]) {
    if (!preset.consume) continue;

    const presetModelId = bindingModels.get(presetName) || modelId;
    const tokens = bindings.get(presetName) || [];
    for (const token of tokens) {
      const tokenId = token._meta?.id || token.id;
      const tokenParentId = token._meta?.parentId || token.parentId;
      if (tokenId && tokenParentId) {
        try {
          await nodeApi.deleteLeaf(presetModelId, tokenId, tokenParentId);
          consumedTokens++;
        } catch (err: any) {
          if (onProgress) {
            onProgress({ type: 'error', content: `Failed to consume token '${tokenId}': ${err.message}` });
          }
        }
      }
    }
  }

  return { success: true, summary, iterationsUsed, emittedTokens, consumedTokens };
}

// ---- Internal helpers ----

async function readInscription(nodeApi: NodeApi, modelId: string, transitionId: string): Promise<any | null> {
  const path = `root/workspace/transitions/${transitionId}`;
  try {
    const children = await nodeApi.getChildren(modelId, path);
    const inscriptionLeaf = children.find((c: any) => c.name === 'inscription');
    if (!inscriptionLeaf) return null;
    const value = inscriptionLeaf.properties?.value;
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function bindPresets(
  nodeApi: NodeApi,
  defaultModelId: string,
  presets: Record<string, any>,
) : Promise<{ bindings: Map<string, any[]>; bindingModels: Map<string, string> }> {
  const bindings = new Map<string, any[]>();
  const bindingModels = new Map<string, string>();

  for (const [presetName, preset] of Object.entries(presets)) {
    const host = preset.host || '';
    const { modelId: hostModelId } = parseHost(host);
    const effectiveModelId = hostModelId || defaultModelId;
    bindingModels.set(presetName, effectiveModelId);

    const placePath = `root/workspace/places/${preset.placeId}`;
    const query = preset.arcql || 'FROM $ LIMIT 100';

    try {
      const result = await nodeApi.queryTokens(effectiveModelId, placePath, query, 'json_with_meta');
      let tokens: any[] = result?.results || [];

      // Apply take mode
      const take = (preset.take || 'FIRST').toUpperCase();
      if (take === 'FIRST' && tokens.length > 0) {
        tokens = [tokens[0]];
      }

      bindings.set(presetName, tokens);
    } catch (err: any) {
      // Empty binding on error — let the agent handle it
      bindings.set(presetName, []);
    }
  }

  return { bindings, bindingModels };
}

function findMissingPresetBindings(
  presets: Record<string, any>,
  bindings: Map<string, any[]>,
): Array<{ presetName: string; placeId: string }> {
  const missing: Array<{ presetName: string; placeId: string }> = [];

  for (const [presetName, preset] of Object.entries(presets || {})) {
    if (preset?.required === false) {
      continue;
    }
    const bound = bindings.get(presetName) || [];
    if (bound.length === 0) {
      missing.push({
        presetName,
        placeId: String(preset?.placeId || '').trim(),
      });
    }
  }

  return missing;
}

function formatMissingPresetBindings(
  missing: Array<{ presetName: string; placeId: string }>,
): string {
  return missing
    .map((item) => item.placeId ? `${item.presetName}:${item.placeId}` : item.presetName)
    .join(', ');
}

export function parseHost(host: string): { modelId: string | null; baseUrl: string } {
  if (!host || !host.trim()) {
    return { modelId: null, baseUrl: '' };
  }

  if (host.includes('@')) {
    const atIndex = host.indexOf('@');
    const modelId = host.substring(0, atIndex);
    const hostPort = host.substring(atIndex + 1);
    const baseUrl = hostPort.startsWith('http://') || hostPort.startsWith('https://')
      ? hostPort
      : `http://${hostPort}`;
    return { modelId, baseUrl };
  }

  const baseUrl = host.startsWith('http://') || host.startsWith('https://')
    ? host
    : `http://${host}`;
  return { modelId: null, baseUrl };
}

export function resolveNlExpression(nl: string, bindings: Map<string, any[]>): string {
  if (!nl) return '';

  // @path.to.field — direct path lookup
  if (nl.startsWith('@')) {
    const path = nl.substring(1);
    const value = resolvePathFromBindings(path, bindings);
    return renderResolvedValue(value, MAX_NL_DIRECT_LOOKUP_CHARS);
  }

  // ${template} interpolation
  if (nl.includes('${')) {
    return nl.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const value = resolvePathFromBindings(expr, bindings);
      return renderResolvedValue(value, MAX_NL_INTERPOLATION_CHARS);
    });
  }

  // Literal passthrough
  return nl;
}

function resolvePathFromBindings(path: string, bindings: Map<string, any[]>): any {
  const parts = path.split('.');
  const presetName = parts[0];

  const tokens = bindings.get(presetName);
  if (!tokens || tokens.length === 0) return path;

  // Use the first token for single-value access
  let current: any = tokens[0];
  for (let i = 1; i < parts.length; i++) {
    if (current == null) return path;
    // Try to auto-parse JSON strings
    if (typeof current === 'string') {
      try { current = JSON.parse(current); } catch { return current; }
    }
    const next = current[parts[i]];
    if (next === undefined && current != null && typeof current === 'object' && 'value' in current) {
      let unwrapped = current.value;
      if (typeof unwrapped === 'string') {
        try { unwrapped = JSON.parse(unwrapped); } catch { /* not JSON */ }
      }
      current = (unwrapped != null && typeof unwrapped === 'object') ? (unwrapped as any)[parts[i]] : next;
    } else {
      current = next;
    }
  }

  return current ?? path;
}

async function snapshotPostsetCounts(
  nodeApi: NodeApi,
  defaultModelId: string,
  postsets: Record<string, any>,
): Promise<Map<string, number>> {
  const snapshot = new Map<string, number>();
  for (const [postsetName, postset] of Object.entries(postsets)) {
    const placeId = postset?.placeId;
    if (!placeId) {
      continue;
    }
    const host = postset?.host || '';
    const { modelId: hostModelId } = parseHost(host);
    const effectiveModelId = hostModelId || defaultModelId;
    const placePath = `root/workspace/places/${placeId}`;
    const children = await nodeApi.getChildren(effectiveModelId, placePath);
    const count = Array.isArray(children) ? children.length : 0;
    snapshot.set(postsetName, count);
  }
  return snapshot;
}

function countPositiveDeltas(before: Map<string, number>, after: Map<string, number>): number {
  let emitted = 0;
  for (const [postsetName, afterCount] of after.entries()) {
    const beforeCount = before.get(postsetName) ?? 0;
    if (afterCount > beforeCount) {
      emitted += (afterCount - beforeCount);
    }
  }
  return emitted;
}

function buildBoundTokenContext(bindings: Map<string, any[]>): string {
  const contextParts: string[] = [];
  for (const [presetName, tokens] of bindings.entries()) {
    if (tokens.length === 0) {
      continue;
    }

    const previews = tokens
      .slice(0, MAX_TOKENS_PER_PRESET_IN_CONTEXT)
      .map((token) => truncateText(JSON.stringify(token, null, 2), MAX_TOKEN_PREVIEW_CHARS));

    const header = `### Preset "${presetName}" (${tokens.length} bound token${tokens.length === 1 ? '' : 's'})`;
    const body = previews.map((preview) => `\`\`\`json\n${preview}\n\`\`\``).join('\n');
    const omitted = tokens.length > MAX_TOKENS_PER_PRESET_IN_CONTEXT
      ? `\n(${tokens.length - MAX_TOKENS_PER_PRESET_IN_CONTEXT} additional token previews omitted)`
      : '';
    contextParts.push(`${header}\n${body}${omitted}`);
  }

  if (contextParts.length === 0) {
    return '';
  }
  const full = `\n\n## Bound Token Context\n\n${contextParts.join('\n\n')}`;
  return truncateText(full, MAX_BOUND_CONTEXT_CHARS);
}

function renderResolvedValue(value: any, maxChars: number): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return truncateText(raw ?? '', maxChars);
}

function truncateText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function collectPostsetPlacePaths(postsets: Record<string, any>): Set<string> {
  const paths = new Set<string>();
  for (const postset of Object.values(postsets)) {
    const placeId = postset?.placeId;
    if (!placeId) continue;
    paths.add(normalizePath(`root/workspace/places/${placeId}`));
  }
  return paths;
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

interface ParsedLlmResponse {
  json: any;
  raw: string;
}

async function executeLlmTransitionLocally(
  nodeApi: NodeApi,
  llm: LlmProvider,
  modelId: string,
  transitionId: string,
  inscription: any,
): Promise<TransitionExecutionResult> {
  const presets = inscription.presets || {};
  const postsets = inscription.postsets || {};
  const emitRules = Array.isArray(inscription.emit) ? inscription.emit as Array<Record<string, any>> : [];
  const action = inscription.action || {};

  const { bindings, bindingModels } = await bindPresets(nodeApi, modelId, presets);
  const missingPresetBindings = findMissingPresetBindings(presets, bindings);
  if (missingPresetBindings.length > 0) {
    return {
      success: false,
      error: `No tokens bound for required presets: ${formatMissingPresetBindings(missingPresetBindings)}. Seed input runtime places and retry.`,
      iterationsUsed: 0,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }
  const templateContext = buildLlmTemplateContext(bindings, { transitionId, modelId });

  const promptTemplate = String(action.nl || action.prompt || '').trim();
  if (!promptTemplate) {
    return {
      success: false,
      error: `LLM transition '${transitionId}' has no action.nl/action.prompt.`,
      iterationsUsed: 0,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  const systemTemplate = String(action.system || action.systemPrompt || LLM_DEFAULT_SYSTEM_PROMPT).trim();
  const prompt = interpolateFromContext(promptTemplate, templateContext, MAX_BOUND_CONTEXT_CHARS);
  const systemPrompt = interpolateFromContext(systemTemplate, templateContext, MAX_NL_DIRECT_LOOKUP_CHARS);

  let llmRaw = '';
  let llmParsed: ParsedLlmResponse;
  try {
    const response = await llm.chat(
      systemPrompt,
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [],
    );
    llmRaw = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as any).text || '')
      .join('\n')
      .trim();
    llmParsed = parseLlmResponse(llmRaw);
  } catch (err: any) {
    return {
      success: false,
      error: `Local LLM execution failed for '${transitionId}': ${err.message}`,
      iterationsUsed: 1,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  const responseContext: Record<string, any> = { ...templateContext };
  responseContext.response = {
    json: llmParsed.json,
    raw: llmParsed.raw,
    text: llmParsed.raw,
  };

  const emissions: Array<{ postsetName: string; payload: any }> = [];
  if (emitRules.length > 0) {
    const llmResponseMap = isPlainObject(llmParsed.json)
      ? llmParsed.json as Record<string, any>
      : { raw: llmParsed.raw };

    for (const emit of emitRules) {
      const whenCondition = String(emit?.when || 'success').trim().toLowerCase();
      if (whenCondition !== 'success') {
        continue;
      }

      const postsetName = String(emit?.to || '').trim();
      if (!postsetName) {
        continue;
      }

      const condition = String(emit?.condition || '').trim();
      if (condition && !evaluateSimpleCondition(condition, llmResponseMap)) {
        continue;
      }

      const payload = resolveLlmEmitPayload(emit?.from, responseContext, llmParsed);
      emissions.push({ postsetName, payload });
    }
  } else {
    emissions.push({ postsetName: 'output', payload: llmParsed.json });
  }

  const requiredPostsets = Object.keys(postsets).filter((name) => !!postsets[name]?.placeId);
  if (requiredPostsets.length > 0 && emissions.length === 0) {
    return {
      success: false,
      error: `Transition '${transitionId}' produced no matching emit rules. Input tokens were not consumed.`,
      iterationsUsed: 1,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  let emittedTokens = 0;
  try {
    emittedTokens = await emitLlmPayloads(nodeApi, modelId, transitionId, emissions, postsets);
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to emit LLM transition outputs: ${err.message}. Input tokens were not consumed.`,
      iterationsUsed: 1,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  if (requiredPostsets.length > 0 && emittedTokens <= 0) {
    return {
      success: false,
      error: `Transition '${transitionId}' completed but emitted no runtime tokens to postsets [${requiredPostsets.join(', ')}]. Input tokens were not consumed.`,
      iterationsUsed: 1,
      emittedTokens: 0,
      consumedTokens: 0,
    };
  }

  let consumedTokens = 0;
  for (const [presetName, preset] of Object.entries(presets) as [string, any][]) {
    if (!preset.consume) continue;

    const presetModelId = bindingModels.get(presetName) || modelId;
    const tokens = bindings.get(presetName) || [];
    for (const token of tokens) {
      const tokenId = token._meta?.id || token.id;
      const tokenParentId = token._meta?.parentId || token.parentId;
      if (tokenId && tokenParentId) {
        try {
          await nodeApi.deleteLeaf(presetModelId, tokenId, tokenParentId);
          consumedTokens++;
        } catch {
          // Best effort consumption. Emission already completed successfully.
        }
      }
    }
  }

  return {
    success: true,
    summary: `LLM transition '${transitionId}' completed locally.`,
    iterationsUsed: 1,
    emittedTokens,
    consumedTokens,
  };
}

function buildLlmTemplateContext(
  bindings: Map<string, any[]>,
  meta: { transitionId: string; modelId: string },
): Record<string, any> {
  const context: Record<string, any> = {
    transitionId: meta.transitionId,
    modelId: meta.modelId,
    now: new Date().toISOString(),
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };

  for (const [presetName, tokens] of bindings.entries()) {
    if (tokens.length > 0) {
      context[presetName] = tokens[0];
    }
  }
  return context;
}

function interpolateFromContext(template: string, context: Record<string, any>, maxChars: number): string {
  if (!template) return '';

  if (template.startsWith('@')) {
    const value = resolvePathFromObject(template.slice(1), context);
    return renderResolvedValue(value, maxChars);
  }

  if (template.includes('${')) {
    return template.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const value = resolvePathFromObject(expr.trim(), context);
      return renderResolvedValue(value, MAX_NL_INTERPOLATION_CHARS);
    });
  }

  return truncateText(template, maxChars);
}

function resolveLlmEmitPayload(
  fromExpression: unknown,
  responseContext: Record<string, any>,
  llmResponse: ParsedLlmResponse,
): any {
  const from = typeof fromExpression === 'string' ? fromExpression.trim() : '';
  if (!from) {
    return llmResponse.json;
  }

  switch (from) {
    case '@response':
    case '@response.json':
      return llmResponse.json;
    case '@response.raw':
    case '@response.text':
      return llmResponse.raw;
    default:
      break;
  }

  if (from.startsWith('@')) {
    return resolvePathFromObject(from.slice(1), responseContext);
  }

  if (from.includes('${')) {
    return interpolateFromContext(from, responseContext, MAX_NL_DIRECT_LOOKUP_CHARS);
  }

  return from;
}

async function emitLlmPayloads(
  nodeApi: NodeApi,
  defaultModelId: string,
  transitionId: string,
  emissions: Array<{ postsetName: string; payload: any }>,
  postsets: Record<string, any>,
): Promise<number> {
  let emitted = 0;

  for (const emission of emissions) {
    const postset = postsets[emission.postsetName];
    if (!postset?.placeId) {
      continue;
    }

    const host = postset.host || '';
    const { modelId: hostModelId } = parseHost(host);
    const effectiveModelId = hostModelId || defaultModelId;
    const placePath = `root/workspace/places/${postset.placeId}`;
    const parentInfo = await nodeApi.resolve(effectiveModelId, placePath);
    const parentId = parentInfo?.id || parentInfo;

    const properties = toTokenProperties(emission.payload);
    properties._transitionId = transitionId;
    properties._status = 'success';
    properties._emittedAt = new Date().toISOString();

    const tokenName = `${transitionId}-${emission.postsetName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await nodeApi.executeEvents(effectiveModelId, [{
      eventType: 'createLeaf',
      parentId,
      id: 'auto',
      name: tokenName,
      properties,
    }]);
    emitted++;
  }

  return emitted;
}

function toTokenProperties(payload: any): Record<string, string> {
  const properties: Record<string, string> = {};
  if (isPlainObject(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      if (value == null) continue;
      properties[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    if (Object.keys(properties).length > 0) {
      return properties;
    }
  }

  if (typeof payload === 'string') {
    properties.value = payload;
  } else if (payload == null) {
    properties.value = '';
  } else {
    properties.value = JSON.stringify(payload);
  }
  return properties;
}

function parseLlmResponse(rawText: string): ParsedLlmResponse {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return { json: { raw: '' }, raw: '' };
  }

  let cleaned = trimmed;
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7).trim();
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trim();
    }
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3).trim();
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trim();
    }
  }

  try {
    return { json: JSON.parse(cleaned), raw: trimmed };
  } catch (err: any) {
    return {
      json: { text: trimmed, parseError: err.message || String(err) },
      raw: trimmed,
    };
  }
}

function evaluateSimpleCondition(condition: string, response: Record<string, any>): boolean {
  const expr = (condition || '').trim();
  if (!expr) return true;

  const andParts = splitByOperator(expr, /\s+AND\s+/i);
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateSimpleCondition(part, response));
  }

  const orParts = splitByOperator(expr, /\s+OR\s+/i);
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateSimpleCondition(part, response));
  }

  return evaluateSingleComparison(expr, response);
}

function splitByOperator(expr: string, pattern: RegExp): string[] {
  return expr.split(pattern).map((s) => s.trim()).filter(Boolean);
}

function evaluateSingleComparison(comparison: string, response: Record<string, any>): boolean {
  const match = comparison.match(/([\w.]+)\s*(==|!=|>=|<=|>|<|=)\s*(.+)/);
  if (!match) return false;

  const fieldPath = match[1].trim();
  const operator = match[2].trim();
  const expected = parseConditionValue(match[3].trim());
  const actual = resolvePathFromObject(fieldPath, response);

  switch (operator) {
    case '=':
    case '==':
      return valuesEqual(actual, expected);
    case '!=':
      return !valuesEqual(actual, expected);
    case '>':
      return compareNumeric(actual, expected) > 0;
    case '>=':
      return compareNumeric(actual, expected) >= 0;
    case '<':
      return compareNumeric(actual, expected) < 0;
    case '<=':
      return compareNumeric(actual, expected) <= 0;
    default:
      return false;
  }
}

function parseConditionValue(raw: string): any {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^null$/i.test(trimmed)) return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function valuesEqual(actual: any, expected: any): boolean {
  if (actual == null && expected == null) return true;
  if (actual == null || expected == null) return false;

  const actualNum = toNumberMaybe(actual);
  const expectedNum = toNumberMaybe(expected);
  if (actualNum != null && expectedNum != null) {
    return actualNum === expectedNum;
  }
  return String(actual) === String(expected);
}

function compareNumeric(actual: any, expected: any): number {
  const actualNum = toNumberMaybe(actual);
  const expectedNum = toNumberMaybe(expected);
  if (actualNum == null || expectedNum == null) {
    return -1;
  }
  return actualNum === expectedNum ? 0 : (actualNum > expectedNum ? 1 : -1);
}

function toNumberMaybe(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function resolvePathFromObject(path: string, context: Record<string, any>): any {
  if (!path || !context) return undefined;
  if (Object.prototype.hasOwnProperty.call(context, path)) {
    return context[path];
  }

  const parts = path.split('.');
  let current: any = context;
  for (const part of parts) {
    if (current == null) return undefined;
    if (isPlainObject(current)) {
      current = (current as Record<string, any>)[part];
      continue;
    }
    return undefined;
  }
  return current;
}

function isPlainObject(value: any): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
