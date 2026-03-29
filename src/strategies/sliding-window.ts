import { LLMProvider, Message, StrategyState } from '../types';
import { config } from '../config';
import { ContextStrategy } from './context-strategy';

export class SlidingWindowStrategy implements ContextStrategy {
  readonly name = 'window' as const;
  private windowSize: number;

  constructor(windowSize?: number) {
    this.windowSize = windowSize ?? config.windowSize;
  }

  buildPromptMessages(systemPrompt: string, history: Message[]): Message[] {
    const window = history.slice(-this.windowSize);
    return [{ role: 'system', content: systemPrompt }, ...window];
  }

  async afterTurn(history: Message[], _provider: LLMProvider): Promise<Message[]> {
    // Full history kept in memory; window applied only at prompt-build time.
    // This allows lossless strategy switching mid-session.
    return history;
  }

  serializeState(): StrategyState {
    return { name: 'window', windowSize: this.windowSize };
  }

  loadState(state: StrategyState): void {
    if (state.name === 'window') {
      this.windowSize = state.windowSize;
    }
  }

  describe(): string {
    return `Sliding window — last ${this.windowSize} messages sent, rest discarded`;
  }

  getWindowSize(): number {
    return this.windowSize;
  }

  setWindowSize(n: number): void {
    this.windowSize = n;
  }
}
