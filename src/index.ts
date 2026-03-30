import * as readline from 'readline';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { config } from './config';
import { Agent } from './agent';
import { DeepSeekProvider } from './providers/deepseek';
import { GeminiProvider } from './providers/gemini';
import { LMStudioProvider } from './providers/lmstudio';
import { JsonSessionStorage } from './storage/json';
import { LLMProvider, Session } from './types';

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
};

const CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-chat':      65_536,
  'deepseek-reasoner': 131_072,
  'gemini-2.0-flash': 1_048_576,
  'gemini-1.5-pro':   2_097_152,
};

function label(text: string, style: string): string {
  return `${style}${text}${c.reset}`;
}

function relativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'yesterday';
  return `${diffDays} days ago`;
}

function defaultSessionName(): string {
  const date = new Date().toISOString().slice(0, 10);
  const shortId = randomUUID().slice(0, 4);
  return `session-${date}-${shortId}`;
}

function startSpinner(): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const render = () =>
    process.stdout.write(`\r${label('agent:', c.bold + c.cyan)} ${frames[i++ % frames.length]}`);
  render();
  const timer = setInterval(render, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write('\x1b[2K\r');
  };
}

function printSeparator(): void {
  const width = Math.min(process.stdout.columns ?? 60, 60);
  process.stdout.write(`${c.dim}${'─'.repeat(width)}${c.reset}\n\n`);
}

function promptNewSession(rl: readline.Interface): Promise<Session> {
  const defaultName = defaultSessionName();
  return new Promise((resolve) => {
    rl.question(`Session name (default: ${defaultName}): `, (input) => {
      const name = input.trim() || defaultName;
      resolve({
        id: randomUUID(),
        name,
        messageCount: 0,
        lastSavedAt: new Date().toISOString(),
        totalTokensUsed: 0,
        messages: [],
      });
    });
  });
}

function pickSession(rl: readline.Interface, sessions: Session[]): Promise<Session> {
  console.log('\nSessions:');
  sessions.forEach((s, i) => {
    const msgs = `${s.messageCount} msg`;
    const num  = label(`[${i + 1}]`, c.bold + c.cyan);
    const name = label(s.name, c.bold);
    const meta = label(`(${msgs}, last: ${relativeTime(s.lastSavedAt)})`, c.dim);
    console.log(`  ${num} ${name} ${meta}`);
  });
  console.log(`  ${label('[n]', c.bold + c.green)} ${label('Start new session', c.dim)}\n`);

  return new Promise((resolve) => {
    const ask = () => {
      rl.question('> ', (input) => {
        const trimmed = input.trim();

        if (trimmed === 'n') {
          promptNewSession(rl).then(resolve);
          return;
        }

        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 1 && num <= sessions.length) {
          resolve(sessions[num - 1]);
          return;
        }

        console.log(`Enter 1–${sessions.length} to resume a session, or 'n' for new.`);
        ask();
      });
    };
    ask();
  });
}

