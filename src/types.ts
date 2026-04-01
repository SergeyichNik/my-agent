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

export type TaskStage = 'idle' | 'planning' | 'execution' | 'validation' | 'done' | 'paused';

export interface WorkingMemory {
  goal: string;
  steps: string[];
  constraints: string[];
  entities: string[];
  // Task State Machine
  stage: TaskStage;
  currentStep: string;
  expectedAction: string;
  taskData: Record<string, unknown>;
}

export interface LTMEntry {
  id: string;
  content: string;
  addedAt: string; // ISO 8601
  source: string;  // session id or 'bench'
}

export interface UserProfile {
  userId: string;
  updatedAt: string;
  preferences: {
    style: 'brief' | 'detailed' | null;
    tone: 'formal' | 'casual' | null;
    verbosity: 'low' | 'medium' | 'high' | null;
  };
  format: {
    codeStyle: 'commented' | 'clean' | null;
    responseStructure: 'markdown' | 'plain' | null;
  };
  constraints: {
    preferredLanguage: string | null;
    doNot: string[];
    must: string[];
  };
}

export type StrategyState =
  | { name: 'rolling'; summary: string | null }
  | { name: 'window';  windowSize: number }
  | { name: 'facts';   facts: string | null; windowSize: number }
  | { name: 'branch';  activeBranch: string; branches: Record<string, BranchData> }
  | { name: 'memory';  workingMemory: WorkingMemory; windowSize: number };

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
