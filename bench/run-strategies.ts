import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { config } from '../src/config';
import { Agent } from '../src/agent';
import { DeepSeekProvider } from '../src/providers/deepseek';
import { GeminiProvider } from '../src/providers/gemini';
import { LMStudioProvider } from '../src/providers/lmstudio';
import { LLMProvider, Message, StrategyState, UsageData } from '../src/types';
import { Judge, ThreeWayJudgeResult } from './judge';
import { MultiColumnRenderer } from './renderer';

// ── Visual utilities ──────────────────────────────────────────────────────────

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

const CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-chat':     65_536,
  'deepseek-reasoner': 131_072,
  'gemini-2.0-flash':  1_048_576,
  'gemini-1.5-pro':    2_097_152,
};

function getContextWindow(): number | null {
  if (config.provider === 'lmstudio') return config.lmstudio!.contextSize;
  const model = config.provider === 'gemini' ? config.gemini!.model : config.deepseek!.model;
  return CONTEXT_WINDOWS[model] ?? null;
}

function label(text: string, style: string): string {
  return `${style}${text}${c.reset}`;
}

function printSeparator(): void {
  const width = Math.min(process.stdout.columns ?? 70, 70);
  process.stdout.write(`\n${c.dim}${'─'.repeat(width)}${c.reset}\n\n`);
}

function printTokenStats(tag: string, usage: UsageData | null, contextWindow: number | null, lastPrompt: number | null): void {
  if (!usage) return;
  let ctxPart = '';
  if (contextWindow) {
    const pct = (usage.prompt_tokens / contextWindow * 100).toFixed(1);
    ctxPart = ` ctx:${pct}%`;
  }
  let growthPart = '';
  if (lastPrompt !== null) {
    const mult = (usage.prompt_tokens / lastPrompt).toFixed(2);
    growthPart = ` growth:×${mult}`;
  }
  process.stdout.write(
    `${c.dim}  [${tag}] prompt:${usage.prompt_tokens} compl:${usage.completion_tokens}${ctxPart}${growthPart}${c.reset}\n`
  );
}

function printThreeWayTable(judge: ThreeWayJudgeResult, tokensW: number, tokensF: number, tokensB: number): void {
  const colW = 22;
  const scoreW = 10;
  const div = `  ${'─'.repeat(colW)}┼${'─'.repeat(scoreW)}┼${'─'.repeat(scoreW)}┼${'─'.repeat(scoreW)}`;

  process.stdout.write(`\n${label('  [судья]', c.dim)}\n`);
  process.stdout.write(`${c.dim}  ${'Критерий'.padEnd(colW)}│${'s-window'.padStart(scoreW)}│${'s-facts'.padStart(scoreW)}│${'branching'.padStart(scoreW)}${c.reset}\n`);
  process.stdout.write(`${c.dim}${div}${c.reset}\n`);

  for (const [name, key] of [
    ['Сохранение контекста', 'context'],
    ['Качество ответа',      'quality'],
    ['Полнота',              'completeness'],
  ] as const) {
    const s = judge[key];
    process.stdout.write(
      `${c.dim}  ${name.padEnd(colW)}│${`${s.scoreA}/10`.padStart(scoreW)}│${`${s.scoreB}/10`.padStart(scoreW)}│${`${s.scoreC}/10`.padStart(scoreW)}${c.reset}\n`
    );
  }
  process.stdout.write(`${c.dim}${div}${c.reset}\n`);
  process.stdout.write(
    `  ${c.bold}${'Итог'.padEnd(colW)}${c.reset}${c.dim}│${`${judge.overall.scoreA}/10`.padStart(scoreW)}│${`${judge.overall.scoreB}/10`.padStart(scoreW)}│${`${judge.overall.scoreC}/10`.padStart(scoreW)}${c.reset}\n`
  );
  process.stdout.write(`${c.dim}${div}${c.reset}\n`);
  process.stdout.write(
    `${c.dim}  ${'prompt_tokens'.padEnd(colW)}│${tokensW.toLocaleString().padStart(scoreW)}│${tokensF.toLocaleString().padStart(scoreW)}│${tokensB.toLocaleString().padStart(scoreW)}${c.reset}\n`
  );
  if (judge.conclusion) {
    process.stdout.write(`\n${c.dim}  Вывод: ${judge.conclusion}${c.reset}\n`);
  }
  process.stdout.write('\n');
}

