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

export interface BranchData {
  messages: Message[];
  createdAt: string; // ISO 8601
}

export type StrategyState =
  | { name: 'rolling'; summary: string | null }
  | { name: 'window';  windowSize: number }
  | { name: 'facts';   facts: string | null; windowSize: number }
  | { name: 'branch';  activeBranch: string; branches: Record<string, BranchData> };

export interface Session {
  id: string;
  name: string;
  messageCount: number;
  lastSavedAt: string; // ISO 8601
  totalTokensUsed: number;
  messages: Message[];      // excludes system message
  summary?: string;         // legacy: rolling summary (kept for backward compat)
  strategyState?: StrategyState;
}

export interface SessionStorage {
  listSessions(): Promise<Session[]>;
  loadSession(id: string): Promise<Session>;
  saveSession(session: Session): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
