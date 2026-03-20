import type { AgentTool } from './tools.js';
import type { GatewayClient } from '../gateway/client.js';
import type { LlmProvider } from '../llm/provider.js';
import type { AgentEvent } from './runtime.js';
import { MasterApi } from '../gateway/master-api.js';
import { NodeApi } from '../gateway/node-api.js';
import { processContent, stripHtml, chunkText, type ContentMode } from './content-processor.js';

const DEFAULT_LOCAL_TRANSITION_MAX_ITERATIONS = 8;

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

interface RuntimeBindingIssue {
  kind: 'preset' | 'postset';
  name: string;
  placeId: string;
  path: string;
  modelId: string;
  error: string;
}

interface RuntimeBindingCheck {
  transitionId: string;
  checked: {
    presets: number;
    postsets: number;
  };
  missing: RuntimeBindingIssue[];
  ok: boolean;
}

interface NetDoctorArcRef {
  arcId: string;
  sourceId: string;
  targetId: string;
}

interface NetDoctorArcAdd {
  sourceId: string;
  targetId: string;
  transitionId: string;
  reason: string;
}

interface NetDoctorArcRemove {
  arcId: string;
  sourceId: string;
  targetId: string;
  reasons: string[];
}

interface NetDoctorTransitionCheck {
  transitionId: string;
  hasRuntimeInscription: boolean;
  runtimeInputs: string[];
  runtimeOutputs: string[];
  visualInputs: string[];
  visualOutputs: string[];
  missingVisualInputs: string[];
  extraVisualInputs: string[];
  missingVisualOutputs: string[];
  extraVisualOutputs: string[];
}

interface NetDoctorAnalysis {
  modelId: string;
  sessionId: string;
  netId: string;
  transitionChecks: NetDoctorTransitionCheck[];
  proposed: {
    additions: NetDoctorArcAdd[];
    removals: NetDoctorArcRemove[];
    unresolved: string[];
  };
  summary: {
    transitions: number;
    transitionsWithRuntimeInscription: number;
    duplicateArcPairs: number;
    proposedAdditions: number;
    proposedRemovals: number;
    unresolvedIssues: number;
    driftDetected: boolean;
  };
}

/**
 * Executes agent tool calls by mapping them to gateway API calls.
 * Ported from AgentToolExecutor.java.
 */
export class ToolExecutor {
  private masterApi: MasterApi;
  private nodeApi: NodeApi;
  private helperLlm?: LlmProvider;
  private mainLlm?: LlmProvider;

  /** Callback for sub-agent progress events (set by chat/telegram before agent loop). */
  public onProgress?: (event: AgentEvent) => void;

  constructor(
    private client: GatewayClient,
    private modelId: string,
    private sessionId: string,
    helperLlm?: LlmProvider,
    mainLlm?: LlmProvider,
  ) {
    this.masterApi = new MasterApi(client);
    this.nodeApi = new NodeApi(client);
    this.helperLlm = helperLlm;
    this.mainLlm = mainLlm;
  }

  /** Fork an isolated executor (used by chat bridges to avoid cross-session callback races). */
  fork(opts?: { sessionId?: string; onProgress?: (event: AgentEvent) => void }): ToolExecutor {
    const forked = new ToolExecutor(
      this.client,
      this.modelId,
      opts?.sessionId ?? this.sessionId,
      this.helperLlm,
      this.mainLlm,
    );
    forked.onProgress = opts?.onProgress;
    return forked;
  }

  async execute(tool: AgentTool, params: Record<string, any>): Promise<ToolResult> {
    try {
      switch (tool) {
        case 'THINK':
          return this.executeThink(params);
        case 'QUERY_TOKENS':
          return this.executeQueryTokens(params);
        case 'CREATE_TOKEN':
          return this.executeCreateToken(params);
        case 'DELETE_TOKEN':
          return this.executeDeleteToken(params);
        case 'CREATE_RUNTIME_PLACE':
          return this.executeCreateRuntimePlace(params);
        case 'LIST_PLACES':
          return this.executeListPlaces();
        case 'GET_PLACE_INFO':
          return this.executeGetPlaceInfo(params);
        case 'GET_PLACE_CONNECTIONS':
          return this.executeGetPlaceConnections(params);
        case 'GET_TRANSITION':
          return this.executeGetTransition(params);
        case 'VERIFY_RUNTIME_BINDINGS':
          return this.executeVerifyRuntimeBindings(params);
        case 'GET_NET_STRUCTURE':
          return this.executeGetNetStructure(params);
        case 'VERIFY_NET':
          return this.executeVerifyNet(params);
        case 'EXPORT_PNML':
          return this.executeExportPnml(params);
        case 'NET_DOCTOR':
          return this.executeNetDoctor(params);
        case 'ADAPT_INSCRIPTIONS':
          return this.executeAdaptInscriptions(params);
        case 'CREATE_SESSION':
          return this.executeCreateSession(params);
        case 'CREATE_NET':
          return this.executeCreateNet(params);
        case 'DELETE_NET':
          return this.executeDeleteNet(params);
        case 'CREATE_PLACE':
          return this.executeCreatePlace(params);
        case 'CREATE_TRANSITION':
          return this.executeCreateTransition(params);
        case 'CREATE_ARC':
          return this.executeCreateArc(params);
        case 'DELETE_PLACE':
          return this.executeDeletePlace(params);
        case 'DELETE_ARC':
          return this.executeDeleteArc(params);
        case 'SET_INSCRIPTION':
          return this.executeSetInscription(params);
        case 'HTTP_CALL':
          return this.executeHttpCall(params);
        case 'LIST_ALL_SESSIONS':
          return this.executeListAllSessions();
        case 'LIST_ALL_INSCRIPTIONS':
          return this.executeListAllInscriptions(params);
        case 'LIST_SESSION_NETS':
          return this.executeListSessionNets(params);
        case 'EMIT_MEMORY':
          return this.executeEmitMemory(params);
        case 'EXTRACT_TOKEN_CONTENT':
          return this.executeExtractTokenContent(params);
        case 'EXTRACT_RAW_DATA':
          return this.executeExtractRawData(params);
        case 'GET_LINKED_PLACES':
          return this.executeGetLinkedPlaces(params);
        case 'FIND_SHARED_PLACES':
          return this.executeFindSharedPlaces(params);
        case 'PACKAGE_SEARCH':
          return this.executePackageSearch(params);
        case 'PACKAGE_PUBLISH':
          return this.executePackagePublish(params);
        case 'PACKAGE_INSTALL':
          return this.executePackageInstall(params);
        case 'REGISTRY_LIST_IMAGES':
          return this.executeRegistryListImages(params);
        case 'REGISTRY_GET_IMAGE_INFO':
          return this.executeRegistryGetImageInfo(params);
        case 'DOCKER_RUN':
          return this.executeDockerRun(params);
        case 'DOCKER_STOP':
          return this.executeDockerStop(params);
        case 'DOCKER_LIST':
          return this.executeDockerList(params);
        case 'DOCKER_LOGS':
          return this.executeDockerLogs(params);
        case 'DEPLOY_TRANSITION':
          return this.executeDeployTransition(params);
        case 'START_TRANSITION':
          return this.executeStartTransition(params);
        case 'STOP_TRANSITION':
          return this.executeStopTransition(params);
        case 'FIRE_ONCE':
          return this.executeFireOnce(params);
        case 'EXECUTE_TRANSITION':
          return this.executeTransitionLocally(params);
        case 'EXECUTE_TRANSITION_SMART':
          return this.executeTransitionSmart(params);
        case 'DRY_RUN_TRANSITION':
          return this.executeDryRunTransition(params);
        case 'VERIFY_INSCRIPTION':
          return this.executeVerifyInscription(params);
        case 'DIAGNOSE_TRANSITION':
          return this.executeDiagnoseTransition(params);
        case 'DONE':
          return { success: true, data: { status: 'done', summary: params.summary } };
        case 'FAIL':
          return { success: false, error: params.error };
        default:
          return { success: false, error: `Unknown tool: ${tool}` };
      }
    } catch (err: any) {
      const message = err.message || String(err);
      const stack = err.stack ? `\n${err.stack}` : '';
      console.error(`[tool-executor] ${tool} failed: ${message}${stack}`);
      return { success: false, error: message };
    }
  }

  private executeThink(params: Record<string, any>): ToolResult {
    return {
      success: true,
      data: {
        acknowledged: true,
        goal: params.goal,
        plan: params.plan,
        risks: params.risks,
        successCriteria: params.successCriteria,
      },
    };
  }

  private async executeQueryTokens(params: Record<string, any>): Promise<ToolResult> {
    const placePath = this.normalizePath(params.placePath);
    const query = params.query || params.arcql || 'FROM $ LIMIT 100';
    const fields: string[] | undefined = Array.isArray(params.fields) ? params.fields : undefined;
    let maxValueLength: number | undefined =
      typeof params.maxValueLength === 'number' ? params.maxValueLength : undefined;

    // Safety net: if no projection specified, auto-truncate long values to prevent
    // oversized responses crashing the LLM provider (e.g. 70KB HTML tokens).
    if (!fields && maxValueLength == null) {
      maxValueLength = 500;
    }

    let result: any;
    try {
      result = await this.nodeApi.queryTokens(this.modelId, placePath, query, 'json_with_meta', {
        fields,
        maxValueLength,
      });
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes('not found') || msg.includes('404') || msg.includes('does not exist')) {
        return {
          success: false,
          error: `Place '${placePath}' does not exist.`,
          data: {
            results: [],
            resultCount: 0,
            _hint: `Place '${placePath}' does not exist. Use CREATE_RUNTIME_PLACE to create it first.`,
          },
        };
      }
      throw err;
    }

