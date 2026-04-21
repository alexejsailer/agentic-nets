import type { LlmProvider } from '../llm/provider.js';
import type { ProfileConfig, ModelTier } from '../config/config.js';
import { resolveModelForTier } from '../config/config.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { OpenAIProvider } from '../llm/openai.js';
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

  const helperModel = resolveModelForTier('low', profile.anthropic, 'claude-haiku-4-5-20251001');
  return new AnthropicProvider(apiKey, helperModel);
}

export function createLlmProvider(name: string, profile: ProfileConfig, tier?: ModelTier): LlmProvider {
  const effectiveTier = tier ?? profile.default_tier ?? 'medium';

  switch (name) {
    case 'claude':
    case 'anthropic': {
      const apiKey = profile.anthropic?.api_key;
      if (!apiKey) {
        throw new Error(
          'Anthropic API key not configured. Set ANTHROPIC_API_KEY or configure in ~/.agenticos/config.yaml',
        );
      }
      const workerModel = resolveModelForTier(effectiveTier, profile.anthropic, 'claude-sonnet-4-6');
      const worker = new AnthropicProvider(apiKey, workerModel);

      // When not on high tier, route to high model for thinking
      if (effectiveTier !== 'high') {
        const highModel = resolveModelForTier('high', profile.anthropic, workerModel);
        if (highModel && highModel !== workerModel) {
          const thinker = new AnthropicProvider(apiKey, highModel);
          return new RoutedLlmProvider(worker, thinker);
        }
      }
      return worker;
    }
    case 'openai': {
      const apiKey = profile.openai?.api_key;
      if (!apiKey) {
        throw new Error(
          'OpenAI API key not configured. Set OPENAI_API_KEY or configure in ~/.agenticos/config.yaml',
        );
      }
      const model = resolveModelForTier(effectiveTier, profile.openai, 'gpt-5.4-mini');
      return new OpenAIProvider(apiKey, model);
    }
    case 'ollama': {
      const model = resolveModelForTier(effectiveTier, profile.ollama, 'kimi-k2.5:cloud');
      return new OllamaProvider(
        profile.ollama?.base_url || 'http://localhost:11434',
        model,
      );
    }
    case 'claude-code': {
      const binary = profile.claude_code?.binary || 'claude';
      const workerModel = resolveModelForTier(effectiveTier, profile.claude_code, 'sonnet');
      const worker = new ClaudeCodeProvider(binary, workerModel);

      if (effectiveTier !== 'high') {
        const highModel = resolveModelForTier('high', profile.claude_code, workerModel);
        if (highModel && highModel !== workerModel) {
          const thinker = new ClaudeCodeProvider(binary, highModel);
          return new RoutedLlmProvider(worker, thinker);
        }
      }
      return worker;
    }
    case 'codex': {
      const binary = profile.codex?.binary || 'codex';
      const workerModel = resolveModelForTier(effectiveTier, profile.codex, 'gpt-5.2-codex');
      const worker = new CodexProvider(binary, workerModel);

      if (effectiveTier !== 'high') {
        const highModel = resolveModelForTier('high', profile.codex, workerModel);
        if (highModel && highModel !== workerModel) {
          const thinker = new CodexProvider(binary, highModel);
          return new RoutedLlmProvider(worker, thinker);
        }
      }
      return worker;
    }
    default:
      throw new Error(
        `Unknown LLM provider: '${name}'. Supported: claude, openai, ollama, claude-code, codex`,
      );
  }
}
