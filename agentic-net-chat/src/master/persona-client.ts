import { GatewayClient } from '@agenticos/cli/gateway/client';

/**
 * Event types emitted by master's /api/assistant/p/.../agent-stream SSE endpoint.
 * Mirrors {@code com.sailer.agenticos.agenticnetmaster.service.dto.AgentEvent}
 * on master — keep the shape in sync.
 */
export type AgentEvent =
  | { type: 'thinking'; reasoning?: string }
  | { type: 'tool_call'; toolName?: string; params?: Record<string, unknown> }
  | { type: 'tool_result'; toolName?: string; result?: unknown; durationMs?: number }
  | { type: 'text'; text: string }
  | { type: 'completion'; summary?: string; success?: boolean; toolCallCount?: number; iterationCount?: number }
  | { type: 'error'; message?: string; error?: string };

export interface PersonaSummary {
  id: string;
  displayName: string;
  description: string;
  role: string;
  toolCount: number;
  triggerMode: string;
}

export interface ChatStartResponse {
  conversationId: string;
  personaId: string;
  personaName: string;
  modelId: string;
  sessionId?: string | null;
  greeting?: string;
  domainBootstrap?: 'created' | 'existing' | 'failed_partial';
}

/**
 * Thin client over master's persona endpoints, talking through the gateway.
 *
 * <p>The chat container is a Telegram-to-SSE adapter — it doesn't run an
 * agent loop locally. Master is the agent runtime. This client just:</p>
 *
 * <ol>
 *   <li>Lists personas (for {@code /persona} command auto-complete).</li>
 *   <li>Starts a new conversation (POST chat/start).</li>
 *   <li>Streams agent events (SSE) so the Telegram channel can relay text and
 *       — optionally — surface tool-call breadcrumbs as breadcrumbs to the user.</li>
 * </ol>
 *
 * <p>SSE is consumed directly via {@code fetch().body.getReader()} because the
 * existing {@link GatewayClient#masterApi} method only does request/response JSON.</p>
 */
export class PersonaClient {
  constructor(private readonly gateway: GatewayClient) {}

  /** GET /api/assistant/p/personas */
  async listPersonas(): Promise<PersonaSummary[]> {
    return this.gateway.masterApi<PersonaSummary[]>('GET', '/assistant/p/personas');
  }

  /** POST /api/assistant/p/{persona}/{model}/chat/start */
  async startChat(personaId: string, modelId: string, sessionId?: string): Promise<ChatStartResponse> {
    const query = sessionId ? { sessionId } : undefined;
    return this.gateway.masterApi<ChatStartResponse>(
      'POST',
      `/assistant/p/${encodeURIComponent(personaId)}/${encodeURIComponent(modelId)}/chat/start`,
      {},
      query,
    );
  }

  /**
   * POST /api/assistant/p/{persona}/{model}/chat/{conversationId}/agent-stream
   * Returns an async iterator of parsed {@link AgentEvent}s.
   *
   * <p>SSE format: {@code event: <type>\ndata: <json>\n\n}. We only care about
   * the data line — type is also encoded in the JSON payload's {@code type} field.</p>
   */
  async *streamAgent(
    personaId: string,
    modelId: string,
    conversationId: string,
    message: string,
  ): AsyncIterable<AgentEvent> {
    const accessToken = await this.gateway.getAccessToken();
    const url =
      `${this.gateway.getGatewayUrl()}/api/assistant/p/` +
      `${encodeURIComponent(personaId)}/${encodeURIComponent(modelId)}/chat/` +
      `${encodeURIComponent(conversationId)}/agent-stream`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`agent-stream HTTP ${res.status}: ${body}`);
    }
    if (!res.body) {
      throw new Error('agent-stream returned no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        // An event may have multiple lines: "event: foo", "data: ...", "id: ...".
        // We only need the data line(s) — concatenate them.
        const dataLines = rawEvent
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;

        const data = dataLines.join('\n');
        try {
          yield JSON.parse(data) as AgentEvent;
        } catch {
          // Heartbeat / empty data — skip silently
        }
      }
    }
  }
}
