import type { ToolSchema } from '../agent/tools.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContent[];
}

export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface LlmResponse {
  content: LlmContent[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: { input_tokens: number; output_tokens: number };
}

export interface LlmProvider {
  name: string;
  chat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: ToolSchema[],
  ): Promise<LlmResponse>;
}
