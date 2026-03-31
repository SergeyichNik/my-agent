export { ContextStrategy, StrategyName } from './context-strategy';
export { RollingSummaryStrategy } from './rolling-summary';
export { SlidingWindowStrategy } from './sliding-window';
export { StickyFactsStrategy } from './sticky-facts';
export { BranchingStrategy, BranchListEntry } from './branching';
export { MemoryStrategy } from './memory';

import { StrategyState } from '../types';
import { ContextStrategy, StrategyName } from './context-strategy';
import { RollingSummaryStrategy } from './rolling-summary';
import { SlidingWindowStrategy } from './sliding-window';
import { StickyFactsStrategy } from './sticky-facts';
import { BranchingStrategy } from './branching';
import { MemoryStrategy } from './memory';

export function createStrategy(name: StrategyName, opts?: { windowSize?: number; sessionId?: string; userId?: string }): ContextStrategy {
  switch (name) {
    case 'rolling': return new RollingSummaryStrategy();
    case 'window':  return new SlidingWindowStrategy(opts?.windowSize);
    case 'facts':   return new StickyFactsStrategy(opts?.windowSize);
    case 'branch':  return new BranchingStrategy();
    case 'memory':  return new MemoryStrategy(opts?.sessionId, opts?.windowSize, opts?.userId);
  }
}

export function createStrategyFromState(state: StrategyState): ContextStrategy {
  const strategy = createStrategy(state.name);
  strategy.loadState(state);
  return strategy;
}
