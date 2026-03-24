export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  role: Role;
  content: string;
}

export interface LLMProvider {
  streamChat(messages: Message[], onChunk: (chunk: string) => void): Promise<void>;
}

export interface Session {
  id: string;
  name: string;
  messageCount: number;
  lastSavedAt: string; // ISO 8601
  messages: Message[]; // excludes system message
}

export interface SessionStorage {
  listSessions(): Promise<Session[]>;
  loadSession(id: string): Promise<Session>;
  saveSession(session: Session): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