// ── Types ─────────────────────────────────────────────────────────────────────

type BenchMessage = string | { text: string; checkpoint?: boolean };

interface BenchScript {
  name: string;
  description: string;
  judgePrompt: string;
  messages: BenchMessage[];
}

function parseMessage(m: BenchMessage): { text: string; checkpoint: boolean } {
  return typeof m === 'string'
    ? { text: m, checkpoint: false }
    : { text: m.text, checkpoint: m.checkpoint ?? false };
}

interface MessageResult {
  message: string;
  response: string;
  promptTokens: number;
  completionTokens: number;
}

interface AgentSnapshot {
  messages: Message[];
  strategyState: StrategyState;
}

interface RunCheckpoint {
  script: string;
  startedAt: string;
  lastCompletedIndex: number;
  agentW: AgentSnapshot;
  agentF: AgentSnapshot;
  agentB: AgentSnapshot;
  resultsW: MessageResult[];
  resultsF: MessageResult[];
  resultsB: MessageResult[];
  judgeResults: Array<ThreeWayJudgeResult | null>;
  lastPromptW: number | null;
  lastPromptF: number | null;
  lastPromptB: number | null;
}

// ── Retry helper ──────────────────────────────────────────────────────────────

async function chatWithRetry(
  agent: Agent,
  msg: string,
  onChunk: (chunk: string) => void
): Promise<UsageData | null> {
  try {
    return await agent.chat(msg, onChunk);
  } catch {
    await new Promise(r => setTimeout(r, 2000));
    return await agent.chat(msg, onChunk);
  }
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────

function checkpointPath(scriptName: string): string {
  return path.join(__dirname, 'reports', '.tmp', `${scriptName}.json`);
}

async function saveCheckpoint(cp: RunCheckpoint): Promise<void> {
  const dir = path.dirname(checkpointPath(cp.script));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(checkpointPath(cp.script), JSON.stringify(cp, null, 2));
}

async function loadCheckpoint(scriptName: string): Promise<RunCheckpoint | null> {
  try {
    const raw = await fs.readFile(checkpointPath(scriptName), 'utf-8');
    return JSON.parse(raw) as RunCheckpoint;
  } catch {
    return null;
  }
}

async function deleteCheckpoint(scriptName: string): Promise<void> {
  await fs.unlink(checkpointPath(scriptName)).catch(() => {});
}

function makeEmptyCheckpoint(scriptName: string): RunCheckpoint {
  const empty: AgentSnapshot = { messages: [], strategyState: { name: 'window', windowSize: 10 } };
  return {
    script: scriptName,
    startedAt: new Date().toISOString(),
    lastCompletedIndex: -1,
    agentW: { ...empty }, agentF: { ...empty }, agentB: { ...empty },
    resultsW: [], resultsF: [], resultsB: [],
    judgeResults: [],
    lastPromptW: null, lastPromptF: null, lastPromptB: null,
  };
}

// ── Provider factory ──────────────────────────────────────────────────────────

function createProvider(): LLMProvider {
  if (config.provider === 'gemini') return new GeminiProvider(config.gemini!);
  if (config.provider === 'lmstudio') return new LMStudioProvider(config.lmstudio!);
  return new DeepSeekProvider(config.deepseek!);
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport(
  script: BenchScript,
  resultsW: MessageResult[],
  resultsF: MessageResult[],
  resultsB: MessageResult[],
  judgeResults: Array<ThreeWayJudgeResult | null>
): string {
  const date = new Date().toISOString().slice(0, 10);
  const totalW = resultsW.reduce((s, r) => s + r.promptTokens, 0);
  const totalF = resultsF.reduce((s, r) => s + r.promptTokens, 0);
  const totalB = resultsB.reduce((s, r) => s + r.promptTokens, 0);
  const scored = judgeResults.filter((r): r is ThreeWayJudgeResult => r !== null);
  const avg = (key: 'scoreA' | 'scoreB' | 'scoreC') =>
    scored.length ? (scored.reduce((s, r) => s + r.overall[key], 0) / scored.length).toFixed(1) : 'N/A';

  let md = `# Benchmark: ${script.name} — ${date}\n\n> ${script.description}\n\n`;
  md += `## Итоговое сравнение стратегий\n\n`;
  md += `| | Sliding Window | Sticky Facts | Branching |\n|---|---|---|---|\n`;
  md += `| Avg overall score | ${avg('scoreA')}/10 | ${avg('scoreB')}/10 | ${avg('scoreC')}/10 |\n`;
  md += `| Total prompt tokens | ${totalW.toLocaleString()} | ${totalF.toLocaleString()} | ${totalB.toLocaleString()} |\n`;
  if (totalB > 0) {
    const savW = ((1 - totalW / totalB) * 100).toFixed(1);
    const savF = ((1 - totalF / totalB) * 100).toFixed(1);
    md += `| vs Branching (baseline) | ${savW}% | ${savF}% | baseline |\n`;
  }
  md += '\n';

  for (let i = 0; i < resultsW.length; i++) {
    const w = resultsW[i]; const f = resultsF[i]; const b = resultsB[i];
    const judge = judgeResults[i];
    const shortQ = w.message.length > 70 ? w.message.slice(0, 70) + '…' : w.message;
    md += `---\n\n## Сообщение ${i + 1}: "${shortQ}"\n\n`;
    md += `**Window:**\n${w.response}\n\n**Facts:**\n${f.response}\n\n**Branch:**\n${b.response}\n\n`;
    md += `| Критерий | Window | Facts | Branch |\n|---------|--------|-------|--------|\n`;
    if (judge) {
      md += `| Контекст | ${judge.context.scoreA}/10 | ${judge.context.scoreB}/10 | ${judge.context.scoreC}/10 |\n`;
      md += `| Качество | ${judge.quality.scoreA}/10 | ${judge.quality.scoreB}/10 | ${judge.quality.scoreC}/10 |\n`;
      md += `| Полнота | ${judge.completeness.scoreA}/10 | ${judge.completeness.scoreB}/10 | ${judge.completeness.scoreC}/10 |\n`;
      md += `| **Итог** | **${judge.overall.scoreA}/10** | **${judge.overall.scoreB}/10** | **${judge.overall.scoreC}/10** |\n`;
    }
    md += `| prompt\\_tokens | ${w.promptTokens.toLocaleString()} | ${f.promptTokens.toLocaleString()} | ${b.promptTokens.toLocaleString()} |\n`;
    if (judge?.conclusion) md += `\n*Вывод: ${judge.conclusion}*\n`;
    md += '\n';
  }
  return md;
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function runScript(script: BenchScript, judge: Judge, rl: readline.Interface): Promise<void> {
  const agentProvider = createProvider();
  const contextWindow = getContextWindow();
  const N = script.messages.length;

  const agentW = new Agent(agentProvider);
  const agentF = new Agent(agentProvider);
  const agentB = new Agent(agentProvider);
  agentW.setStrategy('window');
  agentF.setStrategy('facts');
  agentB.setStrategy('branch');

  // ── Resume detection
  const existing = await loadCheckpoint(script.name);
  let cp = makeEmptyCheckpoint(script.name);
  let startIndex = 0;

  if (existing && existing.lastCompletedIndex >= 0) {
    const answer = await new Promise<string>(resolve =>
      rl.question(
        `\n${label('◆', c.bold + c.yellow)} Found incomplete run (stopped after msg ${existing.lastCompletedIndex + 1}/${N}). Resume? [y/n] `,
        resolve
      )
    );
    if (answer.trim().toLowerCase() === 'y') {
      cp = existing;
      startIndex = existing.lastCompletedIndex + 1;
      agentW.loadHistory(existing.agentW.messages);
      agentW.setStrategyFromSession(existing.agentW.strategyState);
      agentF.loadHistory(existing.agentF.messages);
      agentF.setStrategyFromSession(existing.agentF.strategyState);
      agentB.loadHistory(existing.agentB.messages);
      agentB.setStrategyFromSession(existing.agentB.strategyState);
      console.log(`${label('◆ Resuming', c.bold + c.green)} from message ${startIndex + 1}/${N}\n`);
    }
  }

  const resultsW: MessageResult[] = [...cp.resultsW];
  const resultsF: MessageResult[] = [...cp.resultsF];
  const resultsB: MessageResult[] = [...cp.resultsB];
  const judgeResults: Array<ThreeWayJudgeResult | null> = [...cp.judgeResults];
  let lastPromptW = cp.lastPromptW;
  let lastPromptF = cp.lastPromptF;
  let lastPromptB = cp.lastPromptB;

  for (let i = startIndex; i < N; i++) {
    const { text: msg, checkpoint: isCheckpoint } = parseMessage(script.messages[i]);
    const isLast = i === N - 1;

    printSeparator();
    const cpMark = isCheckpoint ? ` ${label('✓ checkpoint', c.bold + c.green)}` : '';
    console.log(`${label(`Сообщение ${i + 1}/${N}`, c.bold + c.dim)}${cpMark}`);
    console.log(`${label('you>', c.dim)} ${msg}\n`);

    // ── Parallel agent run with live side-by-side streaming
    let usageW: UsageData | null = null;
    let usageF: UsageData | null = null;
    let usageB: UsageData | null = null;
    let responseW = '';
    let responseF = '';
    let responseB = '';

    const renderer = new MultiColumnRenderer(
      ['sliding-window', 'sticky-facts', 'branching'],
      [c.cyan, c.yellow, c.magenta]
    );

    const runAgent = async (agent: Agent, colIdx: number): Promise<{ response: string; usage: UsageData | null }> => {
      let response = '';
      const usage = await chatWithRetry(agent, msg, chunk => {
        response += chunk;
        renderer.append(colIdx, chunk);
      });
      renderer.markDone(colIdx, usage?.completion_tokens ?? undefined);
      return { response, usage };
    };

    try {
      const [rW, rF, rB] = await Promise.all([
        runAgent(agentW, 0),
        runAgent(agentF, 1),
        runAgent(agentB, 2),
      ]);
      responseW = rW.response; responseF = rF.response; responseB = rB.response;
      usageW = rW.usage; usageF = rF.usage; usageB = rB.usage;
    } catch (err) {
      renderer.clear();
      console.error(`\n${label('✗ Agent error', c.bold + c.red)} — saving checkpoint`);
      await saveCheckpoint(cp);
      throw err;
    }
    renderer.clear();

    printTokenStats('sliding-window', usageW, contextWindow, lastPromptW);
    printTokenStats('sticky-facts',   usageF, contextWindow, lastPromptF);
    printTokenStats('branching',      usageB, contextWindow, lastPromptB);
    process.stdout.write('\n');
    lastPromptW = usageW?.prompt_tokens ?? lastPromptW;
    lastPromptF = usageF?.prompt_tokens ?? lastPromptF;
    lastPromptB = usageB?.prompt_tokens ?? lastPromptB;

    resultsW.push({ message: msg, response: responseW, promptTokens: usageW?.prompt_tokens ?? 0, completionTokens: usageW?.completion_tokens ?? 0 });
    resultsF.push({ message: msg, response: responseF, promptTokens: usageF?.prompt_tokens ?? 0, completionTokens: usageF?.completion_tokens ?? 0 });
    resultsB.push({ message: msg, response: responseB, promptTokens: usageB?.prompt_tokens ?? 0, completionTokens: usageB?.completion_tokens ?? 0 });

    // ── Judge
    let judgeResult: ThreeWayJudgeResult | null = null;
    if (isCheckpoint || isLast) {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let fi = 0;
      process.stdout.write(`\r${label('[судья]', c.dim)} ${frames[0]}`);
      const spin = setInterval(() => process.stdout.write(`\r${label('[судья]', c.dim)} ${frames[fi++ % frames.length]}`), 80);
      try {
        judgeResult = await judge.evaluateThreeWay(msg, responseW, responseF, responseB, script.judgePrompt);
      } catch { /* skip */ }
      clearInterval(spin);
      process.stdout.write('\x1b[2K\r');
      if (judgeResult) {
        printThreeWayTable(judgeResult, usageW?.prompt_tokens ?? 0, usageF?.prompt_tokens ?? 0, usageB?.prompt_tokens ?? 0);
      }
    } else {
      process.stdout.write(`${c.dim}[судья пропущен — не контрольная точка]${c.reset}\n\n`);
    }
    judgeResults.push(judgeResult);

    // ── Save checkpoint
    cp = {
      ...cp,
      lastCompletedIndex: i,
      agentW: { messages: agentW.messages, strategyState: agentW.strategyState },
      agentF: { messages: agentF.messages, strategyState: agentF.strategyState },
      agentB: { messages: agentB.messages, strategyState: agentB.strategyState },
      resultsW, resultsF, resultsB, judgeResults,
      lastPromptW, lastPromptF, lastPromptB,
    };
    await saveCheckpoint(cp);
  }

  // ── Summary
  const scored = judgeResults.filter((r): r is ThreeWayJudgeResult => r !== null);
  const totalW = resultsW.reduce((s, r) => s + r.promptTokens, 0);
  const totalF = resultsF.reduce((s, r) => s + r.promptTokens, 0);
  const totalB = resultsB.reduce((s, r) => s + r.promptTokens, 0);
  const savW = totalB > 0 ? ((1 - totalW / totalB) * 100).toFixed(1) : '—';
  const savF = totalB > 0 ? ((1 - totalF / totalB) * 100).toFixed(1) : '—';

  const width = Math.min(process.stdout.columns ?? 70, 70);
  process.stdout.write(`\n${c.bold}${'═'.repeat(width)}${c.reset}\n`);
  console.log(label(`Results: ${script.name}`, c.bold));
  if (scored.length) {
    const avgW = (scored.reduce((s, r) => s + r.overall.scoreA, 0) / scored.length).toFixed(1);
    const avgF = (scored.reduce((s, r) => s + r.overall.scoreB, 0) / scored.length).toFixed(1);
    const avgB = (scored.reduce((s, r) => s + r.overall.scoreC, 0) / scored.length).toFixed(1);
    console.log(`Quality:  window=${label(`${avgW}/10`, c.bold)}  facts=${label(`${avgF}/10`, c.bold)}  branch=${label(`${avgB}/10`, c.bold)}`);
  }
  console.log(`Tokens:   window=${label(totalW.toLocaleString(), c.bold)}  facts=${label(totalF.toLocaleString(), c.bold)}  branch=${label(totalB.toLocaleString(), c.bold)}`);
  console.log(`Savings vs branch:  window=${label(`${savW}%`, c.bold)}  facts=${label(`${savF}%`, c.bold)}`);

  const report = buildReport(script, resultsW, resultsF, resultsB, judgeResults);
  const reportsDir = path.join(__dirname, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(reportsDir, `${date}-strategies-${script.name}.md`);
  await fs.writeFile(reportPath, report, 'utf-8');
  console.log(`Report:   ${label(reportPath, c.dim)}`);
  process.stdout.write(`${c.bold}${'═'.repeat(width)}${c.reset}\n`);

  await deleteCheckpoint(script.name);
}

// ── Script picker ─────────────────────────────────────────────────────────────

async function loadScripts(scriptsDir: string): Promise<BenchScript[]> {
  const files = (await fs.readdir(scriptsDir)).filter(f => f.endsWith('.json'));
  const scripts: BenchScript[] = [];
  for (const file of files) {
    scripts.push(JSON.parse(await fs.readFile(path.join(scriptsDir, file), 'utf-8')));
  }
  return scripts;
}

function pickScript(rl: readline.Interface, scripts: BenchScript[]): Promise<BenchScript> {
  console.log('\nВыбери сценарий для сравнения стратегий:');
  scripts.forEach((s, i) => {
    console.log(`  ${label(`[${i + 1}]`, c.bold + c.cyan)} ${label(s.name, c.bold)} ${label(`(${s.description})`, c.dim)}`);
  });
  return new Promise((resolve) => {
    const ask = () => {
      rl.question('> ', (input) => {
        const num = parseInt(input.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= scripts.length) { resolve(scripts[num - 1]); return; }
        console.log(`Enter 1–${scripts.length}.`);
        ask();
      });
    };
    ask();
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  const scriptsDir = path.join(__dirname, 'scripts');
  const judge = Judge.create();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let script: BenchScript;

  if (arg) {
    const scriptPath = path.join(scriptsDir, `${arg}.json`);
    try {
      script = JSON.parse(await fs.readFile(scriptPath, 'utf-8'));
    } catch {
      console.error(`Script not found: ${scriptPath}`);
      rl.close();
      process.exit(1);
    }
  } else {
    const scripts = await loadScripts(scriptsDir);
    if (scripts.length === 0) {
      console.error('No benchmark scripts found in bench/scripts/');
      rl.close();
      process.exit(1);
    }
    script = await pickScript(rl, scripts);
  }

  try {
    await runScript(script, judge, rl);
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
