import type { LlmMessage, LlmProvider, LlmResponse } from './provider.js';
import type { ToolSchema } from '../agent/tools.js';

/**
 * Routes between a "worker" and "thinker" model.
 * - thinker: post-THINK reasoning only
 * - worker: normal tool-driving loop
 */
export class RoutedLlmProvider implements LlmProvider {
  name = 'routed';

  constructor(
    private worker: LlmProvider,
    private thinker: LlmProvider,
  ) {
    this.name = `routed(${worker.name}|${thinker.name})`;
  }

  async chat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: ToolSchema[],
  ): Promise<LlmResponse> {
    const provider = this.shouldUseThinker(messages) ? this.thinker : this.worker;
    return provider.chat(systemPrompt, messages, tools);
  }

  private shouldUseThinker(messages: LlmMessage[]): boolean {
    const toolNameById = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolNameById.set(block.id, String(block.name || ''));
        }
      }
    }

    let sawToolResult = false;
    let lastToolResultName: string | null = null;
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        sawToolResult = true;
        lastToolResultName = toolNameById.get(block.tool_use_id) ?? null;
      }
    }

    if (!sawToolResult) {
      // No explicit THINK checkpoint yet; stay on the cheaper worker model.
      return false;
    }

    return lastToolResultName === 'THINK';
  }
}
