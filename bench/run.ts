import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { config } from '../src/config';
import { Agent } from '../src/agent';
import { DeepSeekProvider } from '../src/providers/deepseek';
import { GeminiProvider } from '../src/providers/gemini';
import { LMStudioProvider } from '../src/providers/lmstudio';
import { LLMProvider, UsageData } from '../src/types';
import { Judge, JudgeResult } from './judge';

// ── Visual utilities ──────────────────────────────────────────────────────────

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
  const width = Math.min(process.stdout.columns ?? 60, 60);
  process.stdout.write(`\n${c.dim}${'─'.repeat(width)}${c.reset}\n\n`);
}

function printTokenStats(
  usage: UsageData | null,
  contextWindow: number | null,
  lastPromptTokens: number | null,
  sessionTotal: number
): void {
  if (!usage) return;

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

  process.stdout.write(
    `${c.dim}[tokens] prompt: ${usage.prompt_tokens} | completion: ${usage.completion_tokens} | total: ${usage.total_tokens}${ctxPart}${growthPart} | session: ${sessionTotal.toLocaleString()}${c.reset}\n`
  );
}

function printJudgeTable(judge: JudgeResult, promptTokensA: number, promptTokensB: number, sessionA: number, sessionB: number): void {
  const rows = [
    { name: 'Сохранение контекста', key: 'context' as const },
    { name: 'Качество ответа',      key: 'quality' as const },
    { name: 'Полнота',              key: 'completeness' as const },
  ];

  const colW = 22;
  const scoreW = 10;
  const divider = `  ${'─'.repeat(colW)}┼${'─'.repeat(scoreW)}┼${'─'.repeat(scoreW)}`;

  process.stdout.write(`\n${label('  [судья]', c.dim)}\n`);
  process.stdout.write(`${c.dim}  ${'Критерий'.padEnd(colW)}│${'Без сжатия'.padStart(scoreW)}│${'Со сжатием'.padStart(scoreW)}${c.reset}\n`);
  process.stdout.write(`${c.dim}${divider}${c.reset}\n`);

  for (const row of rows) {
    const scores = judge[row.key];
    const sA = `${scores.scoreA}/10`.padStart(scoreW);
    const sB = `${scores.scoreB}/10`.padStart(scoreW);
    process.stdout.write(`${c.dim}  ${row.name.padEnd(colW)}│${sA}│${sB}${c.reset}\n`);
  }

  process.stdout.write(`${c.dim}${divider}${c.reset}\n`);
  const oA = `${judge.overall.scoreA}/10`.padStart(scoreW);
  const oB = `${judge.overall.scoreB}/10`.padStart(scoreW);
  process.stdout.write(`  ${c.bold}${'Итог'.padEnd(colW)}${c.reset}${c.dim}│${oA}│${oB}${c.reset}\n`);

  process.stdout.write(`${c.dim}${divider}${c.reset}\n`);
  const tA = promptTokensA.toLocaleString().padStart(scoreW);
  const tB = promptTokensB.toLocaleString().padStart(scoreW);
  process.stdout.write(`${c.dim}  ${'prompt_tokens'.padEnd(colW)}│${tA}│${tB}${c.reset}\n`);

  const sA = sessionA.toLocaleString().padStart(scoreW);
  const sB = sessionB.toLocaleString().padStart(scoreW);
  process.stdout.write(`${c.dim}  ${'session (cumul.)'.padEnd(colW)}│${sA}│${sB}${c.reset}\n`);

  const savings = promptTokensA > 0
    ? ((1 - promptTokensB / promptTokensA) * 100).toFixed(1)
    : '0.0';
  const savingsStr = promptTokensA > 0
    ? (parseFloat(savings) >= 0 ? `-${savings}%` : `+${Math.abs(parseFloat(savings)).toFixed(1)}%`)
    : '—';
  const effA = '—'.padStart(scoreW);
  const effB = savingsStr.padStart(scoreW);
  process.stdout.write(`${c.dim}  ${'Экономия токенов'.padEnd(colW)}│${effA}│${effB}${c.reset}\n`);

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

function pickScripts(rl: readline.Interface, scripts: BenchScript[]): Promise<BenchScript[]> {
  console.log('\nBenchmark scripts:');
  scripts.forEach((s, i) => {
    const num  = label(`[${i + 1}]`, c.bold + c.cyan);
    const name = label(s.name, c.bold);
    const desc = label(`(${s.description})`, c.dim);
    console.log(`  ${num} ${name} ${desc}`);
  });
  console.log(`  ${label('[all]', c.bold + c.green)} ${label('Run all scripts', c.dim)}\n`);

  return new Promise((resolve) => {
    const ask = () => {
      rl.question('> ', (input) => {
        const trimmed = input.trim();
        if (trimmed === 'all') { resolve(scripts); return; }
        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 1 && num <= scripts.length) {
          resolve([scripts[num - 1]]);
          return;
        }
        console.log(`Enter 1–${scripts.length} or 'all'.`);
        ask();
      });
    };
    ask();
  });
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport(
  script: BenchScript,
  resultsA: MessageResult[],
  resultsB: MessageResult[],
  judgeResults: Array<JudgeResult | null>
): string {
  const date = new Date().toISOString().slice(0, 10);

  const totalPromptA = resultsA.reduce((s, r) => s + r.promptTokens, 0);
  const totalPromptB = resultsB.reduce((s, r) => s + r.promptTokens, 0);
  const savingsPct = totalPromptA > 0
    ? ((1 - totalPromptB / totalPromptA) * 100).toFixed(1) : '0.0';

  const scored = judgeResults.filter((r): r is JudgeResult => r !== null);
  const avgA = scored.length
    ? (scored.reduce((s, r) => s + r.overall.scoreA, 0) / scored.length).toFixed(1) : 'N/A';
  const avgB = scored.length
    ? (scored.reduce((s, r) => s + r.overall.scoreB, 0) / scored.length).toFixed(1) : 'N/A';

  let md = `# Benchmark: ${script.name} — ${date}\n\n`;
  md += `> ${script.description}\n\n`;
  md += `## Overall\n\n`;
  md += `| | Без сжатия | Со сжатием |\n`;
  md += `|---|---|---|\n`;
  md += `| Avg overall score | ${avgA}/10 | ${avgB}/10 |\n`;
  md += `| Total prompt tokens | ${totalPromptA.toLocaleString()} | ${totalPromptB.toLocaleString()} |\n`;
  md += `| Token savings | — | ${savingsPct}% ${parseFloat(savingsPct) > 0 ? '↓' : ''} |\n\n`;

  for (let i = 0; i < resultsA.length; i++) {
    const a = resultsA[i];
    const b = resultsB[i];
    const judge = judgeResults[i];
    const shortQ = a.message.length > 70 ? a.message.slice(0, 70) + '…' : a.message;

    md += `---\n\n## Message ${i + 1}: "${shortQ}"\n\n`;
    md += `**Без сжатия:**\n${a.response}\n\n`;
    md += `**Со сжатием:**\n${b.response}\n\n`;

    md += `| Критерий | Без сжатия | Со сжатием |\n`;
    md += `|---------|------------|------------|\n`;
    if (judge) {
      md += `| Сохранение контекста | ${judge.context.scoreA}/10 | ${judge.context.scoreB}/10 |\n`;
      md += `| Качество ответа | ${judge.quality.scoreA}/10 | ${judge.quality.scoreB}/10 |\n`;
      md += `| Полнота | ${judge.completeness.scoreA}/10 | ${judge.completeness.scoreB}/10 |\n`;
      md += `| **Итог** | **${judge.overall.scoreA}/10** | **${judge.overall.scoreB}/10** |\n`;
    }
    md += `| prompt\\_tokens | ${a.promptTokens.toLocaleString()} | ${b.promptTokens.toLocaleString()} |\n`;
    md += `| completion\\_tokens | ${a.completionTokens.toLocaleString()} | ${b.completionTokens.toLocaleString()} |\n`;
    if (judge?.conclusion) md += `\n*Вывод: ${judge.conclusion}*\n`;
    md += '\n';
  }

  return md;
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function runScript(script: BenchScript, judge: Judge): Promise<void> {
  const agentProvider = createProvider();
  const contextWindow = getContextWindow();

  const agentA = new Agent(agentProvider);
  if (agentA.isSummaryEnabled) agentA.toggleSummary();

  const agentB = new Agent(agentProvider);
  if (!agentB.isSummaryEnabled) agentB.toggleSummary();

  const resultsA: MessageResult[] = [];
  const resultsB: MessageResult[] = [];
  const judgeResults: Array<JudgeResult | null> = [];
  const N = script.messages.length;

  let lastPromptA: number | null = null;
  let lastPromptB: number | null = null;
  let sessionTotalA = 0;
  let sessionTotalB = 0;
  let summarizationTriggered = false;
  let summarizationMessageIndex = -1;

  for (let i = 0; i < N; i++) {
    const { text: msg, checkpoint: isCheckpoint } = parseMessage(script.messages[i]);
    const isLast = i === N - 1;

    printSeparator();
    const cpMark = isCheckpoint ? ` ${label('✓ checkpoint', c.bold + c.green)}` : '';
    console.log(`${label(`Message ${i + 1}/${N}`, c.bold + c.dim)}${cpMark}`);
    console.log(`${label('you>', c.dim)} ${msg}\n`);

    // ── Run A: no summary
    const stopA = startSpinner('no-summary:');
    let headerA = false;
    let responseA = '';
    const usageA = await agentA.chat(msg, (chunk) => {
      if (!headerA) {
        headerA = true;
        stopA();
        process.stdout.write(`${label('no-summary:', c.bold + c.cyan)}\n`);
      }
      process.stdout.write(chunk);
      responseA += chunk;
    });
    if (!headerA) stopA();
    process.stdout.write('\n');
    sessionTotalA += usageA?.total_tokens ?? 0;
    printTokenStats(usageA, contextWindow, lastPromptA, sessionTotalA);
    lastPromptA = usageA?.prompt_tokens ?? null;
    process.stdout.write('\n');

    resultsA.push({
      message: msg,
      response: responseA,
      promptTokens: usageA?.prompt_tokens ?? 0,
      completionTokens: usageA?.completion_tokens ?? 0,
    });

    // ── Run B: with summary
    const stopB = startSpinner('summary:   ');
    let headerB = false;
    let responseB = '';
    const usageB = await agentB.chat(msg, (chunk) => {
      if (!headerB) {
        headerB = true;
        stopB();
        process.stdout.write(`${label('summary:', c.bold + c.yellow)}\n`);
      }
      process.stdout.write(chunk);
      responseB += chunk;
    });
    if (!headerB) stopB();
    process.stdout.write('\n');
    sessionTotalB += usageB?.total_tokens ?? 0;
    printTokenStats(usageB, contextWindow, lastPromptB, sessionTotalB);
    lastPromptB = usageB?.prompt_tokens ?? null;
    process.stdout.write('\n');

    resultsB.push({
      message: msg,
      response: responseB,
      promptTokens: usageB?.prompt_tokens ?? 0,
      completionTokens: usageB?.completion_tokens ?? 0,
    });

    // ── Detect summarization trigger
    if (!summarizationTriggered && agentB.hasSummary) {
      summarizationTriggered = true;
      summarizationMessageIndex = i + 1;
      process.stdout.write(`${label('◆ Суммаризация сработала', c.bold + c.green)} — агент B теперь использует сжатый контекст\n\n`);
    }

    // ── Judge
    const shouldJudge = summarizationTriggered && (isCheckpoint || isLast);

    if (!summarizationTriggered) {
      process.stdout.write(`${c.dim}[судья пропущен — суммаризация ещё не сработала]${c.reset}\n\n`);
      judgeResults.push(null);
    } else if (!shouldJudge) {
      process.stdout.write(`${c.dim}[судья пропущен — не контрольная точка]${c.reset}\n\n`);
      judgeResults.push(null);
    } else {
      const stopJ = startSpinner('[судья]    ');
      let judgeResult: JudgeResult | null = null;
      try {
        judgeResult = await judge.evaluate(msg, responseA, responseB, script.judgePrompt);
      } catch {
        // silently skip
      }
      stopJ();

      if (judgeResult) {
        printJudgeTable(judgeResult, usageA?.prompt_tokens ?? 0, usageB?.prompt_tokens ?? 0, sessionTotalA, sessionTotalB);
      }

      judgeResults.push(judgeResult);
    }
  }

  // ── Summary
  const scored = judgeResults.filter((r): r is JudgeResult => r !== null);
  const totalA = resultsA.reduce((s, r) => s + r.promptTokens, 0);
  const totalB = resultsB.reduce((s, r) => s + r.promptTokens, 0);
  const savings = totalA > 0 ? ((1 - totalB / totalA) * 100).toFixed(1) : '0.0';

  const width = Math.min(process.stdout.columns ?? 60, 60);
  process.stdout.write(`\n${c.bold}${'═'.repeat(width)}${c.reset}\n`);
  console.log(label(`Results: ${script.name}`, c.bold));
  if (summarizationMessageIndex > 0) {
    console.log(`${c.dim}Судья активен с: сообщение ${summarizationMessageIndex}/${N}${c.reset}`);
  }
  if (scored.length) {
    const avgA = (scored.reduce((s, r) => s + r.overall.scoreA, 0) / scored.length).toFixed(1);
    const avgB = (scored.reduce((s, r) => s + r.overall.scoreB, 0) / scored.length).toFixed(1);
    console.log(`Quality:  no-summary=${label(`${avgA}/10`, c.bold)}  summary=${label(`${avgB}/10`, c.bold)}`);
  }
  console.log(`Tokens:   no-summary=${label(totalA.toLocaleString(), c.bold)}  summary=${label(totalB.toLocaleString(), c.bold)}  savings=${label(`${savings}%`, c.bold)}`);

  // ── Save report
  const report = buildReport(script, resultsA, resultsB, judgeResults);
  const reportsDir = path.join(__dirname, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(reportsDir, `${date}-${script.name}.md`);
  await fs.writeFile(reportPath, report, 'utf-8');
  console.log(`Report:   ${label(reportPath, c.dim)}`);
  process.stdout.write(`${c.bold}${'═'.repeat(width)}${c.reset}\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  const scriptsDir = path.join(__dirname, 'scripts');

  const judge = Judge.create();

  if (arg && arg !== 'all') {
    const scriptPath = path.join(scriptsDir, `${arg}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(scriptPath, 'utf-8');
    } catch {
      console.error(`Script not found: ${scriptPath}`);
      process.exit(1);
    }
    await runScript(JSON.parse(raw), judge);
    return;
  }

  const scripts = await loadScripts(scriptsDir);
  if (scripts.length === 0) {
    console.error('No benchmark scripts found in bench/scripts/');
    process.exit(1);
  }

  let selected: BenchScript[];

  if (arg === 'all') {
    selected = scripts;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    selected = await pickScripts(rl, scripts);
    rl.close();
  }

  for (const script of selected) {
    await runScript(script, judge);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
