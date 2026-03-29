import { spawn } from 'node:child_process';
import type { LlmProvider, LlmMessage, LlmResponse, LlmContent } from './provider.js';
import type { ToolSchema } from '../agent/tools.js';

const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/** Max chars per tool result in conversation history to avoid "Prompt is too long" from claude -p. */
const MAX_TOOL_RESULT_CHARS = 8_000;
/** Max total user prompt chars piped to stdin. */
const MAX_USER_PROMPT_CHARS = 80_000;

/**
 * Claude Code CLI provider.
 * Spawns `claude -p` for each iteration.
 * Embeds AgenticNetOS tool definitions in the system prompt and parses
 * structured <tool_call> blocks from the text response.
 */
export class ClaudeCodeProvider implements LlmProvider {
  name = 'claude-code';

  constructor(
    private binary: string = 'claude',
    private model: string = 'sonnet',
  ) {}

  async chat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: ToolSchema[],
  ): Promise<LlmResponse> {
    // Build combined system prompt with tool definitions
    const fullSystem = this.buildSystemWithTools(systemPrompt, tools);

    // Build user prompt from message history
    const userPrompt = this.formatMessages(messages);

    // Call claude CLI
    const rawOutput = await this.runClaude(fullSystem, userPrompt);

    // Parse tool calls from the response
    return this.parseResponse(rawOutput);
  }

  /**
   * Embed AgenticNetOS tool definitions and tool-call protocol into the system prompt.
   */
  private buildSystemWithTools(systemPrompt: string, tools: ToolSchema[]): string {
    if (tools.length === 0) return systemPrompt;

    const toolDocs = tools.map(t => {
      const props = Object.entries(t.input_schema.properties);
      const params = props.length > 0
        ? props.map(([name, schema]: [string, any]) => {
            const req = t.input_schema.required.includes(name) ? ' (required)' : '';
            return `    - ${name}${req}: ${schema.description || schema.type}`;
          }).join('\n')
        : '    (no parameters)';
      return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
    }).join('\n\n');

    return `${systemPrompt}

## Tool Use Protocol

You have access to AgenticNetOS tools. When you need to use a tool, output EXACTLY this format:

<tool_call>
{"name": "TOOL_NAME", "input": {"param1": "value1"}}
</tool_call>

CRITICAL RULES:
- Output ONE tool call per response, then STOP immediately
- Wait for the tool result before making another call
- After getting results, analyze them and decide next steps
- When your task is complete, call the DONE tool
- If you cannot proceed, call the FAIL tool
- ALWAYS use the <tool_call> XML tags — do NOT use any other format

## Available Tools

${toolDocs}`;
  }

  /**
   * Format the LLM message history into a single text prompt for claude -p.
   */
  private formatMessages(messages: LlmMessage[]): string {
    // Build a mapping from tool_use IDs to tool names
    const idToName: Record<string, string> = {};
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            idToName[block.id] = block.name;
          }
        }
      }
    }

    const parts: string[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push(block.text);
          }
          if (block.type === 'tool_result') {
            const toolName = idToName[block.tool_use_id] || block.tool_use_id;
            let content = block.content ?? '';
            if (content.length > MAX_TOOL_RESULT_CHARS) {
              content = content.slice(0, MAX_TOOL_RESULT_CHARS) +
                '\n...[truncated — use EXTRACT_TOKEN_CONTENT for full content]';
            }
            parts.push(`[Tool result for ${toolName}]:\n${content}`);
          }
        }
      } else if (msg.role === 'assistant') {
        const assistantParts: string[] = [];
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            assistantParts.push(block.text);
          }
          if (block.type === 'tool_use') {
            assistantParts.push(`<tool_call>\n{"name": "${block.name}", "input": ${JSON.stringify(block.input)}}\n</tool_call>`);
          }
        }
        if (assistantParts.length > 0) {
          parts.push(`[Assistant previous response]:\n${assistantParts.join('\n')}`);
        }
      }
    }

    let prompt = parts.join('\n\n');

    // Cap total prompt size to prevent "Prompt is too long" from claude -p
    if (prompt.length > MAX_USER_PROMPT_CHARS) {
      prompt = prompt.slice(-MAX_USER_PROMPT_CHARS);
      prompt = '[...earlier context truncated...]\n\n' + prompt;
    }

    return prompt;
  }

  /**
   * Parse the claude CLI text response for <tool_call> blocks.
   * Returns proper LlmContent with tool_use blocks if found.
   */
  private parseResponse(text: string): LlmResponse {
    const content: LlmContent[] = [];

    // Find tool calls
    const matches = [...text.matchAll(TOOL_CALL_REGEX)];

    if (matches.length > 0) {
      // Extract text before first tool call
      const firstMatch = matches[0];
      const textBefore = text.slice(0, firstMatch.index).trim();
      if (textBefore) {
        content.push({ type: 'text', text: textBefore });
      }

      // Parse the first tool call (one per response)
      try {
        const jsonStr = matches[0][1].trim();
        const toolCall = JSON.parse(jsonStr);
        const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        content.push({
          type: 'tool_use',
          id,
          name: toolCall.name,
          input: toolCall.input || {},
        });

        return { content, stop_reason: 'tool_use' };
      } catch (err: any) {
        // JSON parse failed — treat entire response as text
        console.error(`[claude-code] Failed to parse tool_call JSON: ${err.message}`);
        return {
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
        };
      }
    }

    // No tool calls found — pure text response
    content.push({ type: 'text', text });
    return { content, stop_reason: 'end_turn' };
  }

  /**
   * Spawn `claude -p` with system prompt and user prompt.
   * The user prompt (conversation history) is piped via stdin to avoid
   * E2BIG errors when the history contains large tool results.
   * The system prompt stays as a CLI arg (it's small — just tool docs).
   */
  private runClaude(systemPrompt: string, userPrompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-p',
        '--model', this.model,
        '--output-format', 'text',
        '--no-session-persistence',
        '--system-prompt', systemPrompt,
        '--tools', '',
      ];

      const proc = spawn(this.binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // Pipe user prompt via stdin to avoid OS argument size limits
      proc.stdin.write(userPrompt);
      proc.stdin.end();

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Timeout after 5 minutes
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('claude-code timed out after 5 minutes'));
      }, 300_000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          const detail = stderr.trim() || stdout.trim().slice(-500);
          reject(new Error(`claude-code exited with code ${code}: ${detail.slice(0, 2000)}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn claude-code: ${err.message}`));
      });
    });
  }
}
