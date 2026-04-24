import type { LlmProvider, LlmMessage, LlmContent } from '../llm/provider.js';
import type { ToolSchema } from './tools.js';
import { ToolExecutor, type ToolResult } from './tool-executor.js';
import type { AgentTool } from './tools.js';

export interface AgentEvent {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'done' | 'fail' | 'error';
  content?: string;
  tool?: string;
  input?: Record<string, any>;
  result?: any;
  /** Final conversation messages (on 'done'/'fail' events). Used for session continuity. */
  messages?: LlmMessage[];
}

const MAX_ITERATIONS = 100;
const MAX_TOOL_CALLS = 100;
const MAX_THINK_CALLS = 6;
const MAX_CONSECUTIVE_SAME_TOOL_CALLS = 3;

interface AgentLoopOptions {
  maxIterations?: number;
  maxToolCalls?: number;
  maxThinkCalls?: number;
  maxConsecutiveSameToolCalls?: number;
}

/**
 * Core agentic loop: think → tool_call → execute → repeat.
 * Yields AgentEvents as an async generator.
 *
 * @param conversationHistory - Prior turns to prepend (for multi-turn chat sessions).
 */
export async function* agentLoop(
  llm: LlmProvider,
  toolExecutor: ToolExecutor,
  systemPrompt: string,
  userMessage: string,
  toolSchemas: ToolSchema[],
  conversationHistory?: LlmMessage[],
  options?: AgentLoopOptions,
): AsyncGenerator<AgentEvent> {
  const maxIterations = options?.maxIterations && options.maxIterations > 0
    ? Math.floor(options.maxIterations)
    : MAX_ITERATIONS;
  const maxToolCalls = options?.maxToolCalls && options.maxToolCalls > 0
    ? Math.floor(options.maxToolCalls)
    : MAX_TOOL_CALLS;
  const maxThinkCalls = options?.maxThinkCalls && options.maxThinkCalls > 0
    ? Math.floor(options.maxThinkCalls)
    : MAX_THINK_CALLS;
  const maxConsecutiveSameToolCalls = options?.maxConsecutiveSameToolCalls && options.maxConsecutiveSameToolCalls > 0
    ? Math.floor(options.maxConsecutiveSameToolCalls)
    : MAX_CONSECUTIVE_SAME_TOOL_CALLS;

  const messages: LlmMessage[] = [
    ...(conversationHistory || []),
    { role: 'user', content: [{ type: 'text', text: userMessage }] },
  ];

  let totalToolCalls = 0;
  let totalThinkCalls = 0;
  let lastToolSignature: string | undefined;
  let repeatedToolCallCount = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Call LLM
    let response;
    try {
      response = await llm.chat(systemPrompt, messages, toolSchemas);
    } catch (err: any) {
      yield { type: 'error', content: `LLM error: ${err.message}`, messages: [...messages] };
      return;
    }

    // Collect tool uses and text from this response
    const toolUses: Array<{ id: string; name: string; input: Record<string, any> }> = [];
    const textParts: string[] = [];

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
        yield { type: 'text', content: block.text };
      }
      if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    // Always add assistant response to message history
    messages.push({ role: 'assistant', content: response.content });

    // If no tool calls and there is meaningful text, we're done.
    // If the response is completely empty (e.g. thinking blocks stripped), retry.
    if (toolUses.length === 0) {
      const finalText = textParts.join('\n').trim();
      if (finalText) {
        yield { type: 'done', content: finalText, messages: [...messages] };
        return;
      }
      // Empty response — retry (model may have only emitted thinking)
      continue;
    }

    // Process tool calls
    const toolResults: LlmContent[] = [];

    for (const toolUse of toolUses) {
      totalToolCalls++;
      if (totalToolCalls > maxToolCalls) {
        yield {
          type: 'error',
          content: `Agent stopped after ${maxToolCalls} tool calls (safety limit).`,
          messages: [...messages],
        };
        return;
      }

      if (toolUse.name === 'THINK') {
        totalThinkCalls++;
        if (totalThinkCalls > maxThinkCalls) {
          yield {
            type: 'error',
            content: `Agent stopped after ${maxThinkCalls} THINK calls (safety limit).`,
            messages: [...messages],
          };
          return;
        }
      }

      const signature = `${toolUse.name}:${JSON.stringify(toolUse.input || {})}`;
      if (signature === lastToolSignature) {
        repeatedToolCallCount++;
      } else {
        lastToolSignature = signature;
        repeatedToolCallCount = 1;
      }

      if (repeatedToolCallCount > maxConsecutiveSameToolCalls) {
        yield {
          type: 'error',
          content: `Agent stopped after repeating the same tool call ${maxConsecutiveSameToolCalls} times.`,
          messages: [...messages],
        };
        return;
      }

      yield { type: 'tool_call', tool: toolUse.name, input: toolUse.input };

      // Check for terminal tools
      if (toolUse.name === 'DONE') {
        yield {
          type: 'done',
          content: toolUse.input.summary || 'Task completed.',
          messages: [...messages],
        };
        return;
      }

      if (toolUse.name === 'FAIL') {
        yield {
          type: 'fail',
          content: toolUse.input.error || 'Task failed.',
          messages: [...messages],
        };
        return;
      }

      // Execute tool
      let result: ToolResult;
      try {
        result = await toolExecutor.execute(toolUse.name as AgentTool, toolUse.input);
      } catch (err: any) {
        result = { success: false, error: err.message };
      }

      yield {
        type: 'tool_result',
        tool: toolUse.name,
        result: result.success ? result.data : { error: result.error },
      };

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result.success ? result.data : { error: result.error }),
      });
    }

    // Add tool results as user message
    messages.push({ role: 'user', content: toolResults });
  }

  yield {
    type: 'error',
    content: `Agent reached maximum iterations (${maxIterations})`,
    messages: [...messages],
  };
}
