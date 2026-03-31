import { LLMProvider, LTMEntry, Message, StrategyState, UserProfile, WorkingMemory } from '../types';
import { config } from '../config';
import { ContextStrategy } from './context-strategy';
import { MemoryManager } from '../memory/manager';
import { ProfileManager } from '../profile/manager';

const EMPTY_WM: WorkingMemory = { goal: '', steps: [], constraints: [], entities: [] };

// ── Prompts ───────────────────────────────────────────────────────────────────

const RETRIEVAL_SYSTEM = `You are a memory retrieval system.
Given the user's latest message and a list of long-term memory entries, return the IDs of entries relevant to answering the message.
Respond ONLY with a valid JSON array of IDs. If nothing is relevant, return [].
Example: ["id1", "id2"]`;

function buildRetrievalRequest(userMessage: string, entries: LTMEntry[]): string {
  const list = entries.map(e => `{"id":"${e.id}","content":${JSON.stringify(e.content)}}`).join('\n');
  return `User message: ${JSON.stringify(userMessage)}\n\nLong-term memory entries:\n${list}\n\nReturn relevant IDs as JSON array.`;
}

const DECISION_SYSTEM = `You are a memory manager for an AI assistant.
After each conversation turn, you:
1. Update the working memory (current task state — session-scoped)
2. Identify facts worth storing in long-term memory (cross-session — user preferences, stable patterns, important facts)
3. Detect EXPLICIT user preferences stated in this turn and update the user profile

Working memory fields:
- goal: the main objective of the current task (empty string if none)
- steps: list of planned or completed steps
- constraints: requirements and limitations
- entities: key named things (files, people, services, etc.)

Long-term memory rules:
- Store ONLY durable facts: user preferences, recurring patterns, stable decisions
- Do NOT store: temporary context, conversational filler, things already stored
- Keep facts concise (one sentence each)

Profile update rules:
- Update when the user expresses a preference — directly or through natural phrasing
- Direct: "answer briefly", "I use Python", "don't use markdown"
- Natural/indirect signals also count:
  * "keep it short" / "just the gist" / "too long" → preferences.style: brief
  * "can you elaborate" / "show me more" / "explain why" / "go deeper" → preferences.style: detailed
  * "just the code" / "no explanation needed" → preferences.verbosity: low
  * "with comments please" / "explain each step" → format.codeStyle: commented
  * "no need for comments" / "clean version" → format.codeStyle: clean
  * "I use/work with [Language]" / "I'm learning [Language]" / "I always use [Language]" / "[Language] only" → constraints.preferredLanguage
  * User states their primary language explicitly (e.g. "I'm a Python developer", "working in TypeScript") → constraints.preferredLanguage
  * LTM already contains "User works with [Language]" + current message also references that language → confirm constraints.preferredLanguage
  * "plain text" / "no markdown" / "no formatting" → format.responseStructure: plain
- Do NOT infer preferences from silence or neutral messages — only update on a clear signal
- Supported fields: preferences.style (brief|detailed), preferences.tone (formal|casual), preferences.verbosity (low|medium|high), format.codeStyle (commented|clean), format.responseStructure (markdown|plain), constraints.preferredLanguage (string)
- If no preference signal detected, use empty object {}

Respond ONLY with valid JSON (no other text):
{"wm_update":{"goal":"...","steps":[...],"constraints":[...],"entities":[...]},"ltm_add":["fact1","fact2"],"profile_update":{"preferences.style":"brief"}}`;

function buildDecisionRequest(
  currentWM: WorkingMemory,
  existingLTM: LTMEntry[],
  lastUser: string,
  lastAssistant: string
): string {
  const ltmList = existingLTM.length
    ? existingLTM.map(e => `- ${e.content}`).join('\n')
    : 'None';
  const wmStr = JSON.stringify(currentWM);
  return `Current working memory: ${wmStr}

Existing long-term memory:
${ltmList}

Last user message: ${JSON.stringify(lastUser)}
Last assistant message: ${JSON.stringify(lastAssistant.slice(0, 1000))}

Update working memory and identify new long-term facts.`;
}

