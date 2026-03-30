/**
 * run-memory.ts — Multi-session memory benchmark.
 *
 * Tests whether the MemoryStrategy correctly:
 *   1. Stores facts in long-term memory during session 1
 *   2. Retrieves and uses those facts in sessions 2 & 3
 *
 * Control group: SlidingWindowStrategy (no cross-session memory)
 *
 * Usage: npx ts-node bench/run-memory.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../src/config';
import { Agent } from '../src/agent';
import { DeepSeekProvider } from '../src/providers/deepseek';
import { GeminiProvider } from '../src/providers/gemini';
import { LMStudioProvider } from '../src/providers/lmstudio';
import { MemoryStrategy } from '../src/strategies/memory';
import { MemoryManager } from '../src/memory/manager';
import { LLMProvider, UsageData } from '../src/types';
import { Judge, JudgeResult } from './judge';
import { MultiColumnRenderer } from './renderer';

// ── Colors ────────────────────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  yellow:  '\x1b[33m',
  green:   '\x1b[32m',
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
};

function label(text: string, style: string): string {
  return `${style}${text}${c.reset}`;
}

function printSeparator(): void {
  const width = Math.min(process.stdout.columns ?? 70, 70);
  process.stdout.write(`\n${c.dim}${'─'.repeat(width)}${c.reset}\n\n`);
}

// ── Scenario ──────────────────────────────────────────────────────────────────

interface BenchSession {
  name: string;
  messages: string[];
  /** Last message is the one judged for recall */
  judgeMessageIndex: number;
  judgePrompt: string;
}

const SCENARIO: BenchSession[] = [
  {
    name: 'Session 1 — Fact introduction',
    messages: [
      'Hi! My name is Alex and I prefer TypeScript over JavaScript.',
      'I\'m building a REST API using Express. I don\'t want to use any ORM — raw SQL only.',
      'My main constraint is that the app must run on Node 18 without transpilation in production.',
      'What are some good middleware libraries for Express that work well with TypeScript?',
    ],
    judgeMessageIndex: 3,
    judgePrompt: 'Evaluate whether the answer considers the stated preferences: TypeScript, no ORM, Node 18.',
  },
  {
    name: 'Session 2 — Recall test',
    messages: [
      'Hey, I\'m continuing my Express API project. What\'s my name again and what constraints did I mention?',
      'Given those constraints, how should I structure my database connection module?',
    ],
    judgeMessageIndex: 1,
    judgePrompt: 'The agent should remember: user name is Alex, TypeScript, no ORM, raw SQL, Node 18. Score based on recalled facts.',
  },
  {
    name: 'Session 3 — Deep recall',
    messages: [
      'Write me a basic Express route handler for user registration. Remember my tech preferences.',
    ],
    judgeMessageIndex: 0,
    judgePrompt: 'The code must be TypeScript, no ORM, compatible with Node 18. Score based on applying remembered constraints.',
  },
];

// ── Provider ──────────────────────────────────────────────────────────────────

function createProvider(): LLMProvider {
  if (config.provider === 'gemini') return new GeminiProvider(config.gemini!);
  if (config.provider === 'lmstudio') return new LMStudioProvider(config.lmstudio!);
  return new DeepSeekProvider(config.deepseek!);
}

// ── Report ────────────────────────────────────────────────────────────────────

interface SessionResult {
  sessionName: string;
  memoryResponse: string;
  controlResponse: string;
  judgeResult: JudgeResult | null;
  memoryTokens: number;
  controlTokens: number;
}

