/**
 * Abstraction for chat channels (Telegram, Slack, Discord, etc.).
 * Each channel handles I/O; agent logic lives in SessionManager.
 */

export interface ChatChannel {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MessageSender {
  sendText(chatId: string, text: string): Promise<void>;
  sendTypingAction(chatId: string): Promise<void>;
}

export interface ChannelSecurityConfig {
  allowedUserIds: string[];
}