// ── MemoryStrategy ────────────────────────────────────────────────────────────

export class MemoryStrategy implements ContextStrategy {
  readonly name = 'memory' as const;
  private workingMemory: WorkingMemory = { ...EMPTY_WM };
  private relevantEntries: LTMEntry[] = [];
  private currentProfile: UserProfile | null = null;
  private readonly manager: MemoryManager;
  private readonly profileManager: ProfileManager;
  private readonly windowSize: number;
  readonly sessionId: string;
  readonly userId: string | null;

  constructor(sessionId: string = 'default', windowSize?: number, userId?: string) {
    this.sessionId = sessionId;
    this.windowSize = windowSize ?? config.factsWindowSize;
    this.userId = userId ?? null;
    this.manager = new MemoryManager(undefined, userId ?? undefined);
    this.profileManager = new ProfileManager();
  }

  /** Called before buildPromptMessages — async LTM retrieval + profile load. */
  async prepareContext(history: Message[], provider: LLMProvider): Promise<void> {
    if (this.userId) {
      this.currentProfile = this.profileManager.load(this.userId);
    }

    const allEntries = this.manager.getAll();
    if (allEntries.length === 0) {
      this.relevantEntries = [];
      return;
    }

    // Find last user message
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    if (!lastUser) {
      this.relevantEntries = allEntries;
      return;
    }

    // Ask LLM to retrieve relevant entries
    try {
      const retrievalMessages: Message[] = [
        { role: 'system', content: RETRIEVAL_SYSTEM },
        { role: 'user', content: buildRetrievalRequest(lastUser.content, allEntries) },
      ];
      let raw = '';
      await provider.streamChat(retrievalMessages, chunk => { raw += chunk; });

      const match = raw.match(/\[[\s\S]*?\]/);
      if (!match) {
        this.relevantEntries = allEntries;
        return;
      }
      const ids = JSON.parse(match[0]) as string[];
      const idSet = new Set(ids);
      this.relevantEntries = allEntries.filter(e => idSet.has(e.id));
    } catch {
      // Fallback: inject all
      this.relevantEntries = allEntries;
    }
  }

  buildPromptMessages(systemPrompt: string, history: Message[]): Message[] {
    const messages: Message[] = [];

    // Build enriched system prompt
    let systemContent = systemPrompt;

    if (this.currentProfile && this.profileManager.hasAnyPreferences(this.currentProfile)) {
      const p = this.currentProfile;
      const lines: string[] = [];

      // Map profile fields to explicit, actionable instructions
      if (p.preferences.verbosity === 'low') {
        lines.push('- Do NOT include any explanations, introductory text, or commentary — respond with code snippets only');
      } else if (p.preferences.verbosity === 'medium') {
        lines.push('- Keep responses concise — minimal explanations, focus on code');
      } else if (p.preferences.verbosity === 'high') {
        lines.push('- Provide detailed explanations, step-by-step breakdowns, and analogies');
      }

      if (p.preferences.style === 'brief') {
        lines.push('- Be maximally concise — no preamble, no summary, just the answer');
      } else if (p.preferences.style === 'detailed') {
        lines.push('- Explain thoroughly — provide context, reasoning, and multiple examples');
      }

      if (p.preferences.tone === 'formal') {
        lines.push('- Use formal, professional tone');
      } else if (p.preferences.tone === 'casual') {
        lines.push('- Use casual, friendly tone');
      }

      if (p.format.codeStyle === 'clean') {
        lines.push('- Write code without any inline comments');
      } else if (p.format.codeStyle === 'commented') {
        lines.push('- Add a comment to every meaningful line of code');
      }

      if (p.format.responseStructure === 'plain') {
        lines.push('- Use plain text only — no markdown headers, no bullet lists, no formatting');
      } else if (p.format.responseStructure === 'markdown') {
        lines.push('- Use markdown formatting with headers and bullets');
      }

      if (p.constraints.preferredLanguage) {
        lines.push(`- Always respond using ${p.constraints.preferredLanguage}. Never switch to another programming language.`);
      }

      for (const rule of p.constraints.doNot) lines.push(`- Do NOT: ${rule}`);
      for (const rule of p.constraints.must)  lines.push(`- MUST: ${rule}`);

      systemContent += `\n\n[User profile — follow these rules strictly]\n${lines.join('\n')}`;
    }

    if (this.relevantEntries.length > 0) {
      const ltmSection = this.relevantEntries.map(e => `- ${e.content}`).join('\n');
      systemContent += `\n\n[Long-term memory — facts from previous sessions]\n${ltmSection}`;
    }

    const wm = this.workingMemory;
    const hasWM = wm.goal || wm.steps.length || wm.constraints.length || wm.entities.length;
    if (hasWM) {
      const parts: string[] = [];
      if (wm.goal)              parts.push(`Goal: ${wm.goal}`);
      if (wm.steps.length)      parts.push(`Steps: ${wm.steps.map((s, i) => `[${i + 1}] ${s}`).join(', ')}`);
      if (wm.constraints.length) parts.push(`Constraints: ${wm.constraints.join(', ')}`);
      if (wm.entities.length)   parts.push(`Entities: ${wm.entities.join(', ')}`);
      systemContent += `\n\n[Working memory — current task state]\n${parts.join('\n')}`;
    }

    messages.push({ role: 'system', content: systemContent });

    // Recent messages window
    const window = history.slice(-this.windowSize);
    return [...messages, ...window];
  }