    // Add truncation hint when values were auto-capped
    if (maxValueLength && !fields) {
      const data = result as any;
      if (data?.results?.length > 0 || data?.resultCount > 0) {
        data._hint = `Values truncated to ${maxValueLength} chars. Use EXTRACT_TOKEN_CONTENT(placePath, tokenName, mode) to read full content of individual tokens.`;
      }
    }
    return { success: true, data: result };
  }

  private async executeCreateToken(params: Record<string, any>): Promise<ToolResult> {
    const placePath = this.normalizePath(params.placePath);
    // Resolve parent UUID
    const parentInfo = await this.nodeApi.resolve(this.modelId, placePath);
    const parentId = parentInfo?.id || parentInfo;

    // Support aliases: name/tokenName, data/tokenData; auto-generate name if omitted
    const tokenName = params.name || params.tokenName || `token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tokenData = params.data || params.tokenData || {};

    const properties: Record<string, string> = {};
    if (tokenData && typeof tokenData === 'object') {
      for (const [key, val] of Object.entries(tokenData)) {
        properties[key] = typeof val === 'object' ? JSON.stringify(val) : String(val);
      }
    }

    const events = [{
      eventType: 'createLeaf',
      parentId,
      id: 'auto',
      name: tokenName,
      properties,
    }];

    const result = await this.nodeApi.executeEvents(this.modelId, events);
    return { success: true, data: result };
  }

  private async executeDeleteToken(params: Record<string, any>): Promise<ToolResult> {
    const placePath = this.normalizePath(params.placePath);
    const tokenName = params.tokenName;
    const tokenId = params.tokenId;

    if (!tokenName && !tokenId) {
      return { success: false, error: 'DELETE_TOKEN requires either tokenName or tokenId parameter' };
    }

    const children = await this.nodeApi.getChildren(this.modelId, placePath);

    // Find token by ID first (more precise), then fall back to name
    let token: any;
    if (tokenId) {
      token = children.find((c: any) => c.id === tokenId);
      if (!token) {
        return { success: true, data: { message: `Token with id '${tokenId}' not found in '${placePath}' (may already be deleted)` } };
      }
    } else {
      token = children.find((c: any) => c.name === tokenName);
      if (!token) {
        return { success: true, data: { message: `Token '${tokenName}' not found in '${placePath}' (may already be deleted)` } };
      }
    }

    await this.nodeApi.deleteLeaf(this.modelId, token.id, token.parentId);
    return { success: true, data: { deleted: token.name, deletedId: token.id } };
  }

  private async executeCreateRuntimePlace(params: Record<string, any>): Promise<ToolResult> {
    const placeId = params.placeId as string;
    const placesPath = 'root/workspace/places';

    // Check if place already exists (idempotent)
    const children = await this.nodeApi.getChildren(this.modelId, placesPath);
    const existing = children.find((c: any) => c.name === placeId);
    if (existing) {
      const existingType = String(existing?.type || existing?.kind || '').toLowerCase();
      const isLeaf = existingType.includes('leaf');

      // Repair common mismatch: visual/manual mistakes may leave a leaf at runtime place path.
      if (isLeaf && existing.id && existing.parentId) {
        await this.nodeApi.deleteLeaf(this.modelId, existing.id, existing.parentId);
        await this.nodeApi.executeEvents(this.modelId, [{
          eventType: 'createNode',
          parentId: existing.parentId,
          id: 'auto',
          name: placeId,
        }]);
        return { success: true, data: { placeId, repaired: true, previousType: existing.type || existing.kind } };
      }

      return { success: true, data: { placeId, exists: true, id: existing.id, type: existing.type || existing.kind } };
    }

    // Resolve parent UUID for root/workspace/places
    const placesInfo = await this.nodeApi.resolve(this.modelId, placesPath);
    const parentId = placesInfo?.id || placesInfo;

    await this.nodeApi.executeEvents(this.modelId, [{
      eventType: 'createNode',
      parentId,
      id: 'auto',
      name: placeId,
    }]);

    return { success: true, data: { placeId, created: true } };
  }

  private async executeListPlaces(): Promise<ToolResult> {
    const children = await this.nodeApi.getChildren(this.modelId, 'root/workspace/places');
    const places = await Promise.all(children.map(async (child: any) => {
      let tokenCount = 0;
      try {
        tokenCount = await this.nodeApi.getChildrenCount(this.modelId, `root/workspace/places/${child.name}`);
      } catch { /* place might be a leaf (broken), count stays 0 */ }
      return { name: child.name, id: child.id, type: child.type, tokenCount };
    }));
    return { success: true, data: places };
  }

  private async executeGetPlaceInfo(params: Record<string, any>): Promise<ToolResult> {
    const placePath = this.normalizePath(params.placePath);
    const children = await this.nodeApi.getChildren(this.modelId, placePath);
    return {
      success: true,
      data: {
        path: placePath,
        tokenCount: children.length,
        tokens: children.map((c: any) => ({ name: c.name, id: c.id })),
      },
    };
  }

  private async executeGetPlaceConnections(params: Record<string, any>): Promise<ToolResult> {
    const placeId = params.placeId as string;
    if (!placeId) {
      return { success: false, error: 'placeId is required' };
    }

    try {
      const transitionsPath = 'root/workspace/transitions';
      const transitionNodes = await this.nodeApi.getChildren(this.modelId, transitionsPath);

      const consumers: any[] = [];
      const producers: any[] = [];

      for (const node of transitionNodes) {
        const transitionId = node.name;
        try {
          const inscription = await this.loadTransitionInscription(transitionId);
          if (!inscription) continue;

          const kind = inscription.kind || '';

          // Check presets (consumers)
          const presets = inscription.presets || {};
          for (const [presetName, preset] of Object.entries(presets) as [string, any][]) {
            if (preset?.placeId === placeId) {
              const consumer: any = {
                transitionId,
                presetName,
                kind,
                arcql: preset.arcql || '',
                consume: preset.consume ?? false,
                take: preset.take || 'FIRST',
              };
              const tokenShape = this.analyzeExpectedTokenShape(inscription, presetName, kind);
              if (Object.keys(tokenShape).length > 0) {
                consumer.expectedTokenShape = tokenShape;
              }
              consumers.push(consumer);
            }
          }

          // Check postsets (producers)
          const postsets = inscription.postsets || {};
          for (const [postsetName, postset] of Object.entries(postsets) as [string, any][]) {
            if (postset?.placeId === placeId) {
              producers.push({
                transitionId,
                postsetName,
                kind,
              });
            }
          }
        } catch {
          // Skip transitions with no inscription or parse errors
        }
      }

      // Build summary
      let summary = `${consumers.length} consumer(s)`;
      if (consumers.length > 0) {
        summary += ` (${consumers.map(c => `${c.transitionId}/${c.kind}${c.consume ? '/consumes' : ''}`).join(', ')})`;
      }
      summary += `, ${producers.length} producer(s)`;
      if (producers.length > 0) {
        summary += ` (${producers.map(p => `${p.transitionId}/${p.kind}`).join(', ')})`;
      }

      return {
        success: true,
        data: { placeId, consumers, producers, summary },
      };
    } catch (err: any) {
      return { success: false, error: `Failed to scan place connections: ${err.message}` };
    }
  }

  private async executeGetTransition(params: Record<string, any>): Promise<ToolResult> {
    const path = `root/workspace/transitions/${params.transitionId}`;
    const children = await this.nodeApi.getChildren(this.modelId, path);
    const inscriptionLeaf = children.find((c: any) => c.name === 'inscription');
    if (!inscriptionLeaf) {
      return { success: true, data: { transitionId: params.transitionId, inscription: null } };
    }
    const value = inscriptionLeaf.properties?.value;
    let inscription;
    try {
      inscription = value ? JSON.parse(value) : null;
    } catch {
      inscription = value;
    }
    return { success: true, data: { transitionId: params.transitionId, inscription } };
  }

  private async executeVerifyRuntimeBindings(params: Record<string, any>): Promise<ToolResult> {
    const transitionId = params.transitionId as string;
    if (!transitionId) {
      return { success: false, error: 'transitionId is required' };
    }

    const inscription = await this.loadTransitionInscription(transitionId);
    if (!inscription) {
      return {
        success: false,
        error: `No inscription found for transition '${transitionId}'. Set inscription first with SET_INSCRIPTION.`,
      };
    }

    const check = await this.verifyRuntimeBindings(transitionId, inscription);
    if (check.ok) {
      return {
        success: true,
        data: {
          ...check,
          message: 'All runtime bindings are present.',
        },
      };
    }

    return {
      success: false,
      error: this.formatMissingBindings(check),
      data: check,
    };
  }

  private async executeGetNetStructure(params: Record<string, any>): Promise<ToolResult> {
    try {
      const sessionId = params.sessionId || this.sessionId || 'system/alive';
      const result = await this.masterApi.getNet(params.netId, this.modelId, sessionId);
      return { success: true, data: result };
    } catch (err: any) {
      return { success: false, error: `Failed to get net structure: ${err.message || err}` };
    }
  }

  private async executeVerifyNet(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const result = await this.masterApi.getNet(params.netId, this.modelId, sessionId);
    return { success: true, data: result };
  }

  private async executeExportPnml(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const result = await this.masterApi.exportNet(params.netId, this.modelId, sessionId);
    return { success: true, data: result };
  }

  private async executeNetDoctor(params: Record<string, any>): Promise<ToolResult> {
    const netId = String(params.netId || '').trim();
    let sessionId = String(params.sessionId || this.sessionId || '').trim();
    const applyFixes = params.applyFixes === true;

    if (!netId) {
      return { success: false, error: 'netId is required' };
    }
    if (!sessionId) {
      sessionId = 'system/alive';
    }

    let analysis: NetDoctorAnalysis;
    try {
      analysis = await this.analyzeNetDoctor(netId, sessionId);
    } catch (err: any) {
      return { success: false, error: `NET_DOCTOR failed to analyze net '${netId}': ${err.message || err}` };
    }
    if (!applyFixes) {
      return { success: true, data: { ...analysis, applied: false } };
    }

    const applyResult = await this.applyNetDoctorFixes(netId, sessionId, analysis.proposed);
    const postCheck = await this.analyzeNetDoctor(netId, sessionId);
    return {
      success: true,
      data: {
        ...analysis,
        applied: true,
        applyResult,
        postCheck: postCheck.summary,
      },
    };
  }

  private async executeAdaptInscriptions(params: Record<string, any>): Promise<ToolResult> {
    const netId = String(params.netId || '').trim();
    let sessionId = String(params.sessionId || this.sessionId || '').trim();
    const applyFixes = params.applyFixes === true;

    if (!netId) {
      return { success: false, error: 'netId is required' };
    }
    if (!sessionId) {
      sessionId = 'system/alive';
    }

    try {
      // Get net structure
      const rawNet = await this.masterApi.getNet(netId, this.modelId, sessionId);
      const net = rawNet?.net ?? rawNet;
      const places = net?.places ?? {};
      const transitions = net?.transitions ?? {};
      const arcs = net?.arcs ?? {};

      // Normalize entries
      const placeEntries = Array.isArray(places)
        ? places.map((p: any) => String(p?.placeId || p?.id || ''))
        : Object.entries(places).map(([id]: [string, any]) => id);
      const transitionEntries = Array.isArray(transitions)
        ? transitions.map((t: any) => String(t?.transitionId || t?.id || ''))
        : Object.entries(transitions).map(([id]: [string, any]) => id);

      const placeIdSet = new Set(placeEntries);
      const transitionIdSet = new Set(transitionEntries);

      // Build arc topology
      const arcPresets = new Map<string, Set<string>>(); // transitionId -> preset place IDs
      const arcPostsets = new Map<string, Set<string>>(); // transitionId -> postset place IDs

      const arcEntries = Array.isArray(arcs)
        ? arcs.map((a: any) => ({ source: String(a?.sourceId || a?.source || ''), target: String(a?.targetId || a?.target || '') }))
        : Object.entries(arcs).map(([, v]: [string, any]) => ({ source: String(v?.sourceId || v?.source || ''), target: String(v?.targetId || v?.target || '') }));

      for (const arc of arcEntries) {
        if (placeIdSet.has(arc.source) && transitionIdSet.has(arc.target)) {
          if (!arcPresets.has(arc.target)) arcPresets.set(arc.target, new Set());
          arcPresets.get(arc.target)!.add(arc.source);
        } else if (transitionIdSet.has(arc.source) && placeIdSet.has(arc.target)) {
          if (!arcPostsets.has(arc.source)) arcPostsets.set(arc.source, new Set());
          arcPostsets.get(arc.source)!.add(arc.target);
        }
      }

      // Check each transition's inscription
      const mismatches: any[] = [];
      let checkedCount = 0;
      let fixedCount = 0;

      for (const transitionId of transitionEntries) {
        const expectedPresets = arcPresets.get(transitionId) ?? new Set<string>();
        const expectedPostsets = arcPostsets.get(transitionId) ?? new Set<string>();

        // Load inscription using existing helper
        let inscription: any;
        try {
          inscription = await this.loadTransitionInscription(transitionId);
        } catch {
          continue;
        }
        if (!inscription) continue;
        checkedCount++;

        // Extract inscription preset/postset placeIds
        const inscPresets = new Set<string>();
        if (inscription.presets) {
          for (const v of Object.values(inscription.presets) as any[]) {
            if (v?.placeId) inscPresets.add(v.placeId);
          }
        }
        const inscPostsets = new Set<string>();
        if (inscription.postsets) {
          for (const v of Object.values(inscription.postsets) as any[]) {
            if (v?.placeId) inscPostsets.add(v.placeId);
          }
        }

        // Compare
        const presetDrift: string[] = [];
        const postsetDrift: string[] = [];

        for (const p of inscPresets) {
          if (!expectedPresets.has(p)) presetDrift.push(`inscription references preset '${p}' but no arc connects it`);
        }
        for (const p of expectedPresets) {
          if (!inscPresets.has(p)) presetDrift.push(`arc connects '${p}' as preset but inscription misses it`);
        }
        for (const p of inscPostsets) {
          if (!expectedPostsets.has(p)) postsetDrift.push(`inscription references postset '${p}' but no arc connects it`);
        }
        for (const p of expectedPostsets) {
          if (!inscPostsets.has(p)) postsetDrift.push(`arc connects '${p}' as postset but inscription misses it`);
        }

        // Validate NL expression references
        const nlIssues: string[] = [];
        if (inscription.action?.nl?.startsWith?.('@')) {
          const exprPath = inscription.action.nl.substring(1);
          const presetRef = exprPath.includes('.') ? exprPath.substring(0, exprPath.indexOf('.')) : exprPath;
          const presetKeys = Object.keys(inscription.presets || {});
          if (!presetKeys.includes(presetRef)) {
            nlIssues.push(`action.nl references '${presetRef}' but no preset key exists (available: ${presetKeys.join(', ')})`);
          }
        }

        if (presetDrift.length > 0 || postsetDrift.length > 0 || nlIssues.length > 0) {
          const mismatch: any = {
            transitionId,
            presetDrift,
            postsetDrift,
            nlIssues,
            arcPresets: [...expectedPresets],
            arcPostsets: [...expectedPostsets],
            inscriptionPresets: [...inscPresets],
            inscriptionPostsets: [...inscPostsets],
          };

          if (applyFixes) {
            try {
              // Rebuild presets to match arcs
              if (![...inscPresets].every(p => expectedPresets.has(p)) || ![...expectedPresets].every(p => inscPresets.has(p))) {
                const newPresets: any = {};
                const existingKeys = Object.keys(inscription.presets || {});
                let idx = 0;
                for (const placeId of expectedPresets) {
                  const key = idx < existingKeys.length ? existingKeys[idx] : `input${idx > 0 ? idx : ''}`;
                  const existingConfig = idx < existingKeys.length ? { ...(inscription.presets[existingKeys[idx]] || {}) } : { arcql: 'FROM $ LIMIT 1', take: 'FIRST', consume: true };
                  existingConfig.placeId = placeId;
                  newPresets[key] = existingConfig;
                  idx++;
                }
                inscription.presets = newPresets;
              }
              // Rebuild postsets to match arcs
              if (![...inscPostsets].every(p => expectedPostsets.has(p)) || ![...expectedPostsets].every(p => inscPostsets.has(p))) {
                const newPostsets: any = {};
                const existingKeys = Object.keys(inscription.postsets || {});
                let idx = 0;
                for (const placeId of expectedPostsets) {
                  const key = idx < existingKeys.length ? existingKeys[idx] : `output${idx > 0 ? idx : ''}`;
                  const existingConfig = idx < existingKeys.length ? { ...(inscription.postsets[existingKeys[idx]] || {}) } : {};
                  existingConfig.placeId = placeId;
                  newPostsets[key] = existingConfig;
                  idx++;
                }
                inscription.postsets = newPostsets;
              }
              // Write back using the same SET_INSCRIPTION path
              await this.executeSetInscription({ transitionId, inscription });
              fixedCount++;
              mismatch.fixed = true;
            } catch (err: any) {
              mismatch.fixed = false;
              mismatch.fixError = err.message || String(err);
            }
          }

          mismatches.push(mismatch);
        }
      }

      return {
        success: true,
        data: {
          netId,
          transitionCount: transitionEntries.length,
          checkedCount,
          mismatchCount: mismatches.length,
          mismatches,
          fixesApplied: applyFixes,
          fixedCount,
        },
      };
    } catch (err: any) {
      return { success: false, error: `ADAPT_INSCRIPTIONS failed: ${err.message || err}` };
    }
  }

  private async executeCreateSession(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId;
    if (!sessionId) return { success: false, error: 'sessionId is required' };
    const result = await this.masterApi.createSession(
      this.modelId,
      sessionId,
      {
        naturalLanguageText: params.naturalLanguageText || '',
        description: params.description,
      }
    );
    return { success: true, data: result };
  }

  private async executeCreateNet(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const result = await this.masterApi.createNet({
      modelId: this.modelId,
      sessionId,
      netId: params.netId,
      name: params.name,
      description: params.description,
    });
    return { success: true, data: result };
  }

  private async analyzeNetDoctor(netId: string, sessionId: string): Promise<NetDoctorAnalysis> {
    const rawNet = await this.masterApi.getNet(netId, this.modelId, sessionId);
    const net = rawNet?.net ?? rawNet;
    const places = net?.places ?? {};
    const transitions = net?.transitions ?? {};
    const arcs = net?.arcs ?? {};

    if (!places || !transitions || !arcs) {
      throw new Error(`NET_DOCTOR could not read net '${netId}' structure`);
    }

    const placeEntries = Array.isArray(places)
      ? places.map((place: any, index: number) => ({
        id: String(place?.placeId || place?.id || place?.name || `place-${index}`),
        value: place,
      }))
      : Object.entries(places).map(([id, value]: [string, any]) => ({ id, value }));

    const transitionEntries = Array.isArray(transitions)
      ? transitions.map((transition: any, index: number) => ({
        id: String(transition?.transitionId || transition?.id || transition?.name || `transition-${index}`),
        value: transition,
      }))
      : Object.entries(transitions).map(([id, value]: [string, any]) => ({ id, value }));

    const arcEntries = Array.isArray(arcs)
      ? arcs.map((arc: any, index: number) => ({
        arcId: String(arc?.arcId || arc?.id || arc?.name || `arc-${index}`),
        value: arc,
      }))
      : Object.entries(arcs).map(([arcId, value]: [string, any]) => ({ arcId, value }));

    const placeIds = new Set<string>(placeEntries.map((entry) => entry.id));
    const transitionIds = transitionEntries.map((entry) => entry.id).sort();
    const arcRefs: NetDoctorArcRef[] = arcEntries.map(({ arcId, value }: { arcId: string; value: any }) => ({
      arcId,
      sourceId: String(value?.source || value?.sourceId || '').trim(),
      targetId: String(value?.target || value?.targetId || '').trim(),
    }));

    const pairKey = (sourceId: string, targetId: string): string => `${sourceId}=>${targetId}`;
    const pairMap = new Map<string, NetDoctorArcRef[]>();
    const arcById = new Map<string, NetDoctorArcRef>();

    for (const arc of arcRefs) {
      arcById.set(arc.arcId, arc);
      const key = pairKey(arc.sourceId, arc.targetId);
      const bucket = pairMap.get(key) ?? [];
      bucket.push(arc);
      pairMap.set(key, bucket);
    }

    const removalReasons = new Map<string, Set<string>>();
    const additionsByPair = new Map<string, NetDoctorArcAdd>();
    const unresolved = new Set<string>();
    let duplicateArcPairs = 0;

    const planRemove = (arcId: string, reason: string): void => {
      const reasons = removalReasons.get(arcId) ?? new Set<string>();
      reasons.add(reason);
      removalReasons.set(arcId, reasons);
    };

    const planRemoveByPair = (sourceId: string, targetId: string, reason: string): void => {
      const arcsForPair = pairMap.get(pairKey(sourceId, targetId)) ?? [];
      for (const arc of arcsForPair) {
        planRemove(arc.arcId, reason);
      }
    };

    const planAdd = (sourceId: string, targetId: string, transitionId: string, reason: string): void => {
      const key = pairKey(sourceId, targetId);
      if ((pairMap.get(key)?.length ?? 0) > 0) return;
      if (additionsByPair.has(key)) return;
      additionsByPair.set(key, { sourceId, targetId, transitionId, reason });
    };

    // Remove duplicate arcs (keep lexicographically first arcId).
    for (const [pair, refs] of pairMap.entries()) {
      if (refs.length <= 1) continue;
      duplicateArcPairs++;
      const sorted = [...refs].sort((a, b) => a.arcId.localeCompare(b.arcId));
      for (const duplicate of sorted.slice(1)) {
        planRemove(duplicate.arcId, `duplicate arc for ${pair}`);
      }
    }

    const transitionChecks: NetDoctorTransitionCheck[] = [];
    let transitionsWithRuntimeInscription = 0;

    for (const transitionId of transitionIds) {
      let inscription: any | null = null;
      try {
        inscription = await this.loadTransitionInscription(transitionId);
      } catch {
        inscription = null;
      }

      const visualInputs = Array.from(new Set(
        arcRefs
          .filter((arc) => arc.targetId === transitionId && placeIds.has(arc.sourceId))
          .map((arc) => arc.sourceId),
      )).sort();
      const visualOutputs = Array.from(new Set(
        arcRefs
          .filter((arc) => arc.sourceId === transitionId && placeIds.has(arc.targetId))
          .map((arc) => arc.targetId),
      )).sort();

      if (!inscription) {
        transitionChecks.push({
          transitionId,
          hasRuntimeInscription: false,
          runtimeInputs: [],
          runtimeOutputs: [],
          visualInputs,
          visualOutputs,
          missingVisualInputs: [],
          extraVisualInputs: [],
          missingVisualOutputs: [],
          extraVisualOutputs: [],
        });
        continue;
      }

      transitionsWithRuntimeInscription++;

      const runtimeInputs = Array.from(new Set(
        Object.values(inscription?.presets ?? {})
          .map((preset: any) => String(preset?.placeId || '').trim())
          .filter((placeId: string) => !!placeId),
      )).sort();

      const runtimeOutputs = Array.from(new Set(
        Object.values(inscription?.postsets ?? {})
          .map((postset: any) => String(postset?.placeId || '').trim())
          .filter((placeId: string) => !!placeId),
      )).sort();

      const missingVisualInputs = runtimeInputs.filter((placeId) => !visualInputs.includes(placeId));
      const extraVisualInputs = visualInputs.filter((placeId) => !runtimeInputs.includes(placeId));
      const missingVisualOutputs = runtimeOutputs.filter((placeId) => !visualOutputs.includes(placeId));
      const extraVisualOutputs = visualOutputs.filter((placeId) => !runtimeOutputs.includes(placeId));

      for (const placeId of missingVisualInputs) {
        if (!placeIds.has(placeId)) {
          unresolved.add(`Transition '${transitionId}' runtime input place '${placeId}' is missing in visual net`);
          continue;
        }
        planAdd(placeId, transitionId, transitionId, `missing visual input arc from runtime preset (${placeId} -> ${transitionId})`);
      }
      for (const placeId of extraVisualInputs) {
        planRemoveByPair(placeId, transitionId, `extra visual input arc not present in runtime inscription (${placeId} -> ${transitionId})`);
      }
      for (const placeId of missingVisualOutputs) {
        if (!placeIds.has(placeId)) {
          unresolved.add(`Transition '${transitionId}' runtime output place '${placeId}' is missing in visual net`);
          continue;
        }
        planAdd(transitionId, placeId, transitionId, `missing visual output arc from runtime postset (${transitionId} -> ${placeId})`);
      }
      for (const placeId of extraVisualOutputs) {
        planRemoveByPair(transitionId, placeId, `extra visual output arc not present in runtime inscription (${transitionId} -> ${placeId})`);
      }

      transitionChecks.push({
        transitionId,
        hasRuntimeInscription: true,
        runtimeInputs,
        runtimeOutputs,
        visualInputs,
        visualOutputs,
        missingVisualInputs,
        extraVisualInputs,
        missingVisualOutputs,
        extraVisualOutputs,
      });
    }

    const removals: NetDoctorArcRemove[] = Array.from(removalReasons.entries())
      .map(([arcId, reasons]) => {
        const arc = arcById.get(arcId);
        return {
          arcId,
          sourceId: arc?.sourceId || '',
          targetId: arc?.targetId || '',
          reasons: Array.from(reasons).sort(),
        };
      })
      .sort((a, b) => a.arcId.localeCompare(b.arcId));

    const additions: NetDoctorArcAdd[] = Array.from(additionsByPair.values())
      .sort((a, b) => `${a.sourceId}->${a.targetId}`.localeCompare(`${b.sourceId}->${b.targetId}`));

    const unresolvedIssues = Array.from(unresolved).sort();
    const driftDetected = removals.length > 0 || additions.length > 0 || unresolvedIssues.length > 0;

    return {
      modelId: this.modelId,
      sessionId,
      netId,
      transitionChecks,
      proposed: {
        additions,
        removals,
        unresolved: unresolvedIssues,
      },
      summary: {
        transitions: transitionIds.length,
        transitionsWithRuntimeInscription,
        duplicateArcPairs,
        proposedAdditions: additions.length,
        proposedRemovals: removals.length,
        unresolvedIssues: unresolvedIssues.length,
        driftDetected,
      },
    };
  }

  private async applyNetDoctorFixes(
    netId: string,
    sessionId: string,
    proposed: { additions: NetDoctorArcAdd[]; removals: NetDoctorArcRemove[] },
  ): Promise<any> {
    const removed: string[] = [];
    const removeErrors: Array<{ arcId: string; error: string }> = [];
    const added: Array<{ arcId: string; sourceId: string; targetId: string }> = [];
    const addErrors: Array<{ sourceId: string; targetId: string; error: string }> = [];

    const resolvedSessionId = sessionId || 'system/alive';
    const arcsPath = `root/workspace/sessions/${resolvedSessionId}/workspace-nets/${netId}/pnml/net/arcs`;
    const arcNodes = await this.nodeApi.getChildren(this.modelId, arcsPath);
    const arcNodeByName = new Map<string, any>();
    for (const node of arcNodes) {
      arcNodeByName.set(node.name, node);
    }

    for (const removal of proposed.removals) {
      const node = arcNodeByName.get(removal.arcId);
      if (!node) {
        removeErrors.push({ arcId: removal.arcId, error: 'Arc node not found in current net tree' });
        continue;
      }
      try {
        await this.nodeApi.deleteNode(this.modelId, node.id, node.parentId);
        removed.push(removal.arcId);
      } catch (err: any) {
        removeErrors.push({ arcId: removal.arcId, error: err.message || String(err) });
      }
    }

    const baseTs = Date.now();
    for (let i = 0; i < proposed.additions.length; i++) {
      const addition = proposed.additions[i];
      const arcId = `a-doctor-${baseTs}-${i + 1}`;
      try {
        await this.masterApi.createArc(netId, {
          modelId: this.modelId,
          sessionId,
          arcId,
          sourceId: addition.sourceId,
          targetId: addition.targetId,
        });
        added.push({ arcId, sourceId: addition.sourceId, targetId: addition.targetId });
      } catch (err: any) {
        addErrors.push({
          sourceId: addition.sourceId,
          targetId: addition.targetId,
          error: err.message || String(err),
        });
      }
    }

    return {
      attempted: {
        removals: proposed.removals.length,
        additions: proposed.additions.length,
      },
      applied: {
        removed: removed.length,
        added: added.length,
      },
      details: {
        removed,
        added,
        removeErrors,
        addErrors,
      },
      success: removeErrors.length === 0 && addErrors.length === 0,
    };
  }

  private async executeDeleteNet(params: Record<string, any>): Promise<ToolResult> {
    // Delete net by removing tree structure
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const path = `root/workspace/sessions/${sessionId}/workspace-nets/${params.netId}`;
    const info = await this.nodeApi.resolve(this.modelId, path);
    if (info?.id) {
      await this.nodeApi.executeEvents(this.modelId, [{ eventType: 'deleteNode', id: info.id }]);
    }
    return { success: true, data: { deleted: params.netId } };
  }

  private async executeCreatePlace(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const result = await this.masterApi.createPlace(params.netId, {
      modelId: this.modelId,
      sessionId,
      placeId: params.placeId,
      label: params.label,
      x: params.x,
      y: params.y,
      tokens: params.tokens,
    });
    return { success: true, data: result };
  }

  private async executeCreateTransition(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const result = await this.masterApi.createTransition(params.netId, {
      modelId: this.modelId,
      sessionId,
      transitionId: params.transitionId,
      label: params.label,
      x: params.x,
      y: params.y,
    });
    return { success: true, data: result };
  }

  private async executeCreateArc(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const result = await this.masterApi.createArc(params.netId, {
      modelId: this.modelId,
      sessionId,
      arcId: params.arcId || `a-${Date.now()}`,
      sourceId: params.sourceId,
      targetId: params.targetId,
    });
    return { success: true, data: result };
  }

  private async executeDeletePlace(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const netId = params.netId;
    const placeId = params.placeId;
    if (!netId || !placeId) {
      return { success: false, error: 'DELETE_PLACE requires netId and placeId' };
    }

    // PNML places are stored under the net's pnml/net/places/{placeId} path
    // We need to find the net first, then resolve the place within it
    try {
      const netExport = await this.masterApi.exportNet(netId, this.modelId, sessionId);
      const places = netExport?.net?.places || netExport?.places || {};
      if (!places[placeId]) {
        return { success: true, data: { deleted: false, placeId, message: `Place '${placeId}' not found in net '${netId}'` } };
      }

      // Resolve and delete the place node from the PNML tree
      // Places are stored at: root/workspace/sessions/{sid}/workspace-nets/{netId}/pnml/net/places/{placeId}
      const placePath = `root/workspace/sessions/${sessionId}/workspace-nets/${netId}/pnml/net/places/${placeId}`;
      const info = await this.nodeApi.resolve(this.modelId, placePath);
      if (info?.id) {
        await this.nodeApi.executeEvents(this.modelId, [{ eventType: 'deleteNode', id: info.id }]);
        return { success: true, data: { deleted: true, placeId, netId } };
      }
      return { success: true, data: { deleted: false, placeId, message: 'Could not resolve place path for deletion' } };
    } catch (err: any) {
      return { success: false, error: `DELETE_PLACE failed: ${err.message || err}` };
    }
  }

  private async executeDeleteArc(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId || 'system/alive';
    const netId = params.netId;
    const arcId = params.arcId;
    if (!netId || !arcId) {
      return { success: false, error: 'DELETE_ARC requires netId and arcId' };
    }

    try {
      const arcPath = `root/workspace/sessions/${sessionId}/workspace-nets/${netId}/pnml/net/arcs/${arcId}`;
      const info = await this.nodeApi.resolve(this.modelId, arcPath);
      if (info?.id) {
        await this.nodeApi.executeEvents(this.modelId, [{ eventType: 'deleteNode', id: info.id }]);
        return { success: true, data: { deleted: true, arcId, netId } };
      }
      return { success: true, data: { deleted: false, arcId, message: `Arc '${arcId}' not found in net '${netId}'` } };
    } catch (err: any) {
      return { success: false, error: `DELETE_ARC failed: ${err.message || err}` };
    }
  }

  private async executeSetInscription(params: Record<string, any>): Promise<ToolResult> {
    const transitionId = params.transitionId;
    const inscriptionJson = typeof params.inscription === 'string'
      ? params.inscription
      : JSON.stringify(params.inscription);

    // Find transition node under /root/workspace/transitions/
    const transitionsPath = 'root/workspace/transitions';

    try {
      // Try to list existing transition nodes; empty array if path doesn't exist yet
      let children: any[];
      try {
        children = await this.nodeApi.getChildren(this.modelId, transitionsPath);
      } catch {
        children = [];
      }

      const transitionNode = children.find((c: any) => c.name === transitionId);

      if (transitionNode) {
        const parentId = transitionNode.id;
        // Check if inscription already exists
        const transChildren = await this.nodeApi.getChildren(this.modelId, `${transitionsPath}/${transitionId}`);
        const existing = transChildren.find((c: any) => c.name === 'inscription');
        if (existing) {
          // Delete then recreate (updateProperty returns 400)
          await this.nodeApi.executeEvents(this.modelId, [
            { eventType: 'deleteLeaf', id: existing.id, parentId },
          ]);
          await this.nodeApi.executeEvents(this.modelId, [{
            eventType: 'createLeaf',
            parentId,
            id: 'auto',
            name: 'inscription',
            properties: { value: inscriptionJson },
          }]);
        } else {
          // Create new inscription leaf
          await this.nodeApi.executeEvents(this.modelId, [{
            eventType: 'createLeaf',
            parentId,
            id: 'auto',
            name: 'inscription',
            properties: { value: inscriptionJson },
          }]);
        }
      } else {
        // Ensure root/workspace/transitions node exists (bootstrap on fresh deploy)
        let transitionsId: string;
        try {
          const transitionsInfo = await this.nodeApi.resolve(this.modelId, transitionsPath);
          transitionsId = transitionsInfo?.id || transitionsInfo;
        } catch {
          // transitions node doesn't exist — create it under root/workspace
          const workspaceInfo = await this.nodeApi.resolve(this.modelId, 'root/workspace');
          const workspaceId = workspaceInfo?.id || workspaceInfo;
          await this.nodeApi.executeEvents(this.modelId, [{
            eventType: 'createNode',
            parentId: workspaceId,
            id: 'auto',
            name: 'transitions',
          }]);
          const wsChildren = await this.nodeApi.getChildren(this.modelId, 'root/workspace');
          const created = wsChildren.find((c: any) => c.name === 'transitions');
          transitionsId = created?.id;
          if (!transitionsId) {
            return { success: false, error: 'Failed to create transitions node under root/workspace' };
          }
        }

        // Create transition node
        await this.nodeApi.executeEvents(this.modelId, [{
          eventType: 'createNode',
          parentId: transitionsId,
          id: 'auto',
          name: transitionId,
        }]);

        // Re-resolve to get new node ID
        const updatedChildren = await this.nodeApi.getChildren(this.modelId, transitionsPath);
        const newNode = updatedChildren.find((c: any) => c.name === transitionId);
        if (newNode) {
          await this.nodeApi.executeEvents(this.modelId, [{
            eventType: 'createLeaf',
            parentId: newNode.id,
            id: 'auto',
            name: 'inscription',
            properties: { value: inscriptionJson },
          }]);
        }
      }
    } catch (err: any) {
      return { success: false, error: `Failed to set inscription: ${err.message}` };
    }

    return { success: true, data: { transitionId, inscriptionSet: true } };
  }

  private async executeHttpCall(params: Record<string, any>): Promise<ToolResult> {
    const result = await this.client.directCall(
      params.method,
      params.url,
      params.body,
      params.headers,
    );
    return { success: true, data: result };
  }

  private async executeListAllSessions(): Promise<ToolResult> {
    const children = await this.nodeApi.getChildren(this.modelId, 'root/workspace/sessions');
    return {
      success: true,
      data: children.map((c: any) => ({ name: c.name, id: c.id })),
    };
  }

  private async executeListAllInscriptions(params: Record<string, any>): Promise<ToolResult> {
    try {
      const kindFilter = params.kind ? String(params.kind).toLowerCase() : null;
      const includeContent = kindFilter ? true : Boolean(params.includeContent);
      const limit = params.limit ? Number(params.limit) : (kindFilter ? 3 : Infinity);

      const children = await this.nodeApi.getChildren(this.modelId, 'root/workspace/transitions');
      const transitions: any[] = [];

      for (const child of children) {
        const info: any = { transitionId: child.name, id: child.id };

        if (includeContent) {
          try {
            const inscription = await this.loadTransitionInscription(child.name);
            if (inscription) {
              info.inscription = inscription;
            }
          } catch {
            // Keep info even if inscription load fails
          }
        }

        // Filter by kind if requested
        if (kindFilter) {
          const kind = info.inscription?.kind;
          if (!kind || kind.toLowerCase() !== kindFilter) {
            continue;
          }
        }

        transitions.push(info);

        // Apply limit
        if (transitions.length >= limit) {
          break;
        }
      }

      const response: any = {
        modelId: this.modelId,
        transitionCount: transitions.length,
        transitions,
      };
      if (kindFilter) {
        response.kindFilter = kindFilter;
        response.limit = limit;
        response.note = `Filtered by kind='${kindFilter}'. Analyze these examples before creating new inscriptions of this type.`;
      } else {
        response.note = 'Showing all transitions in model';
      }
      return { success: true, data: response };
    } catch {
      return { success: true, data: [] };
    }
  }

  private async executeListSessionNets(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.sessionId || this.sessionId;
    if (!sessionId) {
      return {
        success: true,
        data: {
          sessionId: '',
          netCount: 0,
          nets: [],
          note: 'No session context available — this is a fresh agent execution without a session',
        },
      };
    }
    const path = `root/workspace/sessions/${sessionId}/workspace-nets`;
    try {
      const children = await this.nodeApi.getChildren(this.modelId, path);
      return {
        success: true,
        data: children.map((c: any) => ({ name: c.name, id: c.id })),
      };
    } catch {
      return { success: true, data: [] };
    }
  }

  private async executeEmitMemory(params: Record<string, any>): Promise<ToolResult> {
    // Write to memory place (simplified - writes to root/workspace/memory)
    const memoryPath = 'root/workspace/memory';
    try {
      const memInfo = await this.nodeApi.resolve(this.modelId, memoryPath);
      const parentId = memInfo?.id || memInfo;

      const properties: Record<string, string> = {};
      if (params.data) {
        for (const [key, val] of Object.entries(params.data)) {
          properties[key] = typeof val === 'object' ? JSON.stringify(val) : String(val);
        }
      }

      await this.nodeApi.executeEvents(this.modelId, [{
        eventType: 'createLeaf',
        parentId,
        id: 'auto',
        name: params.name,
        properties,
      }]);
      return { success: true, data: { emitted: params.name } };
    } catch (err: any) {
      return { success: false, error: `Failed to emit memory: ${err.message}` };
    }
  }

  // ---- Registry & Docker Tools ----

  private async executeRegistryListImages(params: Record<string, any>): Promise<ToolResult> {
    const search = params.search as string | undefined;
    const limit = (params.limit as number) || 20;
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    qs.set('limit', String(limit));
    const data = await this.masterApi.get(`/registry/images?${qs.toString()}`);
    return { success: true, data };
  }

  private async executeRegistryGetImageInfo(params: Record<string, any>): Promise<ToolResult> {
    const image = params.image as string;
    const tag = (params.tag as string) || 'latest';
    const data = await this.masterApi.get(`/registry/images/${encodeURIComponent(image)}/info?tag=${encodeURIComponent(tag)}`);
    return { success: true, data };
  }

  private async executeDockerRun(params: Record<string, any>): Promise<ToolResult> {
    const data = await this.masterApi.post('/docker/containers', {
      image: params.image,
      name: params.name || 'tool',
      env: params.env,
      sessionId: params.sessionId || this.sessionId || 'system/alive',
    });
    return { success: true, data };
  }

  private async executeDockerStop(params: Record<string, any>): Promise<ToolResult> {
    const id = params.containerId || params.name;
    if (!id) return { success: false, error: 'Provide containerId or name' };
    const data = await this.masterApi.post(`/docker/containers/${encodeURIComponent(id)}/stop`, {});
    return { success: true, data };
  }

  private async executeDockerList(params: Record<string, any>): Promise<ToolResult> {
    const filter = params.filter as string | undefined;
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    const data = await this.masterApi.get(`/docker/containers${qs}`);
    return { success: true, data };
  }

  private async executeDockerLogs(params: Record<string, any>): Promise<ToolResult> {
    const id = params.name || params.containerId;
    if (!id) return { success: false, error: 'Provide name or containerId' };
    const tail = (params.tail as number) || 50;
    const data = await this.masterApi.get(`/docker/containers/${encodeURIComponent(id)}/logs?tail=${tail}`);
    return { success: true, data };
  }

  // ---- Extract / Discovery / Package Tools ----

  private async executeExtractRawData(params: Record<string, any>): Promise<ToolResult> {
    const placePath = this.normalizePath(params.placePath);
    const query = params.query || params.arcql || 'FROM $';
    const properties: string[] | undefined = Array.isArray(params.properties) ? params.properties : undefined;
    const separator = (params.separator as string) || '\n';
    const maxLength = (params.maxLength as number) || 8000;

    try {
      const result = await this.nodeApi.queryTokens(this.modelId, placePath, query, 'json_with_meta', {});
      const tokens = result?.results || result || [];
      const lines: string[] = [];
      let totalLen = 0;

      for (const token of tokens) {
        const data = token?.data || token?.properties || token || {};
        const name = token?._meta?.name || token?.name || 'unknown';
        const fields = properties || Object.keys(data);
        const values = fields
          .filter(f => data[f] !== undefined)
          .map(f => `${f}: ${typeof data[f] === 'object' ? JSON.stringify(data[f]) : String(data[f])}`);
        const line = `[${name}] ${values.join(', ')}`;
        if (totalLen + line.length > maxLength) {
          lines.push(`... (truncated, ${tokens.length - lines.length} more tokens)`);
          break;
        }
        lines.push(line);
        totalLen += line.length;
      }

      return {
        success: true,
        data: {
          text: lines.join(separator),
          tokenCount: tokens.length,
          truncated: totalLen > maxLength,
        },
      };
    } catch (err: any) {
      return { success: false, error: `EXTRACT_RAW_DATA failed: ${err.message || err}` };
    }
  }

  private async executeGetLinkedPlaces(params: Record<string, any>): Promise<ToolResult> {
    const placeId = params.placeId as string;
    if (!placeId) return { success: false, error: 'placeId is required' };
    // Use master API to find place connections, then traverse linked places
    try {
      const data = await this.masterApi.post('/agent/tools/get-linked-places', {
        modelId: this.modelId,
        placeId,
        depth: params.depth || 1,
      });
      return { success: true, data };
    } catch (err: any) {
      // Fallback: return the place connections as linked places
      try {
        const connections = await this.masterApi.post('/agent/tools/get-place-connections', {
          modelId: this.modelId,
          placeId,
        });
        return { success: true, data: { placeId, connections, _hint: 'GET_LINKED_PLACES not available on this master version, showing connections instead' } };
      } catch {
        return { success: false, error: `GET_LINKED_PLACES failed: ${err.message || err}` };
      }
    }
  }

  private async executeFindSharedPlaces(params: Record<string, any>): Promise<ToolResult> {
    try {
      const namePattern = (params.namePattern as string) || 'p-*';
      const url = `/assistant/universal/${this.modelId}/query/shared-places?namePattern=${encodeURIComponent(namePattern)}`;
      const data = await this.masterApi.get(url);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: `FIND_SHARED_PLACES failed: ${err.message || err}` };
    }
  }

  private async executePackageSearch(params: Record<string, any>): Promise<ToolResult> {
    try {
      const data = await this.masterApi.searchPackages(
        params.query,
        params.tags,
        params.limit,
        params.offset,
      );
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: `PACKAGE_SEARCH failed: ${err.message || err}` };
    }
  }

  private async executePackagePublish(params: Record<string, any>): Promise<ToolResult> {
    const name = params.name as string;
    const version = params.version as string;
    const netId = params.netId as string;
    if (!name || !version || !netId) {
      return { success: false, error: 'PACKAGE_PUBLISH requires name, version, and netId' };
    }
    try {
      // First create the package metadata, then publish
      await this.masterApi.createPackage({
        name,
        version,
        scope: 'user',
        description: params.description,
        tags: params.tags,
        source: {
          modelId: this.modelId,
          sessionId: params.sessionId || this.sessionId || 'system/alive',
          netId,
        },
      });
      const data = await this.masterApi.publishPackage(name, version, this.modelId);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: `PACKAGE_PUBLISH failed: ${err.message || err}` };
    }
  }

  private async executePackageInstall(params: Record<string, any>): Promise<ToolResult> {
    const name = params.name as string;
    const version = params.version as string;
    if (!name || !version) {
      return { success: false, error: 'PACKAGE_INSTALL requires name and version' };
    }
    try {
      const data = await this.masterApi.importPackage(
        name,
        version,
        this.modelId,
        params.targetSessionId || this.sessionId || 'system/alive',
      );
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: `PACKAGE_INSTALL failed: ${err.message || err}` };
    }
  }

  // ---- Deployment Tools ----

  private async executeDeployTransition(params: Record<string, any>): Promise<ToolResult> {
    const transitionId = params.transitionId as string;
    let inscription = params.inscription ?? await this.loadTransitionInscription(transitionId);
    inscription = this.normalizeInscription(inscription);
    if (!inscription) {
      return {
        success: false,
        error: `Cannot deploy '${transitionId}': no inscription found. Use SET_INSCRIPTION first.`,
      };
    }

    const preflight = await this.verifyRuntimeBindings(transitionId, inscription);
    if (!preflight.ok) {
      return {
        success: false,
        error: `Cannot deploy '${transitionId}': ${this.formatMissingBindings(preflight)}`,
        data: preflight,
      };
    }

    if (params.inscription) {
      const result = await this.masterApi.assignTransition({
        modelId: this.modelId,
        transitionId,
        agentId: 'agentic-net-executor-default',
        inscription,
      });
      return { success: true, data: { ...result, preflight } };
    }
    return { success: true, data: { transitionId, status: 'deploy_requested', preflight } };
  }

  private async executeStartTransition(params: Record<string, any>): Promise<ToolResult> {
    const preflight = await this.preflightTransitionOrFail(params.transitionId as string);
    if (!preflight.success) return preflight;

    const result = await this.masterApi.startTransition(params.transitionId, this.modelId);
    return { success: true, data: { ...result, preflight: preflight.data } };
  }

  private async executeStopTransition(params: Record<string, any>): Promise<ToolResult> {
    const result = await this.masterApi.stopTransition(params.transitionId, this.modelId);
    return { success: true, data: result };
  }

  private async executeDryRunTransition(params: Record<string, any>): Promise<ToolResult> {
    const result = await this.masterApi.dryRunTransition(params.transitionId, this.modelId);
    return { success: true, data: result };
  }

  private async executeVerifyInscription(params: Record<string, any>): Promise<ToolResult> {
    const result = await this.masterApi.verifyInscription(params.transitionId, this.modelId);
    return { success: true, data: result };
  }

  private async executeDiagnoseTransition(params: Record<string, any>): Promise<ToolResult> {
    const result = await this.masterApi.diagnoseTransition(params.transitionId, this.modelId);
    return { success: true, data: result };
  }

  private async executeFireOnce(params: Record<string, any>): Promise<ToolResult> {
    const transitionId = params.transitionId as string;
    const inscription = await this.loadTransitionInscription(transitionId);
    if (inscription) {
      const actionType = String(inscription?.action?.type || 'pass').toLowerCase();
      if (actionType === 'agent' || actionType === 'llm') {
        return {
          success: false,
          error: `FIRE_ONCE is disabled for action.type='${actionType}'. Use EXECUTE_TRANSITION_SMART (auto/local) to run this transition locally in CLI/Telegram.`,
        };
      }
    }

    const preflight = await this.preflightTransitionOrFail(params.transitionId as string);
    if (!preflight.success) return preflight;

    const result = await this.masterApi.fireOnce(transitionId, this.modelId);
    return { success: true, data: { ...result, preflight: preflight.data } };
  }

  private async executeTransitionLocally(params: Record<string, any>): Promise<ToolResult> {
    if (!this.mainLlm) {
      return { success: false, error: 'EXECUTE_TRANSITION requires a main LLM provider but none is configured.' };
    }

    const preflight = await this.preflightTransitionOrFail(params.transitionId as string);
    if (!preflight.success) return preflight;

    // Validate action type supports local execution (agent/llm only)
    const inscription = preflight.data?.inscription;
    const actionType = inscription?.action?.type;
    if (actionType && actionType !== 'agent' && actionType !== 'llm') {
      return {
        success: false,
        error: `EXECUTE_TRANSITION only supports agent/llm transitions locally. This transition is '${actionType}'. Use FIRE_ONCE for deterministic transitions (pass/map/http/command) or EXECUTE_TRANSITION_SMART with mode='auto'.`,
      };
    }

    const { executeTransitionLocally } = await import('./transition-executor.js');
    const result = await executeTransitionLocally(
      this.nodeApi,
      this.mainLlm,
      this,
      this.modelId,
      this.sessionId,
      {
        transitionId: params.transitionId,
        maxIterations: params.maxIterations,
        onProgress: this.onProgress,
      },
    );

    if (result.success) {
      return {
        success: true,
        data: {
          status: 'completed',
          summary: result.summary,
          iterationsUsed: result.iterationsUsed,
          emittedTokens: result.emittedTokens,
          consumedTokens: result.consumedTokens,
          preflight: preflight.data,
        },
      };
    }

    return { success: false, error: result.error };
  }

  private async executeTransitionSmart(params: Record<string, any>): Promise<ToolResult> {
    const transitionId = params.transitionId as string;
    if (!transitionId) {
      return { success: false, error: 'transitionId is required' };
    }

    const modeRaw = String(params.mode || 'auto').trim().toLowerCase();
    if (!['auto', 'local', 'master'].includes(modeRaw)) {
      return { success: false, error: `Invalid mode '${modeRaw}'. Use auto|local|master.` };
    }

    const inscription = await this.loadTransitionInscription(transitionId);
    if (!inscription) {
      return {
        success: false,
        error: `Cannot execute '${transitionId}': no inscription found. Use SET_INSCRIPTION first.`,
      };
    }

    const actionType = String(inscription?.action?.type || 'pass').toLowerCase();
    const supportsLocal = actionType === 'agent' || actionType === 'llm';
    const executionMode = modeRaw === 'auto'
      ? (supportsLocal ? 'local' : 'master')
      : modeRaw;

    if (executionMode === 'local' && !supportsLocal) {
      return {
        success: false,
        error: `Transition '${transitionId}' action.type='${actionType}' is not supported for local execution. Use mode:'master' or FIRE_ONCE.`,
      };
    }

    if (executionMode === 'master' && supportsLocal) {
      return {
        success: false,
        error: `Transition '${transitionId}' action.type='${actionType}' must run locally. Use mode:'auto' or mode:'local' with EXECUTE_TRANSITION_SMART.`,
      };
    }

    if (executionMode === 'local') {
      const requestedIterations = Number(params.maxIterations);
      const maxIterations = Number.isFinite(requestedIterations)
        ? Math.max(1, Math.floor(requestedIterations))
        : DEFAULT_LOCAL_TRANSITION_MAX_ITERATIONS;
      const localResult = await this.executeTransitionLocally({
        transitionId,
        maxIterations,
      });
      if (!localResult.success) {
        return {
          success: false,
          error: `[local:${actionType}] ${localResult.error || 'Transition execution failed.'}`,
        };
      }
      if (localResult.success && localResult.data) {
        localResult.data.executionMode = 'local';
        localResult.data.actionType = actionType;
      }
      return localResult;
    }

    const masterResult = await this.executeFireOnce({ transitionId });
    if (!masterResult.success) {
      return {
        success: false,
        error: `[master:${actionType}] ${masterResult.error || 'Transition execution failed.'}`,
      };
    }
    if (masterResult.success && masterResult.data) {
      masterResult.data.executionMode = 'master';
      masterResult.data.actionType = actionType;
    }
    return masterResult;
  }

  private async preflightTransitionOrFail(transitionId: string): Promise<ToolResult> {
    const inscription = await this.loadTransitionInscription(transitionId);
    if (!inscription) {
      return {
        success: false,
        error: `Cannot execute '${transitionId}': no inscription found. Use SET_INSCRIPTION first.`,
      };
    }

    const check = await this.verifyRuntimeBindings(transitionId, inscription);
    if (!check.ok) {
      return {
        success: false,
        error: `Runtime preflight failed for '${transitionId}': ${this.formatMissingBindings(check)}`,
        data: check,
      };
    }
    return { success: true, data: check };
  }

  private async loadTransitionInscription(transitionId: string): Promise<any | null> {
    const path = `root/workspace/transitions/${transitionId}`;
    const children = await this.nodeApi.getChildren(this.modelId, path);
    const inscriptionLeaf = children.find((c: any) => c.name === 'inscription');
    if (!inscriptionLeaf) {
      return null;
    }
    const value = inscriptionLeaf.properties?.value;
    if (!value) {
      return null;
    }
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  private async verifyRuntimeBindings(transitionId: string, inscription: any): Promise<RuntimeBindingCheck> {
    const missing: RuntimeBindingIssue[] = [];
    let presetCount = 0;
    let postsetCount = 0;

    const presets = inscription?.presets || {};
    for (const [name, preset] of Object.entries(presets) as [string, any][]) {
      const placeId = preset?.placeId;
      if (!placeId) {
        continue;
      }
      presetCount++;
      const targetModelId = this.parseHostModelId(preset?.host) || this.modelId;
      const path = `root/workspace/places/${placeId}`;
      try {
        await this.nodeApi.resolve(targetModelId, path);
      } catch (err: any) {
        missing.push({
          kind: 'preset',
          name,
          placeId,
          path,
          modelId: targetModelId,
          error: err.message || String(err),
        });
      }
    }

    const postsets = inscription?.postsets || {};
    for (const [name, postset] of Object.entries(postsets) as [string, any][]) {
      const placeId = postset?.placeId;
      if (!placeId) {
        continue;
      }
      postsetCount++;
      const targetModelId = this.parseHostModelId(postset?.host) || this.modelId;
      const path = `root/workspace/places/${placeId}`;
      try {
        await this.nodeApi.resolve(targetModelId, path);
      } catch (err: any) {
        missing.push({
          kind: 'postset',
          name,
          placeId,
          path,
          modelId: targetModelId,
          error: err.message || String(err),
        });
      }
    }

    return {
      transitionId,
      checked: { presets: presetCount, postsets: postsetCount },
      missing,
      ok: missing.length === 0,
    };
  }

  private parseHostModelId(host: unknown): string | null {
    if (typeof host !== 'string') {
      return null;
    }
    const trimmed = host.trim();
    if (!trimmed) {
      return null;
    }
    const atIndex = trimmed.indexOf('@');
    if (atIndex <= 0) {
      return null;
    }
    const modelId = trimmed.slice(0, atIndex).trim();
    return modelId || null;
  }

  private normalizeInscription(inscription: any): any | null {
    if (inscription == null) {
      return null;
    }
    if (typeof inscription === 'string') {
      return JSON.parse(inscription);
    }
    return inscription;
  }

  private formatMissingBindings(check: RuntimeBindingCheck): string {
    if (check.missing.length === 0) {
      return 'all bindings are present';
    }
    return check.missing
      .map((item) => `${item.kind} '${item.name}' -> ${item.path} (model: ${item.modelId})`)
      .join('; ');
  }

  private async executeExtractTokenContent(params: Record<string, any>): Promise<ToolResult> {
    const placePath = this.normalizePath(params.placePath);
    const tokenName = params.tokenName as string;
    const mode: ContentMode = params.mode || 'summarize';
    const property = params.property || 'body';
    const limit = typeof params.limit === 'number' ? params.limit : 4000;

    // Fetch all children of the place
    const children = await this.nodeApi.getChildren(this.modelId, placePath);
    const token = children.find((c: any) => c.name === tokenName);
    if (!token) {
      const available = children.map((c: any) => c.name);
      return {
        success: false,
        error: `Token '${tokenName}' not found in ${placePath}. Available: ${available.join(', ')}`,
      };
    }

    // Read the property value
    const raw = token.properties?.[property];
    if (!raw || typeof raw !== 'string') {
      const availableProps = token.properties ? Object.keys(token.properties) : [];
      return {
        success: false,
        error: `Property '${property}' not found or empty on token '${tokenName}'. Available properties: ${availableProps.join(', ')}`,
      };
    }

    // For non-summarize modes, use regex processing directly
    if (mode !== 'summarize') {
      const result = processContent(raw, mode, limit);
      return { success: true, data: result };
    }

    // Summarize mode: use helper LLM if available
    if (!this.helperLlm) {
      // Fallback to text mode with a note
      const result = processContent(raw, 'text', limit);
      return {
        success: true,
        data: { ...result, note: 'No helper LLM configured — fell back to text mode. Set helper_model in anthropic config.' },
      };
    }

    // Preprocess
    const preprocessed = processContent(raw, 'summarize', limit);
    const plainText = (preprocessed as any).plainText || (preprocessed as any).summary;

    // If it's already a JSON summary or short enough, return directly
    if ((preprocessed as any).summary || !plainText) {
      return { success: true, data: preprocessed };
    }

    // If plainText is short enough, single LLM call
    if (plainText.length <= limit) {
      const summary = await this.callHelperLlm(
        `You are a content summarizer. Provide a concise summary (under 500 words) focusing on: main topics, key facts, important data points, and actionable information.\n\nContent:\n${plainText}`,
      );
      return {
        success: true,
        data: { mode: 'summarize', contentType: preprocessed.contentType, originalLength: raw.length, summary },
      };
    }

    // Chunk and summarize
    const chunks = chunkText(plainText, 15000);
    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkSummary = await this.callHelperLlm(
        `You are a content summarizer. Summarize this content chunk concisely (under 300 words).\n\nContent (chunk ${i + 1} of ${chunks.length}):\n${chunks[i]}`,
      );
      chunkSummaries.push(chunkSummary);
    }

    // Aggregate summaries
    const aggregated = await this.callHelperLlm(
      `Combine these chunk summaries into one coherent overview (under 500 words):\n\n${chunkSummaries.join('\n\n---\n\n')}`,
    );

    return {
      success: true,
      data: {
        mode: 'summarize',
        contentType: preprocessed.contentType,
        originalLength: raw.length,
        summary: aggregated,
        chunksProcessed: chunks.length,
      },
    };
  }

  /** Call the helper LLM with a simple prompt (no tools). */
  private async callHelperLlm(prompt: string): Promise<string> {
    const response = await this.helperLlm!.chat(
      'You are a helpful content summarizer.',
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [], // no tools
    );
    return response.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('\n');
  }

  /**
   * Analyze the expected token shape for a consumer transition based on its inscription.
   */
  private analyzeExpectedTokenShape(inscription: any, presetName: string, kind: string): Record<string, any> {
    const shape: Record<string, any> = {};
    if (!kind) return shape;

    const k = kind.toLowerCase();
    switch (k) {
      case 'command':
        shape.description = 'Command transitions require the full CommandToken schema';
        shape.requiredFields = ['kind', 'id', 'executor', 'command', 'args', 'args.command'];
        shape.example = {
          kind: 'command', id: 'unique-cmd-id', executor: 'bash', command: 'exec',
          args: { command: 'your-shell-command-here' }, expect: 'text',
        };
        break;
      case 'map':
      case 'http':
      case 'llm':
      case 'agent': {
        const action = inscription.action || {};
        const templateText = this.getTemplateText(k, action);
        if (templateText) {
          const varPattern = /\$\{([^}]+)}/g;
          const allVars: string[] = [];
          let match: RegExpExecArray | null;
          while ((match = varPattern.exec(templateText)) !== null) {
            allVars.push(match[1].trim());
          }
          // Filter to vars referencing this preset
          const presetVars = allVars.filter(v => v.startsWith(presetName + '.'));
          const fields = presetVars.map(v => v.substring(presetName.length + 1));

          if (fields.length > 0) {
            shape.description = `Token fields referenced by ${kind.toUpperCase()} template`;
            shape.requiredFields = fields;
            shape.templateVars = presetVars.map(v => '${' + v + '}');
          } else {
            shape.description = `${kind.toUpperCase()} transition — no template variables reference preset '${presetName}'`;
          }
        } else {
          shape.description = `${kind.toUpperCase()} transition — no template text found`;
        }
        break;
      }
      case 'pass':
      case 'task':
        shape.description = 'Any token shape accepted — pass/task transitions forward tokens unchanged';
        break;
      default:
        shape.description = `Unknown transition kind '${kind}' — check inscription manually`;
        break;
    }
    return shape;
  }

  /** Extract the template text from an action based on transition kind. */
  private getTemplateText(kind: string, action: any): string | null {
    const parts: string[] = [];
    switch (kind) {
      case 'map':
        if (action.template != null) parts.push(typeof action.template === 'object' ? JSON.stringify(action.template) : String(action.template));
        break;
      case 'http':
        if (action.url) parts.push(String(action.url));
        if (action.body) parts.push(String(action.body));
        if (action.headers && typeof action.headers === 'object') {
          for (const v of Object.values(action.headers)) {
            if (v != null) parts.push(String(v));
          }
        }
        break;
      case 'llm':
        if (action.prompt) parts.push(String(action.prompt));
        if (action.nl) parts.push(String(action.nl));
        break;
      case 'agent':
        if (action.nl) parts.push(String(action.nl));
        break;
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /** Normalize common path issues from LLM hallucinations. */
  private normalizePath(path: string): string {
    if (!path) return path;
    // Remove leading/trailing slashes
    let p = path.replace(/^\/+|\/+$/g, '');
    // Fix common hallucinated prefixes for places
    if (p.startsWith('root/place/') || p.startsWith('root/places/')) {
      p = p.replace(/^root\/places?\//, 'root/workspace/places/');
    }
    // Fix bare place name (LLM sometimes passes just "p-test-crud")
    if (p.startsWith('p-') && !p.includes('/')) {
      p = `root/workspace/places/${p}`;
    }
    // Fix hallucinated transition paths
    if (p.startsWith('root/transition/') || p.startsWith('root/transitions/')) {
      p = p.replace(/^root\/transitions?\//, 'root/workspace/transitions/');
    }
    // Remove double slashes
    p = p.replace(/\/\/+/g, '/');
    return p;
  }
}
