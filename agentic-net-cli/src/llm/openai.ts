import OpenAI from 'openai';
import type { LlmProvider, LlmMessage, LlmResponse, LlmContent } from './provider.js';
import type { ToolSchema } from '../agent/tools.js';

export class OpenAIProvider implements LlmProvider {
  name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = 'o4-mini') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: ToolSchema[],
  ): Promise<LlmResponse> {
    // Convert messages to OpenAI format
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === 'user') {
        // Check if this message contains tool_result blocks
        const toolResults = msg.content.filter(c => c.type === 'tool_result');
        const textParts = msg.content.filter(c => c.type === 'text');

        // Emit tool result messages first (OpenAI expects role: 'tool')
        for (const tr of toolResults) {
          if (tr.type === 'tool_result') {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id,
              content: tr.content,
            });
          }
        }

        // Emit text parts as user message
        if (textParts.length > 0) {
          const text = textParts.map(t => t.type === 'text' ? t.text : '').join('\n');
          if (text) {
            openaiMessages.push({ role: 'user', content: text });
          }
        }
      } else if (msg.role === 'assistant') {
        const textParts = msg.content.filter(c => c.type === 'text');
        const toolCalls = msg.content.filter(c => c.type === 'tool_use');

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
        };

        if (textParts.length > 0) {
          assistantMsg.content = textParts.map(t => t.type === 'text' ? t.text : '').join('\n');
        }

        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map(tc => {
            if (tc.type !== 'tool_use') throw new Error('unreachable');
            return {
              id: tc.id.startsWith('call_') ? tc.id : `call_${tc.id}`,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            };
          });
        }

        openaiMessages.push(assistantMsg);
      }
    }

    // Convert tools to OpenAI format
    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as Record<string, unknown>,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    });

    const choice = response.choices[0];
    const content: LlmContent[] = [];
    let hasToolUse = false;

    // Process tool calls
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      for (const tc of choice.message.tool_calls) {
        hasToolUse = true;
        // Strip 'call_' prefix to normalize IDs
        const id = tc.id.startsWith('call_') ? tc.id.slice(5) : tc.id;
        content.push({
          type: 'tool_use',
          id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    // Process text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    return {
      content,
      stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
      usage: response.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens ?? 0,
      } : undefined,
    };
  }
}
