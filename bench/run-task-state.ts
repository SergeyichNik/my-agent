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
import { LLMProvider } from '../src/types';

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

const STAGE_COLORS: Record<string, string> = {
  idle:       c.dim,
  planning:   c.cyan,
  execution:  c.yellow,
  validation: c.magenta,
  done:       c.green,
  paused:     c.red,
};

function stageLabel(stage: string): string {
  const col = STAGE_COLORS[stage] ?? c.dim;
  return `${col}${c.bold}${stage}${c.reset}`;
}

// ── Scenario ──────────────────────────────────────────────────────────────────

interface ScenarioMessage {
  role: 'user' | 'assistant';
  content: string;
  _inject_pause_before?: boolean;
}

// ── Judge ─────────────────────────────────────────────────────────────────────

interface TaskStateScores {
  stageCorrectness:  number;
  pauseResume:       number;
  noDuplication:     number;
  invalidInput:      number;
  taskResultQuality: number;
  overall:           number;
  conclusion:        string;
}

const JUDGE_SYSTEM = `Ты строгий судья, оцениваешь агента с машиной состояний задачи (Task State Machine).

Агент получал сообщения по очереди и должен был:
1. Корректно переходить по стадиям: idle → planning → execution → validation → done
2. Оставаться в planning пока пользователь описывает требования; переходить в execution только после явной команды
3. Сохранить состояние при паузе и восстановить без повторного сбора требований
4. Не дублировать уже выполненные шаги
5. Отклонить невалидный запрос (пропустить стадии) — остаться в текущей стадии
6. Выдать качественную финальную спецификацию REST API

Оцени от 0 до 10 по каждому критерию:
- stageCorrectness: правильная последовательность idle→planning→execution→validation→done (вычти баллы если planning пропущен или execution наступил раньше явного запроса)
- pauseResume: состояние сохранено при паузе, восстановлено без лишних вопросов
- noDuplication: агент не повторяет уже пройденные шаги
- invalidInput: запрос пропустить стадии отклонён, агент остался в рабочем режиме
- taskResultQuality: полнота и корректность финального API spec (endpoints, методы, request/response)

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
    return `${i + 1}. [${m.role}${stageTag}]: ${m.content.slice(0, 400)}`;
  }).join('\n\n');

  const userPrompt = `История диалога (с зафиксированными стадиями агента после каждого хода):
${transcriptStr}

Последовательность стадий: ${stageHistory.join(' → ')}

Состояние при паузе (JSON):
${pauseStateJson}

Первый ответ после возобновления (resume):
${resumeResponse.slice(0, 600)}

