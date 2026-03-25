export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  role: Role;
  content: string;
}

export interface UsageData {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LLMProvider {
  streamChat(messages: Message[], onChunk: (chunk: string) => void): Promise<UsageData | null>;
}

export interface Session {
  id: string;
  name: string;
  messageCount: number;
  lastSavedAt: string; // ISO 8601
  totalTokensUsed: number;
  messages: Message[]; // excludes system message
}

export interface SessionStorage {
  listSessions(): Promise<Session[]>;
  loadSession(id: string): Promise<Session>;
  saveSession(session: Session): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
