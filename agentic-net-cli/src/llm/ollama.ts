import { Ollama } from 'ollama';
import type { LlmProvider, LlmMessage, LlmResponse, LlmContent } from './provider.js';
import type { ToolSchema } from '../agent/tools.js';

/** Strip <think>...</think> blocks that some models (e.g. qwen3-coder) emit. */
function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

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
      if (msg.role === 'assistant') {
        // Extract tool_use blocks → Ollama tool_calls
        const toolUses = msg.content.filter(c => c.type === 'tool_use') as Array<{
          type: 'tool_use'; id: string; name: string; input: Record<string, any>;
        }>;
        const textParts = msg.content
          .filter(c => c.type === 'text')
          .map(c => (c as { type: 'text'; text: string }).text);

        const textContent = stripThinkingBlocks(textParts.join('\n'));

        if (toolUses.length > 0) {
          ollamaMessages.push({
            role: 'assistant',
            content: textContent || '',
            tool_calls: toolUses.map(tu => ({
              id: tu.id,
              function: { name: tu.name, arguments: tu.input },
            })),
          });
        } else if (textContent) {
          ollamaMessages.push({ role: 'assistant', content: textContent });
        }
      } else if (msg.role === 'user') {
        // Check for tool_result blocks → Ollama role: 'tool'
        const toolResults = msg.content.filter(c => c.type === 'tool_result') as Array<{
          type: 'tool_result'; tool_use_id: string; content: string;
        }>;
        const textParts = msg.content
          .filter(c => c.type === 'text')
          .map(c => (c as { type: 'text'; text: string }).text);

        if (toolResults.length > 0) {
          // Send each tool result as a separate role: 'tool' message
          for (const tr of toolResults) {
            ollamaMessages.push({
              role: 'tool',
              content: tr.content,
            });
          }
        }

        // Send any remaining text as a user message
        const textContent = textParts.join('\n').trim();
        if (textContent) {
          ollamaMessages.push({ role: 'user', content: textContent });
        }
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

    // Process text content — strip <think> blocks
    if (response.message.content) {
      const cleaned = stripThinkingBlocks(response.message.content);
      if (cleaned) {
        content.push({ type: 'text', text: cleaned });
      }
    }

    return {
      content,
      stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    };
  }
}