function buildReport(results: SessionResult[]): string {
  const date = new Date().toISOString().slice(0, 10);
  let md = `# Memory Bench — ${date}\n\n`;
  md += `> Multi-session recall test: MemoryStrategy vs SlidingWindow (control)\n\n`;

  const scored = results.filter(r => r.judgeResult !== null);
  if (scored.length > 0) {
    const avgMem = (scored.reduce((s, r) => s + r.judgeResult!.overall.scoreA, 0) / scored.length).toFixed(1);
    const avgCtrl = (scored.reduce((s, r) => s + r.judgeResult!.overall.scoreB, 0) / scored.length).toFixed(1);

    md += `## Summary\n\n`;
    md += `| | Memory Strategy | Sliding Window (control) |\n|---|---|---|\n`;
    md += `| Avg overall score | ${avgMem}/10 | ${avgCtrl}/10 |\n`;
    const totalMem = results.reduce((s, r) => s + r.memoryTokens, 0);
    const totalCtrl = results.reduce((s, r) => s + r.controlTokens, 0);
    md += `| Total prompt tokens | ${totalMem.toLocaleString()} | ${totalCtrl.toLocaleString()} |\n\n`;
  }

  for (const r of results) {
    md += `---\n\n## ${r.sessionName}\n\n`;
    md += `**Memory:**\n${r.memoryResponse}\n\n`;
    md += `**Control (window):**\n${r.controlResponse}\n\n`;
    if (r.judgeResult) {
      const j = r.judgeResult;
      md += `| Criterion | Memory | Control |\n|---|---|---|\n`;
      md += `| Context | ${j.context.scoreA}/10 | ${j.context.scoreB}/10 |\n`;
      md += `| Quality | ${j.quality.scoreA}/10 | ${j.quality.scoreB}/10 |\n`;
      md += `| Completeness | ${j.completeness.scoreA}/10 | ${j.completeness.scoreB}/10 |\n`;
      md += `| **Overall** | **${j.overall.scoreA}/10** | **${j.overall.scoreB}/10** |\n`;
      if (j.conclusion) md += `\n*${j.conclusion}*\n`;
    }
    md += `\n| prompt_tokens | ${r.memoryTokens.toLocaleString()} | ${r.controlTokens.toLocaleString()} |\n\n`;
  }

  return md;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

const CHECKPOINT_PATH = path.join(__dirname, 'reports', '.tmp', 'memory-bench.json');

interface Checkpoint {
  completedSessions: number;
  results: SessionResult[];
}

async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  await fs.mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
  await fs.writeFile(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

async function loadCheckpoint(): Promise<Checkpoint | null> {
  try {
    const raw = await fs.readFile(CHECKPOINT_PATH, 'utf-8');
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

async function deleteCheckpoint(): Promise<void> {
  await fs.unlink(CHECKPOINT_PATH).catch(() => {});
}

// ── Two-way judge system prompt ───────────────────────────────────────────────

// We reuse Judge.evaluate but customize the instruction per session.
// Judge.evaluate labels A as "without compression" and B as "with compression" —
// for memory bench we repurpose: A = Memory, B = Control.

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${label('◆ Memory Benchmark', c.bold + c.cyan)} — multi-session recall test\n`);
  console.log(`${c.dim}Memory strategy vs Sliding Window (control)${c.reset}`);
  console.log(`${c.dim}Tip: run bench/watch-memory.ts in a separate terminal to inspect layers live${c.reset}\n`);

  // Clean up previous LTM so bench is reproducible
  const memDir = path.join(__dirname, '../memory');
  await fs.mkdir(memDir, { recursive: true });
  const ltmPath = path.join(memDir, 'ltm.json');
  const logPath = path.join(memDir, 'ltm-log.jsonl');
  const wmPath  = path.join(memDir, 'wm-state.json');
  await fs.writeFile(ltmPath, '[]').catch(() => {});
  await fs.writeFile(logPath, '').catch(() => {});
  await fs.writeFile(wmPath, '{}').catch(() => {});
  console.log(`${c.dim}Cleared previous LTM for fresh bench run.${c.reset}\n`);

  const provider = createProvider();
  const judge = Judge.create();

  // Check for existing checkpoint
  const existing = await loadCheckpoint();
  let startSession = 0;
  const results: SessionResult[] = [];

  if (existing && existing.completedSessions > 0) {
    process.stdout.write(`${label('◆', c.bold + c.yellow)} Found incomplete run (${existing.completedSessions}/${SCENARIO.length} sessions). Resume? [y/n] `);
    const answer = await new Promise<string>(resolve => {
      process.stdin.once('data', d => resolve(d.toString().trim()));
    });
    if (answer.toLowerCase() === 'y') {
      startSession = existing.completedSessions;
      results.push(...existing.results);
      console.log(`${label('◆ Resuming', c.bold + c.green)} from session ${startSession + 1}\n`);
    }
  }

  // Create agents — memory agent persists across sessions (same MemoryManager)
  const memoryAgent = new Agent(provider);
  memoryAgent.setStrategy('memory', { sessionId: 'bench-memory' });

  const controlAgent = new Agent(provider);
  controlAgent.setStrategy('window');

  for (let si = startSession; si < SCENARIO.length; si++) {
    const session = SCENARIO[si];
    printSeparator();
    console.log(`${label(`Session ${si + 1}/${SCENARIO.length}`, c.bold + c.dim)}: ${label(session.name, c.bold)}\n`);

    // Reset agents for new session (clear history, keep LTM in memory agent)
    if (si > startSession || startSession === 0) {
      // Fresh history for each session
      (memoryAgent as any).history = [{ role: 'system', content: 'You are a helpful assistant.' }];
      (controlAgent as any).history = [{ role: 'system', content: 'You are a helpful assistant.' }];
    }

    let judgedMemResponse = '';
    let judgedCtrlResponse = '';
    let judgedMemTokens = 0;
    let judgedCtrlTokens = 0;

    for (let mi = 0; mi < session.messages.length; mi++) {
      const msg = session.messages[mi];
      const isJudged = mi === session.judgeMessageIndex;
      const isLast = mi === session.messages.length - 1;

      if (mi < session.messages.length - 1 && !isJudged) {
        // Background turns — run sequentially, no display
        console.log(`${label('you>', c.dim)} ${msg}`);
        let memR = '';
        let ctrlR = '';
        const [mu, cu] = await Promise.all([
          memoryAgent.chat(msg, c => { memR += c; }),
          controlAgent.chat(msg, c => { ctrlR += c; }),
        ]);
        console.log(`${c.dim}[mem]  ${memR.slice(0, 80)}...${c.reset}`);
        console.log(`${c.dim}[ctrl] ${ctrlR.slice(0, 80)}...${c.reset}\n`);
        continue;
      }

      // Judged message — show live side-by-side
      console.log(`\n${label('you>', c.bold)} ${label(msg, c.bold)}\n`);

      const renderer = new MultiColumnRenderer(
        ['memory', 'sliding-window'],
        [c.cyan, c.yellow]
      );

      const turnResult = {
        memResponse: '',
        ctrlResponse: '',
        memUsage: null as UsageData | null,
        ctrlUsage: null as UsageData | null,
      };

      await Promise.all([
        (async () => {
          turnResult.memUsage = await memoryAgent.chat(msg, chunk => {
            turnResult.memResponse += chunk;
            renderer.append(0, chunk);
          });
          renderer.markDone(0, turnResult.memUsage?.completion_tokens ?? undefined);
        })(),
        (async () => {
          turnResult.ctrlUsage = await controlAgent.chat(msg, chunk => {
            turnResult.ctrlResponse += chunk;
            renderer.append(1, chunk);
          });
          renderer.markDone(1, turnResult.ctrlUsage?.completion_tokens ?? undefined);
        })(),
      ]);

      renderer.clear();

      if (isJudged) {
        judgedMemResponse = turnResult.memResponse;
        judgedCtrlResponse = turnResult.ctrlResponse;
        judgedMemTokens = turnResult.memUsage?.prompt_tokens ?? 0;
        judgedCtrlTokens = turnResult.ctrlUsage?.prompt_tokens ?? 0;
      }
    }

    // Judge the session
    process.stdout.write(`\n${label('[судья]', c.dim)} evaluating…\n`);
    let judgeResult: JudgeResult | null = null;
    try {
      judgeResult = await judge.evaluate(
        session.messages[session.judgeMessageIndex],
        judgedMemResponse,
        judgedCtrlResponse,
        session.judgePrompt
      );
      printJudgeTable(judgeResult, judgedMemTokens, judgedCtrlTokens);
    } catch (err) {
      console.error(`${label('✗ Judge error:', c.red)} ${err}`);
    }

    const sessionResult: SessionResult = {
      sessionName: session.name,
      memoryResponse: judgedMemResponse,
      controlResponse: judgedCtrlResponse,
      judgeResult,
      memoryTokens: judgedMemTokens,
      controlTokens: judgedCtrlTokens,
    };
    results.push(sessionResult);

    await saveCheckpoint({ completedSessions: si + 1, results });
  }

  // Write report
  const reportDir = path.join(__dirname, 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(reportDir, `memory-bench-${date}.md`);
  const report = buildReport(results);
  await fs.writeFile(reportPath, report);

  await deleteCheckpoint();

  printSeparator();
  console.log(`${label('✓ Done', c.bold + c.green)} Report saved to ${reportPath}\n`);
}

function printJudgeTable(judge: JudgeResult, tokensA: number, tokensB: number): void {
  const colW = 24;
  const scoreW = 12;
  const div = `  ${'─'.repeat(colW)}┼${'─'.repeat(scoreW)}┼${'─'.repeat(scoreW)}`;

  process.stdout.write(`\n${label('  [судья]', c.dim)}\n`);
  process.stdout.write(`${c.dim}  ${'Критерий'.padEnd(colW)}│${'memory'.padStart(scoreW)}│${'window'.padStart(scoreW)}${c.reset}\n`);
  process.stdout.write(`${c.dim}${div}${c.reset}\n`);

  for (const [name, key] of [
    ['Контекст', 'context'],
    ['Качество',  'quality'],
    ['Полнота',   'completeness'],
  ] as const) {
    const s = judge[key];
    process.stdout.write(
      `${c.dim}  ${name.padEnd(colW)}│${`${s.scoreA}/10`.padStart(scoreW)}│${`${s.scoreB}/10`.padStart(scoreW)}${c.reset}\n`
    );
  }
  process.stdout.write(`${c.dim}${div}${c.reset}\n`);
  process.stdout.write(
    `  ${c.bold}${'Итог'.padEnd(colW)}${c.reset}${c.dim}│${`${judge.overall.scoreA}/10`.padStart(scoreW)}│${`${judge.overall.scoreB}/10`.padStart(scoreW)}${c.reset}\n`
  );
  process.stdout.write(`${c.dim}${div}${c.reset}\n`);
  process.stdout.write(
    `${c.dim}  ${'prompt_tokens'.padEnd(colW)}│${tokensA.toLocaleString().padStart(scoreW)}│${tokensB.toLocaleString().padStart(scoreW)}${c.reset}\n`
  );
  if (judge.conclusion) {
    process.stdout.write(`\n${c.dim}  Вывод: ${judge.conclusion}${c.reset}\n`);
  }
  process.stdout.write('\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
