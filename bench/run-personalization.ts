/**
 * run-personalization.ts — Personalization benchmark.
 *
 * Tests whether the MemoryStrategy correctly adapts responses
 * to different user profiles (alice vs bob).
 *
 * Phase 1: Build profiles via explicit preference statements
 * Phase 2: Ask identical questions, compare responses
 * Phase 3: Judge scores Style/Format/Tech/Differentiation
 *
 * Usage: npx ts-node bench/run-personalization.ts
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { config } from '../src/config';
import { Agent } from '../src/agent';
import { DeepSeekProvider } from '../src/providers/deepseek';
import { GeminiProvider } from '../src/providers/gemini';
import { LMStudioProvider } from '../src/providers/lmstudio';
import { ProfileManager } from '../src/profile/manager';
import { LLMProvider, UsageData, UserProfile } from '../src/types';
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

// Alice: дата-аналитик на Python, хочет только код без объяснений.
// Bob: студент, учит JavaScript, хочет подробные объяснения с примерами.
// ~5 messages each → Phase 1 ≈ 2 min parallel; 4 questions → Phase 2 ≈ 3 min → total ≈ 5 min.
const ALICE_SETUP = [
  'Я работаю с Python для анализа данных. Как читать CSV с помощью pandas?',
  'Окей, в следующий раз давай только код — без объяснений, пожалуйста',
  'Как сгруппировать данные по столбцу и посчитать среднее в pandas?',
  'Хорошо, именно так и держи — только сниппет, без комментариев',
  'Как отфильтровать строки в dataframe по условию на значение столбца?',
];

const BOB_SETUP = [
  'Я учу JavaScript и не понимаю как работают массивы. Можешь объяснить?',
  'Помогло! Можешь показать полный пример с комментариями к каждой строке?',
  'Что такое функция map()? Я лучше понимаю когда есть пошаговый разбор',
  'Отлично, именно такие подробные объяснения мне нужны — это помогает понять суть',
  'Как работает цикл forEach? Объясни с примером и аналогией из реальной жизни',
];

const TEST_QUESTIONS = [
  {
    question: 'Как отфильтровать элементы коллекции по условию?',
    criterion: 'язык (Python vs JavaScript), стиль (только код без слов vs объяснение + комментарии)',
  },
  {
    question: 'Как сделать HTTP запрос и получить тело ответа?',
    criterion: 'краткость Alice (только код) vs детальность Bob (шаги + пояснения)',
  },
  {
    question: 'Напиши функцию, которая находит максимальный элемент в списке',
    criterion: 'язык (Python vs JavaScript), комментарии (нет vs есть), объяснение (нет vs пошаговое)',
  },
  {
    question: 'Как обработать ошибки при выполнении кода?',
    criterion: 'язык (Python try/except vs JS try/catch), стиль (сниппет vs развёрнутое объяснение с примерами)',
  },
];

// ── Personalization Judge ─────────────────────────────────────────────────────

interface PersonalizationScores {
  styleMatch:      number; // 0-10: ответ соответствует стилю профиля
  formatMatch:     number; // 0-10: правильный формат ответа
  techMatch:       number; // 0-10: правильный язык/технологии
  differentiation: number; // 0-10: насколько ответы различаются
  personalizationScore: number; // среднее
  conclusion: string;
}

interface QuestionResult {
  question: string;
  aliceResponse: string;
  bobResponse: string;
  scores: PersonalizationScores | null;
}

const PERSONALIZATION_JUDGE_SYSTEM = `Ты судья, оцениваешь персонализацию ИИ-ассистента.
Два разных пользователя задали один и тот же вопрос. У каждого свой профиль.

Профиль Alice:
- Язык программирования: Python
- Стиль: только код, без объяснений и без комментариев
- Формат: минимальный — никаких вводных слов, сразу код

Профиль Bob:
- Язык программирования: JavaScript
- Стиль: подробный, пошаговые объяснения, аналогии
- Формат: код с комментариями к каждой строке, развёрнутый текст

Оцени по четырём критериям от 1 до 10:
- styleMatch: краткость Alice (код без слов) и детальность Bob (объяснения + аналогии) — насколько соблюдены
- formatMatch: Alice — код без комментариев; Bob — код с комментариями и текст вокруг
- techMatch: Alice использует Python, Bob использует JavaScript
- differentiation: насколько ответы вообще отличаются друг от друга (0 = идентичны, 10 = максимально разные)

Отвечай ТОЛЬКО валидным JSON без какого-либо другого текста:
{"styleMatch":N,"formatMatch":N,"techMatch":N,"differentiation":N,"conclusion":"одно предложение на русском"}`;

async function judgePersonalization(
  provider: LLMProvider,
  question: string,
  aliceResponse: string,
  bobResponse: string,
  criterion: string
): Promise<PersonalizationScores> {
  const userPrompt = `Критерий оценки: ${criterion}

Вопрос: ${question}

Ответ Alice:
${aliceResponse}

Ответ Bob:
${bobResponse}`;

  let raw = '';
  await provider.streamChat(
    [
      { role: 'system', content: PERSONALIZATION_JUDGE_SYSTEM },
      { role: 'user',   content: userPrompt },
    ],
    (chunk) => { raw += chunk; }
  );

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge returned non-JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);

  const styleMatch      = Number(parsed.styleMatch);
  const formatMatch     = Number(parsed.formatMatch);
  const techMatch       = Number(parsed.techMatch);
  const differentiation = Number(parsed.differentiation);
  const personalizationScore = parseFloat(((styleMatch + formatMatch + techMatch + differentiation) / 4).toFixed(1));

  return {
    styleMatch,
    formatMatch,
    techMatch,
    differentiation,
    personalizationScore,
    conclusion: String(parsed.conclusion ?? ''),
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

function createProvider(): LLMProvider {
  if (config.provider === 'gemini') return new GeminiProvider(config.gemini!);
  if (config.provider === 'lmstudio') return new LMStudioProvider(config.lmstudio!);
  return new DeepSeekProvider(config.deepseek!);
}

// ── Score display ─────────────────────────────────────────────────────────────

function scoreColor(n: number): string {
  if (n >= 8) return c.green;
  if (n >= 6) return c.yellow;
  return c.red;
}

function fmtScore(n: number, width: number): string {
  const col = scoreColor(n);
  const visible = `${n}/10`;
  return `${col}${visible.padStart(width)}${c.reset}`;
}

function printPersonalizationTable(scores: PersonalizationScores): void {
  const colW = 26;
  const scoreW = 10;
  const innerWidth = colW + scoreW + 4;

  const title = ' ◆ СУДЬЯ — ПЕРСОНАЛИЗАЦИЯ ';
  const titlePad = Math.max(0, innerWidth - title.length);
  process.stdout.write(`\n┌${c.bold}${c.yellow}${title}${c.reset}${c.dim}${'─'.repeat(titlePad)}┐${c.reset}\n`);

  const h = (s: string) => `${c.dim}${s.padStart(scoreW)}${c.reset}`;
  process.stdout.write(`${c.dim}│  ${'Критерий'.padEnd(colW)}│${h('Оценка')}│${c.reset}\n`);
  const div = `${c.dim}│  ${'─'.repeat(colW)}┼${'─'.repeat(scoreW)}┤${c.reset}`;
  process.stdout.write(div + '\n');

  const rows: [string, number][] = [
    ['Style Match (стиль)',    scores.styleMatch],
    ['Format Match (формат)', scores.formatMatch],
    ['Tech Match (язык/стек)', scores.techMatch],
    ['Differentiation',       scores.differentiation],
  ];

  for (const [name, score] of rows) {
    process.stdout.write(`${c.dim}│  ${c.reset}${name.padEnd(colW)}${c.dim}│${c.reset}${fmtScore(score, scoreW)}${c.dim}│${c.reset}\n`);
  }

  process.stdout.write(div + '\n');
  process.stdout.write(`${c.dim}│  ${c.reset}${c.bold}${'Personalization Score'.padEnd(colW)}${c.reset}${c.dim}│${c.reset}${fmtScore(scores.personalizationScore, scoreW)}${c.dim}│${c.reset}\n`);
  process.stdout.write(`${c.dim}└${'─'.repeat(innerWidth)}┘${c.reset}\n`);

  if (scores.conclusion) {
    process.stdout.write(`\n  ${c.bold}${c.yellow}Вывод:${c.reset} ${scores.conclusion}\n`);
  }
  process.stdout.write('\n');
}

// ── Report ────────────────────────────────────────────────────────────────────

function buildReport(results: QuestionResult[], aliceProfile: UserProfile, bobProfile: UserProfile): string {
  const date = new Date().toISOString().slice(0, 10);
  let md = `# Personalization Bench — ${date}\n\n`;
  md += `> Tests whether the agent adapts responses to different user profiles.\n\n`;
  md += `## Profiles\n\n`;
  md += `**Alice:** Python, code-only, no explanations, no comments\n`;
  md += `**Bob:** JavaScript, detailed step-by-step, code with comments\n\n`;

  const scored = results.filter(r => r.scores !== null);
  if (scored.length > 0) {
    const avg = (k: keyof PersonalizationScores) =>
      (scored.reduce((s, r) => s + Number(r.scores![k]), 0) / scored.length).toFixed(1);

    md += `## Summary\n\n`;
    md += `| Criterion | Avg Score |\n|---|---|\n`;
    md += `| Style Match | ${avg('styleMatch')}/10 |\n`;
    md += `| Format Match | ${avg('formatMatch')}/10 |\n`;
    md += `| Tech Match | ${avg('techMatch')}/10 |\n`;
    md += `| Differentiation | ${avg('differentiation')}/10 |\n`;
    md += `| **Personalization Score** | **${avg('personalizationScore')}/10** |\n\n`;
  }

  for (const r of results) {
    md += `---\n\n## ${r.question}\n\n`;
    md += `**Alice:**\n${r.aliceResponse}\n\n`;
    md += `**Bob:**\n${r.bobResponse}\n\n`;
    if (r.scores) {
      const s = r.scores;
      md += `| Style | Format | Tech | Differentiation | Score |\n|---|---|---|---|---|\n`;
      md += `| ${s.styleMatch}/10 | ${s.formatMatch}/10 | ${s.techMatch}/10 | ${s.differentiation}/10 | **${s.personalizationScore}/10** |\n`;
      if (s.conclusion) md += `\n*${s.conclusion}*\n`;
    }
    md += '\n';
  }

  return md;
}

// ── Agent factory ─────────────────────────────────────────────────────────────

function createAgent(provider: LLMProvider, userId: string): Agent {
  const agent = new Agent(provider, undefined, undefined, userId);
  agent.setStrategy('memory', { sessionId: `bench-persona-${userId}`, userId });
  return agent;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${label('◆ Personalization Benchmark', c.bold + c.cyan)} — alice vs bob\n`);
  console.log(`${c.dim}Tests profile-driven response adaptation using MemoryStrategy${c.reset}\n`);

  const memDir = path.join(__dirname, '../memory');
  const profilesDir = path.join(memDir, 'profiles');

  // Clear previous bench data for reproducibility
  await fs.mkdir(profilesDir, { recursive: true });
  for (const userId of ['alice', 'bob']) {
    await fs.unlink(path.join(profilesDir, `${userId}.json`)).catch(() => {});
    await fs.unlink(path.join(memDir, `${userId}-ltm.json`)).catch(() => {});
    await fs.unlink(path.join(memDir, `${userId}-ltm-log.jsonl`)).catch(() => {});
    await fs.unlink(path.join(memDir, `${userId}-wm-state.json`)).catch(() => {});
  }
  console.log(`${c.dim}Cleared previous bench profiles, LTM and WM.${c.reset}\n`);

  const provider = createProvider();
  const profileManager = new ProfileManager(profilesDir);

  // ── Phase 1: Build profiles ────────────────────────────────────────────────

  printSeparator();
  console.log(`${label('Phase 1', c.bold + c.magenta)}: Building user profiles\n`);

  const aliceAgent = createAgent(provider, 'alice');
  const bobAgent   = createAgent(provider, 'bob');

  const setupRenderer = new MultiColumnRenderer(['alice', 'bob'], [c.cyan, c.yellow]);

  await Promise.all([
    (async () => {
      for (const msg of ALICE_SETUP) {
        setupRenderer.append(0, `you: ${msg}\n`);
        await aliceAgent.chat(msg, chunk => setupRenderer.append(0, chunk));
        setupRenderer.append(0, '\n\n');
      }
      setupRenderer.markDone(0);
    })(),
    (async () => {
      for (const msg of BOB_SETUP) {
        setupRenderer.append(1, `you: ${msg}\n`);
        await bobAgent.chat(msg, chunk => setupRenderer.append(1, chunk));
        setupRenderer.append(1, '\n\n');
      }
      setupRenderer.markDone(1);
    })(),
  ]);

  setupRenderer.clear();

  const aliceProfile = profileManager.load('alice');
  const bobProfile   = profileManager.load('bob');

  console.log(`\n${label('◆ Profiles built:', c.bold + c.green)}`);
  console.log(`  alice: ${JSON.stringify(aliceProfile.preferences)} | lang: ${aliceProfile.constraints.preferredLanguage}`);
  console.log(`  bob:   ${JSON.stringify(bobProfile.preferences)} | lang: ${bobProfile.constraints.preferredLanguage}`);

  // ── Phase 2: Test questions ────────────────────────────────────────────────

  printSeparator();
  console.log(`${label('Phase 2', c.bold + c.magenta)}: Testing with identical questions\n`);
  console.log(`${c.dim}Tip: run ${c.reset}${c.bold}npm run watch-persona${c.reset}${c.dim} in a separate terminal to watch profiles live${c.reset}\n`);

  // Fresh session 2 agents — LTM/profile persists, history cleared
  const aliceAgent2 = createAgent(provider, 'alice');
  const bobAgent2   = createAgent(provider, 'bob');

  const results: QuestionResult[] = [];

  for (let i = 0; i < TEST_QUESTIONS.length; i++) {
    const { question, criterion } = TEST_QUESTIONS[i];
    printSeparator();
    console.log(`${label(`Q${i + 1}/${TEST_QUESTIONS.length}`, c.bold + c.yellow)} ${label(question, c.bold)}\n`);

    const colLabel = (user: string) => `${user}  [Q${i + 1}/${TEST_QUESTIONS.length}]`;
    const renderer = new MultiColumnRenderer(
      [colLabel('alice'), colLabel('bob')],
      [c.cyan, c.yellow]
    );
    const turnResult = {
      alice: '',
      bob: '',
      aliceUsage: null as UsageData | null,
      bobUsage: null as UsageData | null,
    };

    await Promise.all([
      (async () => {
        turnResult.aliceUsage = await aliceAgent2.chat(question, chunk => {
          turnResult.alice += chunk;
          renderer.append(0, chunk);
        });
        renderer.markDone(0, turnResult.aliceUsage?.completion_tokens ?? undefined);
      })(),
      (async () => {
        turnResult.bobUsage = await bobAgent2.chat(question, chunk => {
          turnResult.bob += chunk;
          renderer.append(1, chunk);
        });
        renderer.markDone(1, turnResult.bobUsage?.completion_tokens ?? undefined);
      })(),
    ]);

    renderer.clear();
    const aliceResponse = turnResult.alice;
    const bobResponse   = turnResult.bob;

    // Judge with spinner
    let scores: PersonalizationScores | null = null;
    const stopSpinner = startSpinner('Судья оценивает…');
    try {
      scores = await judgePersonalization(provider, question, aliceResponse, bobResponse, criterion);
      stopSpinner();
      printPersonalizationTable(scores);
    } catch (err) {
      stopSpinner();
      console.error(`${label('✗ Judge error:', c.red)} ${err}`);
    }

    results.push({ question, aliceResponse, bobResponse, scores });
  }

  // ── Phase 3: Report ────────────────────────────────────────────────────────

  printSeparator();

  const scored = results.filter(r => r.scores !== null);
  if (scored.length > 0) {
    const avg = (k: keyof PersonalizationScores) =>
      (scored.reduce((s, r) => s + Number(r.scores![k]), 0) / scored.length).toFixed(1);

    console.log(`${label('◆ Final Results', c.bold + c.cyan)}\n`);
    console.log(`  Style Match avg:       ${scoreColor(Number(avg('styleMatch')))}${avg('styleMatch')}/10${c.reset}`);
    console.log(`  Format Match avg:      ${scoreColor(Number(avg('formatMatch')))}${avg('formatMatch')}/10${c.reset}`);
    console.log(`  Tech Match avg:        ${scoreColor(Number(avg('techMatch')))}${avg('techMatch')}/10${c.reset}`);
    console.log(`  Differentiation avg:   ${scoreColor(Number(avg('differentiation')))}${avg('differentiation')}/10${c.reset}`);
    console.log(`  ${c.bold}Personalization Score: ${scoreColor(Number(avg('personalizationScore')))}${avg('personalizationScore')}/10${c.reset}\n`);
  }

  const reportDir = path.join(__dirname, 'reports');
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');
  const reportPath = path.join(reportDir, `personalization-${timestamp}.md`);
  const report = buildReport(results, aliceProfile, bobProfile);
  await fs.writeFile(reportPath, report);

  console.log(`${label('✓ Done', c.bold + c.green)} Report saved to ${reportPath}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
