/**
 * Per-Telegram-chat state — kept in memory only.
 *
 * <p>Master owns the conversation history (it's keyed by {@code conversationId}).
 * The chat container only needs to remember, per Telegram chatId, which
 * conversation is active.</p>
 *
 * <p>Switching {@code persona} or {@code modelId} requires a new conversation
 * because master uses the persona+model pair to build the system prompt and
 * tool set.</p>
 */
export interface ChatState {
  persona: string;
  modelId: string;
  conversationId: string | null;
}

export interface ChatStateDefaults {
  persona: string;
  modelId: string;
}

export class ChatStateStore {
  private readonly states = new Map<string, ChatState>();

  constructor(private readonly defaults: ChatStateDefaults) {}

  /** Get-or-create state for a Telegram chatId. */
  get(chatId: string): ChatState {
    let state = this.states.get(chatId);
    if (!state) {
      state = { ...this.defaults, conversationId: null };
      this.states.set(chatId, state);
    }
    return state;
  }

  /** Replace persona for a chatId. Invalidates the active conversation. */
  setPersona(chatId: string, personaId: string): ChatState {
    const state = this.get(chatId);
    state.persona = personaId;
    state.conversationId = null;
    return state;
  }

  /** Replace model for a chatId. Invalidates the active conversation. */
  setModel(chatId: string, modelId: string): ChatState {
    const state = this.get(chatId);
    state.modelId = modelId;
    state.conversationId = null;
    return state;
  }

  /** Replace the conversation id (called after chat/start). */
  setConversation(chatId: string, conversationId: string): void {
    const state = this.get(chatId);
    state.conversationId = conversationId;
  }

  /** Drop the conversation id so the next message starts a fresh one. */
  clearConversation(chatId: string): void {
    const state = this.get(chatId);
    state.conversationId = null;
  }

  /** Default persona id (used by /context). */
  defaultPersona(): string {
    return this.defaults.persona;
  }

  /** Default modelId (used by /context). */
  defaultModelId(): string {
    return this.defaults.modelId;
  }
}
