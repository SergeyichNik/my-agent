import { LLMProvider, Message, Session, SessionStorage, UsageData } from './types';
import { SYSTEM_PROMPT } from './config';

export class Agent {
  private readonly provider: LLMProvider;
  private history: Message[];
  private readonly storage?: SessionStorage;
  private readonly session?: Session;

  constructor(provider: LLMProvider, storage?: SessionStorage, session?: Session) {
    this.provider = provider;
    this.storage = storage;
    this.session = session;
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  loadHistory(messages: Message[]): void {
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  }

  get totalTokensUsed(): number {
    return this.session?.totalTokensUsed ?? 0;
  }

  async chat(userInput: string, onChunk: (chunk: string) => void): Promise<UsageData | null> {
    this.history.push({ role: 'user', content: userInput });

    let fullResponse = '';
    const usage = await this.provider.streamChat(this.history, (chunk) => {
      fullResponse += chunk;
      onChunk(chunk);
    });

    this.history.push({ role: 'assistant', content: fullResponse });

    if (this.storage && this.session) {
      if (usage) {
        this.session.totalTokensUsed = (this.session.totalTokensUsed ?? 0) + usage.total_tokens;
      }
      this.session.messages = this.history.slice(1); // drop system message
      this.session.messageCount = this.session.messages.length;
      this.session.lastSavedAt = new Date().toISOString();
      await this.storage.saveSession(this.session);
    }

    return usage;
  }
}
