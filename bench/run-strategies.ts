import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { config } from '../src/config';
import { Agent } from '../src/agent';
import { DeepSeekProvider } from '../src/providers/deepseek';
import { GeminiProvider } from '../src/providers/gemini';
import { LMStudioProvider } from '../src/providers/lmstudio';
import { LLMProvider, UsageData } from '../src/types';
import { Judge, ThreeWayJudgeResult } from './judge';

// ── Visual utilities ──────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  magenta: '\x1b[35m',
  red:    '\x1b[31m',
};

const CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-chat':    65_536,
  'deepseek-reasoner': 131_072,
  'gemini-2.0-flash': 1_048_576,
  'gemini-1.5-pro':   2_097_152,
};

function getContextWindow(): number | null {
  if (config.provider === 'lmstudio') return config.lmstudio!.contextSize;
  const model = config.provider === 'gemini' ? config.gemini!.model : config.deepseek!.model;
  return CONTEXT_WINDOWS[model] ?? null;
}

function label(text: string, style: string): string {
  return `${style}${text}${c.reset}`;
}

function startSpinner(labelText: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const render = () =>
    process.stdout.write(`\r${label(labelText, c.bold)} ${frames[i++ % frames.length]}`);
  render();
  const timer = setInterval(render, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write('\x1b[2K\r');
  };
}

function printSeparator(): void {
  const width = Math.min(process.stdout.columns ?? 70, 70);
  process.stdout.write(`\n${c.dim}${'─'.repeat(width)}${c.reset}\n\n`);
}

function printTokenStats(label_: string, usage: UsageData | null, contextWindow: number | null, lastPrompt: number | null): void {
  if (!usage) return;
  let ctxPart = '';
  if (contextWindow) {
    const pct = (usage.prompt_tokens / contextWindow * 100).toFixed(1);
    ctxPart = ` | ctx: ${pct}%`;
  }
  let growthPart = '';
  if (lastPrompt !== null) {
    const mult = (usage.prompt_tokens / lastPrompt).toFixed(2);
    growthPart = ` | growth: ×${mult}`;
  }
  process.stdout.write(
    `${c.dim}  [${label_}] prompt: ${usage.prompt_tokens} | completion: ${usage.completion_tokens}${ctxPart}${growthPart}${c.reset}\n`
  );
}

