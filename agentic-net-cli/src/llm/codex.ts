import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmProvider, LlmMessage, LlmResponse, LlmContent } from './provider.js';
import type { ToolSchema } from '../agent/tools.js';

const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_PROMPT_CHARS = 80_000;

/**
 * Codex CLI provider.
 * Delegates to `codex` CLI as a subprocess.
 * Uses the same <tool_call> protocol as Claude Code provider.
 */
export class CodexProvider implements LlmProvider {
  name = 'codex';

  constructor(
    private binary: string = 'codex',
    private model: string = 'o3',
  ) {}

  async chat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: ToolSchema[],
  ): Promise<LlmResponse> {
    const fullSystem = this.buildSystemWithTools(systemPrompt, tools);
    const historyPrompt = this.formatMessages(messages);
    const fullPrompt = `${fullSystem}\n\n---\n\nConversation:\n${historyPrompt}`;
    const output = await this.runCodex(fullPrompt);
    const parsed = this.parseResponse(output);

    if (this.shouldRetryForToolCall(parsed, tools)) {
      const retryPrompt = `${fullPrompt}

[RETRY REQUIREMENT]
Your previous response was invalid because it did not include a AgetnticOS <tool_call>.
AgetnticOS tools are available in this interface.
Respond now with EXACTLY one valid <tool_call>...</tool_call> block and no extra text.`;
      const retryOutput = await this.runCodex(retryPrompt);
      const retryParsed = this.parseResponse(retryOutput);
      if (this.hasToolUse(retryParsed)) {
        return retryParsed;
      }
    }

    return parsed;
  }

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

You have access to AgetnticOS tools. When you need to use a tool, output EXACTLY this format:

<tool_call>
{"name": "TOOL_NAME", "input": {"param1": "value1"}}
</tool_call>

CRITICAL RULES:
- Output ONE tool call per response, then STOP immediately
- Wait for the tool result before making another call
- After getting results, analyze them and decide next steps
- When your task is complete, call the DONE tool
- If you cannot proceed, call the FAIL tool
- NEVER run shell/terminal commands; this interface only accepts <tool_call> blocks
- ALWAYS use the <tool_call> XML tags — do NOT use any other format

## Available Tools

${toolDocs}`;
  }

  private formatMessages(messages: LlmMessage[]): string {
    const idToName: Record<string, string> = {};
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          idToName[block.id] = block.name;
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
                '\n...[truncated - use EXTRACT_TOKEN_CONTENT for full content]';
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
    if (prompt.length > MAX_PROMPT_CHARS) {
      prompt = prompt.slice(-MAX_PROMPT_CHARS);
      prompt = '[...earlier context truncated...]\n\n' + prompt;
    }
    return prompt;
  }

  private parseResponse(text: string): LlmResponse {
    const content: LlmContent[] = [];
    const matches = [...text.matchAll(TOOL_CALL_REGEX)];

    if (matches.length > 0) {
      const firstMatch = matches[0];
      const textBefore = text.slice(0, firstMatch.index).trim();
      if (textBefore) {
        content.push({ type: 'text', text: textBefore });
      }

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
      } catch {
        return {
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
        };
      }
    }

    content.push({ type: 'text', text });
    return { content, stop_reason: 'end_turn' };
  }

  private hasToolUse(response: LlmResponse): boolean {
    return response.content.some(block => block.type === 'tool_use');
  }

  private shouldRetryForToolCall(response: LlmResponse, tools: ToolSchema[]): boolean {
    if (tools.length === 0 || this.hasToolUse(response)) {
      return false;
    }
    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .toLowerCase();
    return (
      text.includes('not able') ||
      text.includes('unable') ||
      text.includes('can’t') ||
      text.includes("can't") ||
      text.includes('not available') ||
      text.includes('not reachable') ||
      text.includes('environment')
    );
  }

  private runCodex(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const outputFile = join(
        tmpdir(),
        `agenticos-codex-last-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
      );
      const args = [
        'exec',
        '--model', this.model,
        '--skip-git-repo-check',
        '--ephemeral',
        '--color', 'never',
        '--disable', 'shell_tool',
        '--output-last-message', outputFile,
        '-c', `model_reasoning_effort="${this.reasoningEffortForModel()}"`,
        prompt,
      ];
      const proc = spawn(this.binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      proc.stdin.end();

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('codex timed out after 5 minutes'));
      }, 300_000);

      proc.on('close', (code) => {
        const finish = async () => {
          clearTimeout(timer);
          if (code === 0) {
            try {
              const last = (await readFile(outputFile, 'utf-8')).trim();
              resolve(last || stdout.trim());
            } catch {
              resolve(stdout.trim());
            } finally {
              await rm(outputFile, { force: true }).catch(() => undefined);
            }
            return;
          }

          const detail = stderr.trim() || stdout.trim().slice(-500);
          await rm(outputFile, { force: true }).catch(() => undefined);
          reject(new Error(`codex exited with code ${code}: ${detail}`));
        };
        void finish();
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn codex: ${err.message}`));
      });
    });
  }

  private reasoningEffortForModel(): string {
    return this.model.toLowerCase().includes('mini') ? 'medium' : 'xhigh';
  }
}
