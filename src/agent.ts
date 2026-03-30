import { LLMProvider, Message, Session, SessionStorage, StrategyState, UsageData } from './types';
import { config, SYSTEM_PROMPT } from './config';
import {
  ContextStrategy,
  StrategyName,
  RollingSummaryStrategy,
  SlidingWindowStrategy,
  BranchingStrategy,
  BranchListEntry,
  createStrategy,
  createStrategyFromState,
} from './strategies';

export class Agent {
  private readonly provider: LLMProvider;
  private history: Message[]; // history[0] is always the system message
  private strategy: ContextStrategy;
  private readonly storage?: SessionStorage;
  private readonly session?: Session;

  constructor(provider: LLMProvider, storage?: SessionStorage, session?: Session) {
    this.provider = provider;
    this.storage = storage;
    this.session = session;
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.strategy = new RollingSummaryStrategy();
  }

  loadHistory(messages: Message[], summary?: string): void {
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
    // Restore legacy rolling summary state
    if (summary && this.strategy.name === 'rolling') {
      this.strategy.loadState({ name: 'rolling', summary });
    }
  }

  setStrategyFromSession(state: StrategyState): void {
    this.strategy = createStrategyFromState(state);
    // For branching, ensure history is synced into branch state
    if (this.strategy.name === 'branch') {
      (this.strategy as BranchingStrategy).initFromHistory(this.history.slice(1));
    }
  }

  setStrategy(name: StrategyName, opts?: { windowSize?: number; sessionId?: string }): void {
    const currentHistory = this.history.slice(1); // without system message
    this.strategy = createStrategy(name, opts);
    // For branching: snapshot current history as 'main' branch
    if (name === 'branch') {
      (this.strategy as BranchingStrategy).initFromHistory(currentHistory);
    }
  }

  get activeStrategy(): StrategyName {
    return this.strategy.name;
  }

  get activeStrategyDescription(): string {
    return this.strategy.describe();
  }

  get totalTokensUsed(): number {
    return this.session?.totalTokensUsed ?? 0;
  }

  get messages(): Message[] {
    return this.history.slice(1); // without system message
  }

  get strategyState(): StrategyState {
    return this.strategy.serializeState();
  }

  // ── Branching facade ────────────────────────────────────────────────────────

  branchSave(name: string): void {
    if (this.strategy.name !== 'branch') {
      throw new Error('Branch operations require branch strategy. Switch with /ctx branch first.');
    }
    (this.strategy as BranchingStrategy).save(name, this.history.slice(1));
  }

  branchList(): BranchListEntry[] {
    if (this.strategy.name !== 'branch') {
      throw new Error('Branch operations require branch strategy. Switch with /ctx branch first.');
    }
    return (this.strategy as BranchingStrategy).list();
  }

  branchLoad(name: string): void {
    if (this.strategy.name !== 'branch') {
      throw new Error('Branch operations require branch strategy. Switch with /ctx branch first.');
    }
    const messages = (this.strategy as BranchingStrategy).load(name);
    if (!messages) throw new Error(`Branch "${name}" not found.`);
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  }

  // ── Backward compat (used by bench/run.ts) ──────────────────────────────────

  toggleSummary(): boolean {
    if (this.strategy.name === 'rolling') {
      this.setStrategy('window');
      return false;
    } else {
      const currentHistory = this.history.slice(1);
      this.strategy = new RollingSummaryStrategy();
      // Restore any existing summary from session
      if (this.session?.summary) {
        this.strategy.loadState({ name: 'rolling', summary: this.session.summary });
      }
      return true;
    }
  }

  get isSummaryEnabled(): boolean {
    return this.strategy.name === 'rolling';
  }

  get hasSummary(): boolean {
    return this.strategy.name === 'rolling' &&
      (this.strategy as RollingSummaryStrategy).getSummary() !== null;
  }

  // ── Core chat ───────────────────────────────────────────────────────────────

  async chat(userInput: string, onChunk: (chunk: string) => void): Promise<UsageData | null> {
    this.history.push({ role: 'user', content: userInput });

    const historyWithoutSystem = this.history.slice(1);
    if (this.strategy.prepareContext) {
      await this.strategy.prepareContext(historyWithoutSystem, this.provider);
    }
    const promptMessages = this.strategy.buildPromptMessages(SYSTEM_PROMPT, historyWithoutSystem);

    let fullResponse = '';
    const usage = await this.provider.streamChat(promptMessages, (chunk) => {
      fullResponse += chunk;
      onChunk(chunk);
    });

    this.history.push({ role: 'assistant', content: fullResponse });

    // Strategy post-processing (summarize / extract facts / update branch snapshot)
    const updatedHistory = await this.strategy.afterTurn(this.history.slice(1), this.provider);
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }, ...updatedHistory];

    if (this.storage && this.session) {
      if (usage) {
        this.session.totalTokensUsed = (this.session.totalTokensUsed ?? 0) + usage.total_tokens;
      }
      this.session.messages = this.history.slice(1);
      this.session.messageCount = this.session.messages.length;
      this.session.lastSavedAt = new Date().toISOString();
      this.session.strategyState = this.strategy.serializeState();
      // Keep legacy field in sync for rolling strategy
      if (this.strategy.name === 'rolling') {
        this.session.summary = (this.strategy as RollingSummaryStrategy).getSummary() ?? undefined;
      }
      await this.storage.saveSession(this.session);
    }

    return usage;
  }
}