function printThreeWayTable(judge: ThreeWayJudgeResult, tokensW: number, tokensF: number, tokensB: number): void {
  const colW = 22;
  const scoreW = 10;
  const divider = `  ${'─'.repeat(colW)}┼${'─'.repeat(scoreW)}┼${'─'.repeat(scoreW)}┼${'─'.repeat(scoreW)}`;

  process.stdout.write(`\n${label('  [судья]', c.dim)}\n`);
  process.stdout.write(`${c.dim}  ${'Критерий'.padEnd(colW)}│${'Window'.padStart(scoreW)}│${'Facts'.padStart(scoreW)}│${'Branch'.padStart(scoreW)}${c.reset}\n`);
  process.stdout.write(`${c.dim}${divider}${c.reset}\n`);

  const rows: Array<{ name: string; key: 'context' | 'quality' | 'completeness' | 'overall' }> = [
    { name: 'Сохранение контекста', key: 'context' },
    { name: 'Качество ответа',      key: 'quality' },
    { name: 'Полнота',              key: 'completeness' },
  ];

  for (const row of rows) {
    const scores = judge[row.key];
    process.stdout.write(
      `${c.dim}  ${row.name.padEnd(colW)}│${ `${scores.scoreA}/10`.padStart(scoreW)}│${ `${scores.scoreB}/10`.padStart(scoreW)}│${ `${scores.scoreC}/10`.padStart(scoreW)}${c.reset}\n`
    );
  }

  process.stdout.write(`${c.dim}${divider}${c.reset}\n`);
  process.stdout.write(
    `  ${c.bold}${'Итог'.padEnd(colW)}${c.reset}${c.dim}│${`${judge.overall.scoreA}/10`.padStart(scoreW)}│${`${judge.overall.scoreB}/10`.padStart(scoreW)}│${`${judge.overall.scoreC}/10`.padStart(scoreW)}${c.reset}\n`
  );
  process.stdout.write(`${c.dim}${divider}${c.reset}\n`);
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

// ── Providers ─────────────────────────────────────────────────────────────────

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
  const avgOverall = (key: 'scoreA' | 'scoreB' | 'scoreC') =>
    scored.length ? (scored.reduce((s, r) => s + r.overall[key], 0) / scored.length).toFixed(1) : 'N/A';

  let md = `# Benchmark: ${script.name} — ${date}\n\n`;
  md += `> ${script.description}\n\n`;
  md += `## Итоговое сравнение стратегий\n\n`;
  md += `| | Sliding Window | Sticky Facts | Branching |\n`;
  md += `|---|---|---|---|\n`;
  md += `| Avg overall score | ${avgOverall('scoreA')}/10 | ${avgOverall('scoreB')}/10 | ${avgOverall('scoreC')}/10 |\n`;
  md += `| Total prompt tokens | ${totalW.toLocaleString()} | ${totalF.toLocaleString()} | ${totalB.toLocaleString()} |\n`;

  if (totalB > 0) {
    const savW = ((1 - totalW / totalB) * 100).toFixed(1);
    const savF = ((1 - totalF / totalB) * 100).toFixed(1);
    md += `| vs Branching (baseline) | ${parseFloat(savW) > 0 ? '-' : '+'}${Math.abs(parseFloat(savW))}% токенов | ${parseFloat(savF) > 0 ? '-' : '+'}${Math.abs(parseFloat(savF))}% токенов | baseline |\n`;
  }
  md += '\n';

  for (let i = 0; i < resultsW.length; i++) {
    const w = resultsW[i];
    const f = resultsF[i];
    const b = resultsB[i];
    const judge = judgeResults[i];
    const shortQ = w.message.length > 70 ? w.message.slice(0, 70) + '…' : w.message;

    md += `---\n\n## Сообщение ${i + 1}: "${shortQ}"\n\n`;
    md += `**Sliding Window:**\n${w.response}\n\n`;
    md += `**Sticky Facts:**\n${f.response}\n\n`;
    md += `**Branching:**\n${b.response}\n\n`;

    md += `| Критерий | Window | Facts | Branch |\n`;
    md += `|---------|--------|-------|--------|\n`;
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

async function runScript(script: BenchScript, judge: Judge): Promise<void> {
  const agentProvider = createProvider();
  const contextWindow = getContextWindow();

  // Three agents, one per strategy
  const agentW = new Agent(agentProvider);
  agentW.setStrategy('window');

  const agentF = new Agent(agentProvider);
  agentF.setStrategy('facts');

  const agentB = new Agent(agentProvider);
  agentB.setStrategy('branch');

  const resultsW: MessageResult[] = [];
  const resultsF: MessageResult[] = [];
  const resultsB: MessageResult[] = [];
  const judgeResults: Array<ThreeWayJudgeResult | null> = [];
  const N = script.messages.length;

  let lastPromptW: number | null = null;
  let lastPromptF: number | null = null;
  let lastPromptB: number | null = null;

  for (let i = 0; i < N; i++) {
    const { text: msg, checkpoint: isCheckpoint } = parseMessage(script.messages[i]);
    const isLast = i === N - 1;

    printSeparator();
    const cpMark = isCheckpoint ? ` ${label('✓ checkpoint', c.bold + c.green)}` : '';
    console.log(`${label(`Сообщение ${i + 1}/${N}`, c.bold + c.dim)}${cpMark}`);
    console.log(`${label('you>', c.dim)} ${msg}\n`);

    // ── Run Window
    const stopW = startSpinner('window:  ');
    let headerW = false;
    let responseW = '';
    const usageW = await agentW.chat(msg, (chunk) => {
      if (!headerW) { headerW = true; stopW(); process.stdout.write(`${label('window:  ', c.bold + c.cyan)}\n`); }
      process.stdout.write(chunk);
      responseW += chunk;
    });
    if (!headerW) stopW();
    process.stdout.write('\n');
    printTokenStats('window', usageW, contextWindow, lastPromptW);
    lastPromptW = usageW?.prompt_tokens ?? null;
    process.stdout.write('\n');
    resultsW.push({ message: msg, response: responseW, promptTokens: usageW?.prompt_tokens ?? 0, completionTokens: usageW?.completion_tokens ?? 0 });

    // ── Run Facts
    const stopF = startSpinner('facts:   ');
    let headerF = false;
    let responseF = '';
    const usageF = await agentF.chat(msg, (chunk) => {
      if (!headerF) { headerF = true; stopF(); process.stdout.write(`${label('facts:   ', c.bold + c.yellow)}\n`); }
      process.stdout.write(chunk);
      responseF += chunk;
    });
    if (!headerF) stopF();
    process.stdout.write('\n');
    printTokenStats('facts', usageF, contextWindow, lastPromptF);
    lastPromptF = usageF?.prompt_tokens ?? null;
    process.stdout.write('\n');
    resultsF.push({ message: msg, response: responseF, promptTokens: usageF?.prompt_tokens ?? 0, completionTokens: usageF?.completion_tokens ?? 0 });

    // ── Run Branch
    const stopB = startSpinner('branch:  ');
    let headerB = false;
    let responseB = '';
    const usageB = await agentB.chat(msg, (chunk) => {
      if (!headerB) { headerB = true; stopB(); process.stdout.write(`${label('branch:  ', c.bold + c.magenta)}\n`); }
      process.stdout.write(chunk);
      responseB += chunk;
    });
    if (!headerB) stopB();
    process.stdout.write('\n');
    printTokenStats('branch', usageB, contextWindow, lastPromptB);
    lastPromptB = usageB?.prompt_tokens ?? null;
    process.stdout.write('\n');
    resultsB.push({ message: msg, response: responseB, promptTokens: usageB?.prompt_tokens ?? 0, completionTokens: usageB?.completion_tokens ?? 0 });

    // ── Judge at checkpoints
    if (!isCheckpoint && !isLast) {
      process.stdout.write(`${c.dim}[судья пропущен — не контрольная точка]${c.reset}\n\n`);
      judgeResults.push(null);
    } else {
      const stopJ = startSpinner('[судья]  ');
      let judgeResult: ThreeWayJudgeResult | null = null;
      try {
        judgeResult = await judge.evaluateThreeWay(msg, responseW, responseF, responseB, script.judgePrompt);
      } catch {
        // silently skip
      }
      stopJ();
      if (judgeResult) {
        printThreeWayTable(judgeResult, usageW?.prompt_tokens ?? 0, usageF?.prompt_tokens ?? 0, usageB?.prompt_tokens ?? 0);
      }
      judgeResults.push(judgeResult);
    }
  }

  // ── Summary
  const scored = judgeResults.filter((r): r is ThreeWayJudgeResult => r !== null);
  const totalW = resultsW.reduce((s, r) => s + r.promptTokens, 0);
  const totalF = resultsF.reduce((s, r) => s + r.promptTokens, 0);
  const totalB = resultsB.reduce((s, r) => s + r.promptTokens, 0);

  const width = Math.min(process.stdout.columns ?? 70, 70);
  process.stdout.write(`\n${c.bold}${'═'.repeat(width)}${c.reset}\n`);
  console.log(label(`Results: ${script.name}`, c.bold));

  if (scored.length) {
    const avgW = (scored.reduce((s, r) => s + r.overall.scoreA, 0) / scored.length).toFixed(1);
    const avgF = (scored.reduce((s, r) => s + r.overall.scoreB, 0) / scored.length).toFixed(1);
    const avgB = (scored.reduce((s, r) => s + r.overall.scoreC, 0) / scored.length).toFixed(1);
    console.log(`Quality:  window=${label(`${avgW}/10`, c.bold)}  facts=${label(`${avgF}/10`, c.bold)}  branch=${label(`${avgB}/10`, c.bold)}`);
  }
  const savW = totalB > 0 ? ((1 - totalW / totalB) * 100).toFixed(1) : '—';
  const savF = totalB > 0 ? ((1 - totalF / totalB) * 100).toFixed(1) : '—';
  console.log(`Tokens:   window=${label(totalW.toLocaleString(), c.bold)}  facts=${label(totalF.toLocaleString(), c.bold)}  branch=${label(totalB.toLocaleString(), c.bold)} (baseline)`);
  console.log(`Savings vs branch:  window=${label(`${savW}%`, c.bold)}  facts=${label(`${savF}%`, c.bold)}`);

  // ── Save report
  const report = buildReport(script, resultsW, resultsF, resultsB, judgeResults);
  const reportsDir = path.join(__dirname, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(reportsDir, `${date}-strategies-${script.name}.md`);
  await fs.writeFile(reportPath, report, 'utf-8');
  console.log(`Report:   ${label(reportPath, c.dim)}`);
  process.stdout.write(`${c.bold}${'═'.repeat(width)}${c.reset}\n`);
}

// ── Script picker ─────────────────────────────────────────────────────────────

async function loadScripts(scriptsDir: string): Promise<BenchScript[]> {
  const files = (await fs.readdir(scriptsDir)).filter(f => f.endsWith('.json'));
  const scripts: BenchScript[] = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(scriptsDir, file), 'utf-8');
    scripts.push(JSON.parse(raw));
  }
  return scripts;
}

function pickScript(rl: readline.Interface, scripts: BenchScript[]): Promise<BenchScript> {
  console.log('\nВыбери сценарий для сравнения стратегий:');
  scripts.forEach((s, i) => {
    const num  = label(`[${i + 1}]`, c.bold + c.cyan);
    const name = label(s.name, c.bold);
    const desc = label(`(${s.description})`, c.dim);
    console.log(`  ${num} ${name} ${desc}`);
  });

  return new Promise((resolve) => {
    const ask = () => {
      rl.question('> ', (input) => {
        const num = parseInt(input.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= scripts.length) {
          resolve(scripts[num - 1]);
          return;
        }
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

  if (arg) {
    const scriptPath = path.join(scriptsDir, `${arg}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(scriptPath, 'utf-8');
    } catch {
      console.error(`Script not found: ${scriptPath}`);
      process.exit(1);
    }
    await runScript(JSON.parse(raw), judgeProvider);
    return;
  }

  const scripts = await loadScripts(scriptsDir);
  if (scripts.length === 0) {
    console.error('No benchmark scripts found in bench/scripts/');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const selected = await pickScript(rl, scripts);
  rl.close();

  await runScript(selected, judge);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
