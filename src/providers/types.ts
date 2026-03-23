export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  role: Role;
  content: string;
}

export interface LLMProvider {
  streamChat(messages: Message[], onChunk: (chunk: string) => void): Promise<void>;
}