async function main() {
  let provider: LLMProvider;
  if (config.provider === 'gemini') {
    provider = new GeminiProvider(config.gemini!);
  } else if (config.provider === 'lmstudio') {
    provider = new LMStudioProvider(config.lmstudio!);
  } else {
    provider = new DeepSeekProvider(config.deepseek!);
  }
  const storage = new JsonSessionStorage(path.resolve(config.sessionsDir));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const sessions = await storage.listSessions();
  const session: Session = sessions.length > 0
    ? await pickSession(rl, sessions)
    : await promptNewSession(rl);

  const agent = new Agent(provider, storage, session);

  if (session.messages.length > 0) {
    agent.loadHistory(session.messages, session.summary);
    if (session.strategyState) {
      agent.setStrategyFromSession(session.strategyState);
    }
  }

  const activeModel = config.provider === 'gemini'
    ? config.gemini!.model
    : config.provider === 'lmstudio'
      ? config.lmstudio!.model
      : config.deepseek!.model;
  const contextWindow = config.provider === 'lmstudio'
    ? config.lmstudio!.contextSize
    : CONTEXT_WINDOWS[activeModel] ?? null;
  let lastPromptTokens: number | null = null;

  const msgCount = session.messages.length;
  const countStr = msgCount > 0 ? ` ${label(`· ${msgCount} messages loaded`, c.dim)}` : '';
  console.log(`\n${label('◆', c.bold + c.cyan)} ${label(session.name, c.bold)}${countStr}`);

  console.log('\n' + label('Agent ready.', c.bold), 'Press Enter to send. Paste multi-line code — it sends as one message.');
  console.log(`Type ${label('/ml', c.bold)} to toggle multi-line mode. ${label('/ctx [window|facts|branch]', c.bold)} to switch context strategy. ${label('/branch save|list|load', c.bold)} for branching. Ctrl+C to exit.\n`);

  const buffer: string[] = [];
  let isProcessing = false;
  let submitTimer: ReturnType<typeof setTimeout> | null = null;
  let multilineMode = false;

  const PASTE_WINDOW_MS = 50;

  function getPrompt(): string {
    const indicator = multilineMode ? 'ml' : 'you';
    return `${c.dim}${indicator}>${c.reset} `;
  }

  async function submit(): Promise<void> {
    const input = buffer.join('\n').trim();
    buffer.length = 0;

    if (!input) {
      rl.setPrompt(getPrompt());
      rl.prompt();
      return;
    }

    rl.setPrompt('');
    isProcessing = true;
    process.stdout.write('\n');

    const stopSpinner = startSpinner();
    let headerPrinted = false;

    try {
      const usage = await agent.chat(input, (chunk) => {
        if (!headerPrinted) {
          headerPrinted = true;
          stopSpinner();
          process.stdout.write(`${label('agent:', c.bold + c.cyan)}\n`);
        }
        process.stdout.write(chunk);
      });
      process.stdout.write('\n');
      if (usage) {
        const sessionTotal = agent.totalTokensUsed;

        let ctxPart = '';
        if (contextWindow) {
          const pct = (usage.prompt_tokens / contextWindow * 100).toFixed(1);
          ctxPart = ` | ctx: ${pct}%`;
        }

        let growthPart = '';
        if (lastPromptTokens !== null) {
          const multiplier = (usage.prompt_tokens / lastPromptTokens).toFixed(2);
          growthPart = ` | growth: ×${multiplier}`;
        }
        lastPromptTokens = usage.prompt_tokens;

        process.stdout.write(
          `${c.dim}[tokens] prompt: ${usage.prompt_tokens} | completion: ${usage.completion_tokens} | total: ${usage.total_tokens}${ctxPart}${growthPart} | session: ${sessionTotal.toLocaleString()}${c.reset}\n`
        );
      }
      printSeparator();
    } catch (err) {
      stopSpinner();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n${label('✗', c.bold + c.red)} ${label(msg, c.red)}`);
    } finally {
      isProcessing = false;
      rl.setPrompt(getPrompt());
      rl.prompt();
    }
  }

  rl.setPrompt(getPrompt());
  rl.prompt();

  rl.on('line', (line) => {
    if (isProcessing) return;

    // ── /ctx ──────────────────────────────────────────────────────────────────
    if (line.trim() === '/ctx' || line.trim().startsWith('/ctx ')) {
      const parts = line.trim().split(/\s+/);
      const sub = parts[1];
      const arg = parts[2] ? parseInt(parts[2], 10) : undefined;

      if (!sub) {
        console.log(`${label('◆ Context strategy:', c.bold + c.cyan)} ${agent.activeStrategy}`);
        console.log(`  ${label(agent.activeStrategyDescription, c.dim)}`);
      } else if (sub === 'window') {
        const n = (!arg || isNaN(arg)) ? undefined : arg;
        agent.setStrategy('window', { windowSize: n });
        console.log(`${label('◆ Strategy:', c.bold + c.cyan)} ${label(agent.activeStrategyDescription, c.bold)}`);
      } else if (sub === 'facts') {
        const n = (!arg || isNaN(arg)) ? undefined : arg;
        agent.setStrategy('facts', { windowSize: n });
        console.log(`${label('◆ Strategy:', c.bold + c.cyan)} ${label(agent.activeStrategyDescription, c.bold)}`);
      } else if (sub === 'branch') {
        agent.setStrategy('branch');
        console.log(`${label('◆ Strategy:', c.bold + c.cyan)} ${label(agent.activeStrategyDescription, c.bold)}`);
        console.log(`  ${label('Use /branch save|list|load <name> to manage branches.', c.dim)}`);
      } else if (sub === 'rolling') {
        agent.setStrategy('rolling');
        console.log(`${label('◆ Strategy:', c.bold + c.cyan)} ${label(agent.activeStrategyDescription, c.bold)}`);
      } else if (sub === 'memory') {
        agent.setStrategy('memory', { sessionId: session.id });
        console.log(`${label('◆ Strategy:', c.bold + c.cyan)} ${label(agent.activeStrategyDescription, c.bold)}`);
        console.log(`  ${label('Long-term memory persists across sessions. Run bench/watch-memory.ts to inspect layers.', c.dim)}`);
      } else {
        console.log(`Unknown strategy. Use: ${label('/ctx window|facts|branch|rolling|memory', c.bold)}`);
      }
      rl.setPrompt(getPrompt());
      rl.prompt();
      return;
    }

    // ── /branch ───────────────────────────────────────────────────────────────
    if (line.trim().startsWith('/branch')) {
      const parts = line.trim().split(/\s+/);
      const sub = parts[1];
      const name = parts.slice(2).join(' ') || parts[2];

      try {
        if (sub === 'save') {
          if (!name) { console.log('Usage: /branch save <name>'); }
          else {
            agent.branchSave(name);
            console.log(`${label('◆ Branch saved:', c.bold + c.green)} "${name}"`);
          }
        } else if (sub === 'list') {
          const branches = agent.branchList();
          if (branches.length === 0) {
            console.log(`${c.dim}No branches yet.${c.reset}`);
          } else {
            console.log(`${label('Branches:', c.bold)}`);
            for (const b of branches) {
              const active = b.name === (agent as any).strategy?.getActiveBranch?.() ? ' ◀ active' : '';
              console.log(`  ${label(b.name, c.bold + c.cyan)}${label(active, c.green)}  ${label(`(${b.messageCount} msgs)`, c.dim)}`);
            }
          }
        } else if (sub === 'load') {
          if (!name) { console.log('Usage: /branch load <name>'); }
          else {
            agent.branchLoad(name);
            console.log(`${label('◆ Branch loaded:', c.bold + c.cyan)} "${name}"`);
          }
        } else {
          console.log(`Usage: ${label('/branch save|list|load <name>', c.bold)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${label('✗', c.bold + c.red)} ${label(msg, c.red)}`);
      }
      rl.setPrompt(getPrompt());
      rl.prompt();
      return;
    }

    if (line.trim() === '/ml') {
      multilineMode = !multilineMode;
      buffer.length = 0;
      if (submitTimer) { clearTimeout(submitTimer); submitTimer = null; }
      console.log(multilineMode
        ? `${label('Multi-line mode ON', c.bold)} — type ${label('---', c.bold)} on a new line to send.`
        : `${label('Multi-line mode OFF', c.bold)} — Enter sends, paste auto-detected.`);
      rl.setPrompt(getPrompt());
      rl.prompt();
      return;
    }

    if (line.trim() === '/summary') {
      const enabled = agent.toggleSummary();
      console.log(enabled
        ? `${label('Summarization ON', c.bold)} — older messages will be compressed automatically.`
        : `${label('Summarization OFF', c.bold)} — full history will be sent on every request.`);
      rl.setPrompt(getPrompt());
      rl.prompt();
      return;
    }

    if (multilineMode) {
      if (line.trim() === '---') {
        submit();
      } else {
        buffer.push(line);
        rl.setPrompt(`${c.dim}...${c.reset} `);
        rl.prompt();
      }
    } else {
      buffer.push(line);
      if (submitTimer) clearTimeout(submitTimer);
      submitTimer = setTimeout(() => {
        submitTimer = null;
        submit();
      }, PASTE_WINDOW_MS);
    }
  });

  rl.on('close', () => process.exit(0));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
