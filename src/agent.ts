import { LLMProvider, Message, Session, SessionStorage, UsageData } from './types';
import { config, SYSTEM_PROMPT } from './config';

function buildSummaryRequest(existingSummary: string | null, messages: Message[]): string {
  const prevPart = existingSummary
    ? `Previous summary:\n${existingSummary}`
    : 'Previous summary:\nNone';

  const msgPart = messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n\n');

  return `${prevPart}\n\nNew messages to incorporate:\n${msgPart}\n\nWrite a concise summary that preserves all important context, decisions, and facts.`;
}

export class Agent {
  private readonly provider: LLMProvider;
  private history: Message[];
  private summary: string | null = null;
  private summaryEnabled: boolean = config.summaryEnabled;
  private readonly storage?: SessionStorage;
  private readonly session?: Session;

  constructor(provider: LLMProvider, storage?: SessionStorage, session?: Session) {
    this.provider = provider;
    this.storage = storage;
    this.session = session;
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  loadHistory(messages: Message[], summary?: string): void {
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
    this.summary = summary ?? null;
  }

  get totalTokensUsed(): number {
    return this.session?.totalTokensUsed ?? 0;
  }

  private buildPromptMessages(): Message[] {
    const nonSystemCount = this.history.length - 1;
    const tail = nonSystemCount <= config.summaryTail
      ? this.history.slice(1)
      : this.history.slice(-(config.summaryTail));

    const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (this.summary) {
      messages.push({ role: 'system', content: `Earlier conversation summary:\n${this.summary}` });
    }
    return [...messages, ...tail];
  }

  toggleSummary(): boolean {
    this.summaryEnabled = !this.summaryEnabled;
    return this.summaryEnabled;
  }

  get isSummaryEnabled(): boolean {
    return this.summaryEnabled;
  }

  private async maybeSummarize(): Promise<void> {
    if (!this.summaryEnabled) return;
    const nonSystemCount = this.history.length - 1;
    const nonTailCount = nonSystemCount - config.summaryTail;
    if (nonTailCount < config.summaryBatchSize) return;

    const batch = this.history.slice(1, this.history.length - config.summaryTail);
    const summaryMessages: Message[] = [
      { role: 'system', content: 'You are a conversation summarizer. Be concise but preserve all important context, decisions, and facts.' },
      { role: 'user', content: buildSummaryRequest(this.summary, batch) },
    ];

    let newSummary = '';
    await this.provider.streamChat(summaryMessages, (chunk) => { newSummary += chunk; });

    this.summary = newSummary.trim();
    this.history = [this.history[0], ...this.history.slice(-(config.summaryTail))];
  }

  async chat(userInput: string, onChunk: (chunk: string) => void): Promise<UsageData | null> {
    this.history.push({ role: 'user', content: userInput });

    let fullResponse = '';
    const usage = await this.provider.streamChat(this.buildPromptMessages(), (chunk) => {
      fullResponse += chunk;
      onChunk(chunk);
    });

    this.history.push({ role: 'assistant', content: fullResponse });

    await this.maybeSummarize();

    if (this.storage && this.session) {
      if (usage) {
        this.session.totalTokensUsed = (this.session.totalTokensUsed ?? 0) + usage.total_tokens;
      }
      this.session.messages = this.history.slice(1); // drop system message
      this.session.messageCount = this.session.messages.length;
      this.session.lastSavedAt = new Date().toISOString();
      this.session.summary = this.summary ?? undefined;
      await this.storage.saveSession(this.session);
    }

    return usage;
  }
}