  async afterTurn(history: Message[], provider: LLMProvider): Promise<Message[]> {
    const len = history.length;
    if (len < 2) return history;

    const lastUser = history[len - 2];
    const lastAssistant = history[len - 1];
    if (lastUser.role !== 'user' || lastAssistant.role !== 'assistant') return history;

    try {
      const decisionMessages: Message[] = [
        { role: 'system', content: DECISION_SYSTEM },
        {
          role: 'user',
          content: buildDecisionRequest(
            this.workingMemory,
            this.manager.getAll(),
            lastUser.content,
            lastAssistant.content
          ),
        },
      ];

      let raw = '';
      await provider.streamChat(decisionMessages, chunk => { raw += chunk; });

      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as {
          wm_update?: Partial<WorkingMemory>;
          ltm_add?: string[];
          profile_update?: Record<string, unknown>;
        };

        // Update working memory
        if (parsed.wm_update) {
          const u = parsed.wm_update;
          this.workingMemory = {
            goal:        u.goal        ?? this.workingMemory.goal,
            steps:       u.steps       ?? this.workingMemory.steps,
            constraints: u.constraints ?? this.workingMemory.constraints,
            entities:    u.entities    ?? this.workingMemory.entities,
          };
          this.manager.saveWMState(this.workingMemory);
        }

        // Add new LTM entries
        if (Array.isArray(parsed.ltm_add)) {
          const existing = new Set(this.manager.getAll().map(e => e.content.toLowerCase()));
          for (const fact of parsed.ltm_add) {
            if (fact && !existing.has(fact.toLowerCase())) {
              this.manager.addEntry(fact, this.sessionId);
            }
          }
        }

        // Update user profile (explicit preferences only)
        if (this.userId && parsed.profile_update && Object.keys(parsed.profile_update).length > 0) {
          this.currentProfile = this.profileManager.applyUpdate(this.userId, parsed.profile_update);
        }
      }
    } catch {
      // Decision engine failure is non-fatal
    }

    return history;
  }

  serializeState(): StrategyState {
    return { name: 'memory', workingMemory: this.workingMemory, windowSize: this.windowSize };
  }

  loadState(state: StrategyState): void {
    if (state.name === 'memory') {
      this.workingMemory = state.workingMemory;
    }
  }

  describe(): string {
    return `Memory — LTM (global JSON) + WM (session) + last ${this.windowSize} messages`;
  }

  /** Expose manager for bench/watch scripts. */
  getManager(): MemoryManager {
    return this.manager;
  }
}