Финальная спецификация API:
${finalSpec.slice(0, 1200)}`;

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
  const colW = 32;
  const scoreW = 8;
  const innerWidth = colW + scoreW + 4;

  const title = ' ◆ СУДЬЯ — TASK STATE MACHINE ';
  const titlePad = Math.max(0, innerWidth - title.length);
  process.stdout.write(`\n┌${c.bold}${c.magenta}${title}${c.reset}${c.dim}${'─'.repeat(titlePad)}┐${c.reset}\n`);

  const h = (s: string) => `${c.dim}${s.padStart(scoreW)}${c.reset}`;
  process.stdout.write(`${c.dim}│  ${'Критерий'.padEnd(colW)}│${h('Оценка')}│${c.reset}\n`);
  const div = `${c.dim}│  ${'─'.repeat(colW)}┼${'─'.repeat(scoreW)}┤${c.reset}`;
  process.stdout.write(div + '\n');

  const rows: [string, number][] = [
    ['Stage correctness (стадии)',     scores.stageCorrectness],
    ['Pause/Resume (сохранение)',      scores.pauseResume],
    ['No duplication (нет повторов)',  scores.noDuplication],
    ['Invalid input (отклонение)',     scores.invalidInput],
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

// ── Single turn ───────────────────────────────────────────────────────────────

async function runTurn(
  agent: Agent,
  content: string,
  turnIndex: number,
  total: number,
  transcript: Array<{ role: string; content: string; stage?: string }>,
  stageHistory: string[],
): Promise<string> {
  process.stdout.write(`${label(`[${turnIndex}/${total}] you:`, c.bold + c.dim)}\n${content}\n\n`);
  process.stdout.write(`${label('agent:', c.bold + c.cyan)}\n`);

  let response = '';
  try {
    await agent.chat(content, chunk => {
      response += chunk;
      process.stdout.write(chunk);
    });
    process.stdout.write('\n');
  } catch (err) {
    process.stdout.write('\n');
    console.error(`${label('✗', c.red)} ${err}`);
    return response;
  }

  const state = agent.taskStatus();
  stageHistory.push(state.stage);
  const stepStr = state.currentStep ? `  ${c.dim}step: ${state.currentStep.slice(0, 50)}${c.reset}` : '';
  process.stdout.write(`\n${c.dim}stage:${c.reset} ${stageLabel(state.stage)}${stepStr}\n`);

  transcript.push({ role: 'user', content });
  transcript.push({ role: 'assistant', content: response, stage: state.stage });

  return response;
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
  const userMessages = scenario.filter(m => m.role === 'user');

  // Create agent with memory strategy
  const agent = new Agent(provider, undefined, undefined, undefined);
  agent.setStrategy('memory', { sessionId });

  printSeparator();
  console.log(`${label('Scenario:', c.bold + c.yellow)} ${userMessages.length} messages — API design task\n`);

  const transcript: Array<{ role: string; content: string; stage?: string }> = [];
  const stageHistory: string[] = [];
  let pauseStateJson = '{}';
  let resumeResponse = '';
  let finalSpec = '';
  let turnIndex = 0;

  // Split scenario at the pause point into two phases
  const pauseIdx = scenario.findIndex(m => m._inject_pause_before);
  const phase1 = scenario.slice(0, pauseIdx === -1 ? scenario.length : pauseIdx);
  const phase2 = pauseIdx === -1 ? [] : scenario.slice(pauseIdx);

  // ── Phase 1: Agent 1 — run until pause ──────────────────────────────────────

  for (const msg of phase1) {
    if (msg.role !== 'user') continue;
    turnIndex++;
    printSeparator();
    await runTurn(agent, msg.content, turnIndex, userMessages.length, transcript, stageHistory);
  }

  if (phase2.length > 0) {
    // Pause agent 1 — saves state to disk
    agent.taskPause();
    const pausedState = agent.taskStatus();
    pauseStateJson = JSON.stringify(pausedState, null, 2);

    printSeparator();
    process.stdout.write(`${label('⏸  SESSION END (pause)', c.bold + c.yellow)}\n`);
    process.stdout.write(`${c.dim}Stage: ${pausedState.stage} | Step: ${pausedState.currentStep || '—'}${c.reset}\n`);
    process.stdout.write(`${c.dim}State persisted to disk (wm-state.json)${c.reset}\n`);

    // ── Phase 2: Agent 2 — fresh instance, reads WM from disk ─────────────────

    printSeparator();
    process.stdout.write(`${label('▶  NEW SESSION (resume from disk)', c.bold + c.green)}\n`);

    const agent2 = new Agent(provider, undefined, undefined, undefined);
    agent2.setStrategy('memory', { sessionId }); // MemoryStrategy auto-loads wm-state.json

    const restoredState = agent2.taskStatus();
    process.stdout.write(`${c.dim}Loaded stage: ${restoredState.stage} | Step: ${restoredState.currentStep || '—'}${c.reset}\n`);

    if (restoredState.stage !== 'paused') {
      process.stdout.write(`${label('⚠ WM not restored correctly', c.bold + c.red)}\n`);
    } else {
      agent2.taskResume();
      const resumed = agent2.taskStatus();
      process.stdout.write(`${c.dim}Resumed to stage: ${resumed.stage}${c.reset}\n`);
    }

    for (const msg of phase2) {
      if (msg.role !== 'user') continue;
      turnIndex++;
      printSeparator();
      const response = await runTurn(agent2, msg.content, turnIndex, userMessages.length, transcript, stageHistory);
      if (turnIndex === phase1.filter(m => m.role === 'user').length + 1) {
        resumeResponse = response;
      }
      if (turnIndex >= userMessages.length - 1) {
        finalSpec = response;
      }
    }
  } else {
    // No pause in scenario — capture final spec from last turns
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].role === 'assistant') { finalSpec = transcript[i].content; break; }
    }
  }

  // Final state summary
  const finalState = agent.taskStatus();
  stageHistory.push(finalState.stage);

  printSeparator();
  process.stdout.write(`${label('Stage progression:', c.bold + c.cyan)}\n`);
  process.stdout.write(stageHistory.map(s => stageLabel(s)).join(` ${c.dim}→${c.reset} `) + '\n');
  process.stdout.write(`\n${label('Final stage:', c.bold)} ${stageLabel(finalState.stage)}\n`);

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
  md += `## Transcript\n\n`;
  for (const m of transcript) {
    const stageTag = m.stage ? ` \`[${m.stage}]\`` : '';
    md += `**${m.role}**${stageTag}: ${m.content.slice(0, 500)}\n\n`;
  }
  md += `## Final API Spec\n\n${finalSpec}\n`;

  await fs.writeFile(reportPath, md);
  console.log(`\n${label('✓ Done', c.bold + c.green)} Report saved to ${reportPath}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
