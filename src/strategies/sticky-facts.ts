import { LLMProvider, Message, StrategyState } from '../types';
import { config } from '../config';
import { ContextStrategy } from './context-strategy';

const FACTS_SYSTEM_PROMPT = `You are a structured note-taker. Extract and maintain key facts from a conversation.
Return ONLY the updated facts block using these headings (omit headings with no content):
Goal:
Constraints:
Decisions:
Preferences:
Key Context:`;

function buildFactsRequest(existingFacts: string | null, lastUser: string, lastAssistant: string): string {
  return `Current facts:\n${existingFacts ?? 'None'}\n\nNew messages:\nuser: ${lastUser}\nassistant: ${lastAssistant}\n\nUpdate the facts block.`;
}

export class StickyFactsStrategy implements ContextStrategy {
  readonly name = 'facts' as const;
  private facts: string | null = null;
  private windowSize: number;

  constructor(windowSize?: number) {
    this.windowSize = windowSize ?? config.factsWindowSize;
  }

  getFacts(): string | null {
    return this.facts;
  }

  buildPromptMessages(systemPrompt: string, history: Message[]): Message[] {
    const window = history.slice(-this.windowSize);
    const messages: Message[] = [{ role: 'system', content: systemPrompt }];
    if (this.facts) {
      messages.push({ role: 'system', content: `Key facts from this conversation:\n${this.facts}` });
    }
    return [...messages, ...window];
  }

  async afterTurn(history: Message[], provider: LLMProvider): Promise<Message[]> {
    // Extract facts from the last user+assistant pair
    const len = history.length;
    if (len < 2) return history;

    const lastUser = history[len - 2];
    const lastAssistant = history[len - 1];
    if (lastUser.role !== 'user' || lastAssistant.role !== 'assistant') return history;

    const factMessages: Message[] = [
      { role: 'system', content: FACTS_SYSTEM_PROMPT },
      { role: 'user', content: buildFactsRequest(this.facts, lastUser.content, lastAssistant.content) },
    ];

    let newFacts = '';
    await provider.streamChat(factMessages, (chunk) => { newFacts += chunk; });

    this.facts = newFacts.trim() || this.facts;
    return history; // history is kept in full; window applied at prompt time
  }

  serializeState(): StrategyState {
    return { name: 'facts', facts: this.facts, windowSize: this.windowSize };
  }

  loadState(state: StrategyState): void {
    if (state.name === 'facts') {
      this.facts = state.facts;
      this.windowSize = state.windowSize;
    }
  }

  describe(): string {
    return `Sticky facts — LLM extracts key facts each turn + last ${this.windowSize} messages`;
  }
}
