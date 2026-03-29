import { BranchData, LLMProvider, Message, StrategyState } from '../types';
import { ContextStrategy } from './context-strategy';

export interface BranchListEntry {
  name: string;
  messageCount: number;
  createdAt: string;
}

export class BranchingStrategy implements ContextStrategy {
  readonly name = 'branch' as const;
  private activeBranch: string = 'main';
  private branches: Map<string, BranchData> = new Map();

  /** Initialize with current history as the 'main' branch. */
  initFromHistory(history: Message[]): void {
    if (!this.branches.has('main')) {
      this.branches.set('main', {
        messages: [...history],
        createdAt: new Date().toISOString(),
      });
    }
    this.activeBranch = 'main';
  }

  buildPromptMessages(systemPrompt: string, history: Message[]): Message[] {
    return [{ role: 'system', content: systemPrompt }, ...history];
  }

  async afterTurn(history: Message[], _provider: LLMProvider): Promise<Message[]> {
    // Sync active branch snapshot after each turn
    const existing = this.branches.get(this.activeBranch);
    this.branches.set(this.activeBranch, {
      messages: [...history],
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    return history;
  }

  /** Save current history as a named branch (or overwrite). */
  save(name: string, history: Message[]): void {
    this.branches.set(name, {
      messages: [...history],
      createdAt: new Date().toISOString(),
    });
    this.activeBranch = name;
  }

  /** List all branches. */
  list(): BranchListEntry[] {
    const entries: BranchListEntry[] = [];
    for (const [name, data] of this.branches) {
      entries.push({ name, messageCount: data.messages.length, createdAt: data.createdAt });
    }
    return entries;
  }

  /**
   * Load a branch. Returns the branch's messages, or null if not found.
   */
  load(name: string): Message[] | null {
    const branch = this.branches.get(name);
    if (!branch) return null;
    this.activeBranch = name;
    return [...branch.messages];
  }

  getActiveBranch(): string {
    return this.activeBranch;
  }

  serializeState(): StrategyState {
    const branches: Record<string, BranchData> = {};
    for (const [name, data] of this.branches) {
      branches[name] = data;
    }
    return { name: 'branch', activeBranch: this.activeBranch, branches };
  }

  loadState(state: StrategyState): void {
    if (state.name === 'branch') {
      this.activeBranch = state.activeBranch;
      this.branches = new Map(Object.entries(state.branches));
    }
  }

  describe(): string {
    const count = this.branches.size;
    return `Branching — ${count} branch${count !== 1 ? 'es' : ''}, active: "${this.activeBranch}"`;
  }
}
