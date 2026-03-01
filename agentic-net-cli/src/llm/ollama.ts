import { Ollama } from 'ollama';
import type { LlmProvider, LlmMessage, LlmResponse, LlmContent } from './provider.js';
import type { ToolSchema } from '../agent/tools.js';

export class OllamaProvider implements LlmProvider {
  name = 'ollama';
  private client: Ollama;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'llama3.2') {
    this.client = new Ollama({ host: baseUrl });
    this.model = model;
  }

  async chat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: ToolSchema[],
  ): Promise<LlmResponse> {
    // Convert messages to Ollama format
    const ollamaMessages: any[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of messages) {
      const textParts = msg.content
        .filter(c => c.type === 'text')
        .map(c => (c as { type: 'text'; text: string }).text);

      const toolResults = msg.content
        .filter(c => c.type === 'tool_result')
        .map(c => (c as { type: 'tool_result'; tool_use_id: string; content: string }).content);

      const combined = [...textParts, ...toolResults].join('\n');
      if (combined) {
        ollamaMessages.push({ role: msg.role, content: combined });
      }
    }

    // Convert tools to Ollama format
    const ollamaTools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const response = await this.client.chat({
      model: this.model,
      messages: ollamaMessages,
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
    });

    const content: LlmContent[] = [];
    let hasToolUse = false;

    // Process tool calls
    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      for (const toolCall of response.message.tool_calls) {
        hasToolUse = true;
        content.push({
          type: 'tool_use',
          id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: toolCall.function.name,
          input: toolCall.function.arguments as Record<string, any>,
        });
      }
    }

    // Process text content
    if (response.message.content) {
      content.push({ type: 'text', text: response.message.content });
    }

    return {
      content,
      stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    };
  }
}
