import { LLMProvider, Message, StrategyState } from '../types';

export type StrategyName = 'rolling' | 'window' | 'facts' | 'branch' | 'memory';

export interface ContextStrategy {
  readonly name: StrategyName;

  /**
   * Build the message array sent to the LLM.
   * @param systemPrompt - the system prompt string
   * @param history - conversation history WITHOUT the system message
   */
  buildPromptMessages(systemPrompt: string, history: Message[]): Message[];

  /**
   * Optional async preparation before buildPromptMessages.
   * Allows strategies to do async work (e.g. LTM retrieval) before building the prompt.
   * @param history - conversation history WITHOUT the system message
   * @param provider - the LLM provider for side-effect calls
   */
  prepareContext?(history: Message[], provider: LLMProvider): Promise<void>;

  /**
   * Called after each completed user+assistant turn.
   * May perform LLM side-effects (summarization, fact extraction).
   * Returns the history to persist (may be trimmed).
   * @param history - conversation history WITHOUT the system message
   * @param provider - the LLM provider for side-effect calls
   */
  afterTurn(history: Message[], provider: LLMProvider): Promise<Message[]>;

  /** Serialize strategy state for session persistence. */
  serializeState(): StrategyState;

  /** Restore strategy state from a persisted session. */
  loadState(state: StrategyState): void;

  /** Human-readable description for /ctx display. */
  describe(): string;
}
