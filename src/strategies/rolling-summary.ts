import { LLMProvider, Message, StrategyState } from '../types';
import { config, SYSTEM_PROMPT } from '../config';
import { ContextStrategy } from './context-strategy';

function buildSummaryRequest(existingSummary: string | null, messages: Message[]): string {
  const prevPart = existingSummary
    ? `Previous summary:\n${existingSummary}`
    : 'Previous summary:\nNone';

  const msgPart = messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n\n');

  return `${prevPart}\n\nNew messages to incorporate:\n${msgPart}\n\nWrite a concise summary that preserves all important context, decisions, and facts.`;
}

export class RollingSummaryStrategy implements ContextStrategy {
  readonly name = 'rolling' as const;
  private summary: string | null = null;

  getSummary(): string | null {
    return this.summary;
  }

  buildPromptMessages(systemPrompt: string, history: Message[]): Message[] {
    const nonSystemCount = history.length;
    const tail = nonSystemCount <= config.summaryTail
      ? history
      : history.slice(-(config.summaryTail));

    const messages: Message[] = [{ role: 'system', content: systemPrompt }];
    if (this.summary) {
      messages.push({ role: 'system', content: `Earlier conversation summary:\n${this.summary}` });
    }
    return [...messages, ...tail];
  }

  async afterTurn(history: Message[], provider: LLMProvider): Promise<Message[]> {
    const nonSystemCount = history.length;
    const nonTailCount = nonSystemCount - config.summaryTail;
    if (nonTailCount < config.summaryBatchSize) return history;

    const batch = history.slice(0, history.length - config.summaryTail);
    const summaryMessages: Message[] = [
      { role: 'system', content: 'You are a conversation summarizer. Be concise but preserve all important context, decisions, and facts.' },
      { role: 'user', content: buildSummaryRequest(this.summary, batch) },
    ];

    let newSummary = '';
    await provider.streamChat(summaryMessages, (chunk) => { newSummary += chunk; });

    this.summary = newSummary.trim();
    return history.slice(-(config.summaryTail));
  }

  serializeState(): StrategyState {
    return { name: 'rolling', summary: this.summary };
  }

  loadState(state: StrategyState): void {
    if (state.name === 'rolling') {
      this.summary = state.summary;
    }
  }

  describe(): string {
    const tail = config.summaryTail;
    const batch = config.summaryBatchSize;
    return `Rolling summary — keep last ${tail} msgs verbatim, summarize batches of ${batch}`;
  }
}
