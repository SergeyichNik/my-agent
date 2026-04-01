/**
 * run-task-state.ts — Task State Machine benchmark.
 *
 * Runs a multi-step API design scenario through the agent and evaluates:
 * 1. Stage correctness (idle→planning→execution→validation→done)
 * 2. Pause/Resume preservation (state saved and restored without re-explanation)
 * 3. No step duplication (agent doesn't repeat completed work)
 * 4. Invalid input handling (agent stays in correct stage on bad jump request)
 * 5. Task result quality (final API spec completeness)
 *
 * Usage: npx ts-node bench/run-task-state.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../src/config';
import { Agent } from '../src/agent';
import { DeepSeekProvider } from '../src/providers/deepseek';
import { LMStudioProvider } from '../src/providers/lmstudio';
import { LLMProvider, TaskStage, WorkingMemory } from '../src/types';

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

function startSpinner(msg: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const render = () =>
    process.stdout.write(`\r${c.bold}${c.yellow}${frames[i++ % frames.length]}${c.reset} ${msg}`);
  render();
  const timer = setInterval(render, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write('\x1b[2K\r');
  };
}

// ── Scenario ──────────────────────────────────────────────────────────────────

interface ScenarioMessage {
  role: 'user' | 'assistant';
  content: string;
  _inject_pause_before?: boolean;
}

// ── Judge ─────────────────────────────────────────────────────────────────────

interface TaskStateScores {
  stageCorrectness:   number; // 0-10: stages progressed in correct order
  pauseResume:        number; // 0-10: state preserved across pause/resume
  noDuplication:      number; // 0-10: no repeated completed steps
  invalidInput:       number; // 0-10: agent stayed in correct stage on bad jump
  taskResultQuality:  number; // 0-10: final API spec completeness
  overall:            number;
  conclusion:         string;
}

const JUDGE_SYSTEM = `Ты строгий судья, оцениваешь агента с машиной состояний задачи (Task State Machine).

Агент получал сообщения по очереди и должен был:
1. Корректно переходить по стадиям: idle → planning → execution → validation → done
2. Сохранить состояние при паузе и восстановить его при возобновлении без повторного сбора требований
3. Не дублировать уже выполненные шаги
4. Правильно обработать невалидный запрос (пропустить стадии, уйти в продакшн) — остаться в текущей стадии
5. Выдать качественную финальную спецификацию REST API (endpoints, методы, тела запросов/ответов)

Оцени от 0 до 10 по каждому критерию:
- stageCorrectness: правильная последовательность стадий
- pauseResume: корректное восстановление без повторения уже выясненного
- noDuplication: агент не повторяет уже пройденные шаги
- invalidInput: агент отклонил запрос пропустить стадии и остался в рабочем режиме
- taskResultQuality: полнота и корректность финального API spec

Отвечай ТОЛЬКО валидным JSON:
{"stageCorrectness":N,"pauseResume":N,"noDuplication":N,"invalidInput":N,"taskResultQuality":N,"overall":N,"conclusion":"одно предложение на русском"}`;

async function judgeTaskState(
  provider: LLMProvider,
  transcript: Array<{ role: string; content: string; stage?: string }>,
  stageHistory: string[],
  finalSpec: string,
  pauseStateJson: string,
  resumeResponse: string,
): Promise<TaskStateScores> {
  const transcriptStr = transcript.map((m, i) => {
    const stageTag = m.stage ? ` [stage: ${m.stage}]` : '';
    return `${i + 1}. [${m.role}${stageTag}]: ${m.content.slice(0, 300)}`;
  }).join('\n\n');

  const userPrompt = `История диалога (с зафиксированными стадиями агента):
${transcriptStr}

Последовательность стадий (зафиксировано после каждого хода): ${stageHistory.join(' → ')}

Состояние при паузе (JSON):
${pauseStateJson}

Первый ответ после возобновления (resume):
${resumeResponse.slice(0, 500)}

Финальная спецификация API:
${finalSpec.slice(0, 1000)}`;

  let raw = '';
  await provider.streamChat(
    [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    (chunk) => { raw += chunk; }
  );

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge returned non-JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);

  return {
    stageCorrectness:  Number(parsed.stageCorrectness),
    pauseResume:       Number(parsed.pauseResume),
    noDuplication:     Number(parsed.noDuplication),
    invalidInput:      Number(parsed.invalidInput),
    taskResultQuality: Number(parsed.taskResultQuality),
    overall:           Number(parsed.overall),
    conclusion:        String(parsed.conclusion ?? ''),
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

function createProvider(): LLMProvider {
  if (config.provider === 'lmstudio') return new LMStudioProvider(config.lmstudio!);
  return new DeepSeekProvider(config.deepseek!);
}

// ── Score display ─────────────────────────────────────────────────────────────

function scoreColor(n: number): string {
  if (n >= 8) return c.green;
  if (n >= 6) return c.yellow;
  return c.red;
}

function printScoreTable(scores: TaskStateScores): void {
  const colW = 30;
  const scoreW = 10;
  const innerWidth = colW + scoreW + 4;

  const title = ' ◆ СУДЬЯ — TASK STATE MACHINE ';
  const titlePad = Math.max(0, innerWidth - title.length);
  process.stdout.write(`\n┌${c.bold}${c.magenta}${title}${c.reset}${c.dim}${'─'.repeat(titlePad)}┐${c.reset}\n`);

  const h = (s: string) => `${c.dim}${s.padStart(scoreW)}${c.reset}`;
  process.stdout.write(`${c.dim}│  ${'Критерий'.padEnd(colW)}│${h('Оценка')}│${c.reset}\n`);
  const div = `${c.dim}│  ${'─'.repeat(colW)}┼${'─'.repeat(scoreW)}┤${c.reset}`;
  process.stdout.write(div + '\n');

  const rows: [string, number][] = [
    ['Stage correctness (стадии)',    scores.stageCorrectness],
    ['Pause/Resume (сохранение)',     scores.pauseResume],
    ['No duplication (нет повторов)', scores.noDuplication],
    ['Invalid input (отклонение)',    scores.invalidInput],
    ['Task result quality (качество)', scores.taskResultQuality],
  ];

  for (const [name, score] of rows) {
    const scoreStr = `${score}/10`;
    const col = scoreColor(score);
    process.stdout.write(
      `${c.dim}│  ${c.reset}${name.padEnd(colW)}${c.dim}│${c.reset}${col}${scoreStr.padStart(scoreW)}${c.reset}${c.dim}│${c.reset}\n`
    );
  }

  process.stdout.write(div + '\n');
  const overallStr = `${scores.overall}/10`;
  const overallCol = scoreColor(scores.overall);
  process.stdout.write(
    `${c.dim}│  ${c.reset}${c.bold}${'Overall'.padEnd(colW)}${c.reset}${c.dim}│${c.reset}${overallCol}${c.bold}${overallStr.padStart(scoreW)}${c.reset}${c.dim}│${c.reset}\n`
  );
  process.stdout.write(`${c.dim}└${'─'.repeat(innerWidth)}┘${c.reset}\n`);

  if (scores.conclusion) {
    process.stdout.write(`\n  ${c.bold}${c.yellow}Вывод:${c.reset} ${scores.conclusion}\n`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${label('◆ Task State Machine Benchmark', c.bold + c.cyan)}\n`);
  console.log(`${c.dim}Tests FSM stage transitions, pause/resume, invalid input handling, and result quality.${c.reset}\n`);

  const provider = createProvider();
  const memDir = path.join(__dirname, '../memory');
  const sessionId = 'bench-task-state';

  // Clear previous bench data
  await fs.mkdir(memDir, { recursive: true });
  for (const f of [`${sessionId}-ltm.json`, `${sessionId}-ltm-log.jsonl`, `${sessionId}-wm-state.json`]) {
    await fs.unlink(path.join(memDir, f)).catch(() => {});
  }
  console.log(`${c.dim}Cleared previous bench state.${c.reset}\n`);

  // Load scenario
  const scenarioPath = path.join(__dirname, 'scripts/api-design.json');
  const scenario: ScenarioMessage[] = JSON.parse(await fs.readFile(scenarioPath, 'utf-8'));

  // Create agent with memory strategy
  const agent = new Agent(provider, undefined, undefined, undefined);
  agent.setStrategy('memory', { sessionId });

  // Run scenario
  printSeparator();
  console.log(`${label('Running scenario:', c.bold + c.yellow)} ${scenario.filter(m => m.role === 'user').length} user messages\n`);

  const transcript: Array<{ role: string; content: string; stage?: string }> = [];
  const stageHistory: string[] = [];
  let pauseStateJson = '{}';
  let resumeResponse = '';
  let finalSpec = '';
  let pauseInjected = false;
  let postPauseCount = 0;

  for (let i = 0; i < scenario.length; i++) {
    const msg = scenario[i];
    if (msg.role !== 'user') continue;

    // Inject pause before this message if flagged
    if (msg._inject_pause_before && !pauseInjected) {
      agent.taskPause();
      const state = agent.taskStatus();
      pauseStateJson = JSON.stringify(state, null, 2);
      console.log(`\n${label('⏸ Task PAUSED', c.bold + c.yellow)} — stage: ${state.stage}, step: ${state.currentStep}`);
      console.log(`${c.dim}State saved: ${pauseStateJson}${c.reset}\n`);

      // Resume immediately (simulating a new session start)
      agent.taskResume();
      const resumed = agent.taskStatus();
      console.log(`${label('▶ Task RESUMED', c.bold + c.green)} — stage: ${resumed.stage}\n`);
      pauseInjected = true;
    }

    const msgLabel = `[${i + 1}/${scenario.length}] ${msg.content.slice(0, 60)}${msg.content.length > 60 ? '…' : ''}`;
    const stopSpinner = startSpinner(msgLabel);

    let response = '';
    try {
      await agent.chat(msg.content, chunk => { response += chunk; });
      stopSpinner();
    } catch (err) {
      stopSpinner();
      console.error(`${label('✗', c.red)} ${err}`);
      continue;
    }

    const state = agent.taskStatus();
    stageHistory.push(state.stage);

    console.log(`${c.dim}[${i + 1}]${c.reset} ${c.bold}you:${c.reset} ${msg.content.slice(0, 80)}`);
    console.log(`     ${c.dim}stage: ${state.stage} | step: ${(state.currentStep || '—').slice(0, 50)}${c.reset}`);
    console.log(`     ${c.cyan}agent:${c.reset} ${response.slice(0, 120)}${response.length > 120 ? '…' : ''}\n`);

    transcript.push({ role: 'user', content: msg.content });
    transcript.push({ role: 'assistant', content: response, stage: state.stage });

    // Capture resume response (first message after pause)
    if (pauseInjected && postPauseCount === 0) {
      resumeResponse = response;
      postPauseCount++;
    }

    // Capture final spec (last message)
    if (i === scenario.length - 1 || (scenario[i + 1] && scenario[i + 1].role !== 'user')) {
      finalSpec = response;
    }
    // Also capture second-to-last as potential spec
    if (i === scenario.length - 2) {
      finalSpec = response;
    }
  }

  // Get final state
  const finalState = agent.taskStatus();
  stageHistory.push(finalState.stage);

  console.log(`\n${label('◆ Stage progression:', c.bold + c.cyan)} ${stageHistory.join(' → ')}`);
  console.log(`${label('◆ Final stage:', c.bold + c.cyan)} ${label(finalState.stage, c.bold)}\n`);

  // Judge
  printSeparator();
  const stopJudge = startSpinner('Судья оценивает результаты…');
  let scores: TaskStateScores | null = null;
  try {
    scores = await judgeTaskState(provider, transcript, stageHistory, finalSpec, pauseStateJson, resumeResponse);
    stopJudge();
    printScoreTable(scores);
  } catch (err) {
    stopJudge();
    console.error(`${label('✗ Judge error:', c.red)} ${err}`);
  }

  // Report
  printSeparator();
  const reportDir = path.join(__dirname, 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');
  const reportPath = path.join(reportDir, `task-state-${timestamp}.md`);

  const date = new Date().toISOString().slice(0, 10);
  let md = `# Task State Machine Bench — ${date}\n\n`;
  md += `## Stage Progression\n\`${stageHistory.join(' → ')}\`\n\n`;
  md += `## Pause State\n\`\`\`json\n${pauseStateJson}\n\`\`\`\n\n`;
  if (scores) {
    md += `## Scores\n\n`;
    md += `| Criterion | Score |\n|---|---|\n`;
    md += `| Stage correctness | ${scores.stageCorrectness}/10 |\n`;
    md += `| Pause/Resume | ${scores.pauseResume}/10 |\n`;
    md += `| No duplication | ${scores.noDuplication}/10 |\n`;
    md += `| Invalid input | ${scores.invalidInput}/10 |\n`;
    md += `| Task result quality | ${scores.taskResultQuality}/10 |\n`;
    md += `| **Overall** | **${scores.overall}/10** |\n\n`;
    md += `*${scores.conclusion}*\n\n`;
  }
  md += `## Final API Spec\n\n${finalSpec}\n`;

  await fs.writeFile(reportPath, md);
  console.log(`${label('✓ Done', c.bold + c.green)} Report saved to ${reportPath}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
