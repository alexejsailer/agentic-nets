import type { LlmProvider } from '../llm/provider.js';
import type { ProfileConfig } from '../config/config.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { OllamaProvider } from '../llm/ollama.js';
import { ClaudeCodeProvider } from '../llm/claude-code.js';
import { CodexProvider } from '../llm/codex.js';
import { RoutedLlmProvider } from '../llm/routed.js';

/**
 * Create a helper LLM provider for summarization tasks (e.g. Haiku).
 * Returns undefined if no API key is configured.
 */
export function createHelperLlm(profile: ProfileConfig): LlmProvider | undefined {
  const apiKey = profile.anthropic?.api_key;
  if (!apiKey) return undefined;

  const helperModel = profile.anthropic?.helper_model || profile.anthropic?.model || 'claude-haiku-4-5-20251001';
  return new AnthropicProvider(apiKey, helperModel);
}

export function createLlmProvider(name: string, profile: ProfileConfig): LlmProvider {
  switch (name) {
    case 'claude':
    case 'anthropic': {
      const apiKey = profile.anthropic?.api_key;
      if (!apiKey) {
        throw new Error(
          'Anthropic API key not configured. Set ANTHROPIC_API_KEY or configure in ~/.agenticos/config.yaml',
        );
      }
      const workerModel = profile.anthropic?.model;
      const thinkingModel = profile.anthropic?.thinking_model;
      const worker = new AnthropicProvider(apiKey, workerModel);
      if (thinkingModel && thinkingModel !== workerModel) {
        const thinker = new AnthropicProvider(apiKey, thinkingModel);
        return new RoutedLlmProvider(worker, thinker);
      }
      return worker;
    }
    case 'ollama': {
      return new OllamaProvider(
        profile.ollama?.base_url || 'http://localhost:11434',
        profile.ollama?.model || 'llama3.2',
      );
    }
    case 'claude-code': {
      const binary = profile.claude_code?.binary || 'claude';
      const workerModel = profile.claude_code?.model || 'sonnet';
      const thinkingModel = profile.claude_code?.thinking_model;
      const worker = new ClaudeCodeProvider(binary, workerModel);
      if (thinkingModel && thinkingModel !== workerModel) {
        const thinker = new ClaudeCodeProvider(binary, thinkingModel);
        return new RoutedLlmProvider(worker, thinker);
      }
      return worker;
    }
    case 'codex': {
      const binary = profile.codex?.binary || 'codex';
      const workerModel = profile.codex?.model || 'o3';
      const thinkingModel = profile.codex?.thinking_model;
      const worker = new CodexProvider(binary, workerModel);
      if (thinkingModel && thinkingModel !== workerModel) {
        const thinker = new CodexProvider(binary, thinkingModel);
        return new RoutedLlmProvider(worker, thinker);
      }
      return worker;
    }
    default:
      throw new Error(
        `Unknown LLM provider: '${name}'. Supported: claude, ollama, claude-code, codex`,
      );
  }
}
