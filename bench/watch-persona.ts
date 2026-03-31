/**
 * watch-persona.ts — Live personalization inspector.
 * Run in a separate terminal while bench:personalization is active:
 *   npm run watch-persona
 *
 * Shows real-time updates to:
 *   - alice and bob profiles (side-by-side)
 *   - Shared LTM entries
 *   - Working memory state
 */

import * as fs from 'fs';
import * as path from 'path';
import { LTMEntry, UserProfile, WorkingMemory } from '../src/types';

const MEMORY_DIR  = path.join(__dirname, '../memory');
const PROFILES_DIR = path.join(MEMORY_DIR, 'profiles');
const LTM_PATH    = path.join(MEMORY_DIR, 'ltm.json');
const LOG_PATH    = path.join(MEMORY_DIR, 'ltm-log.jsonl');
const WM_PATH     = path.join(MEMORY_DIR, 'wm-state.json');

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

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function readLTMLog(logPath: string): LTMEntry[] {
  try {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l) as LTMEntry);
  } catch {
    return [];
  }
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}

// ── Profile rendering ─────────────────────────────────────────────────────────

function profileLines(profile: UserProfile | null, userId: string): string[] {
  if (!profile) return ['(no profile yet)'];
  const p = profile.preferences;
  const f = profile.format;
  const con = profile.constraints;
  const lines: string[] = [];

  if (p.style)       lines.push(`style: ${p.style}`);
  if (p.tone)        lines.push(`tone: ${p.tone}`);
  if (p.verbosity)   lines.push(`verbosity: ${p.verbosity}`);
  if (f.codeStyle)   lines.push(`code: ${f.codeStyle}`);
  if (f.responseStructure) lines.push(`format: ${f.responseStructure}`);
  if (con.preferredLanguage) lines.push(`lang: ${con.preferredLanguage}`);
  for (const d of con.doNot) lines.push(`✗ ${d}`);
  for (const m of con.must)  lines.push(`✓ ${m}`);
  if (profile.updatedAt) lines.push(`updated: ${formatTime(profile.updatedAt)}`);
  if (lines.length === 0) lines.push('(empty — no preferences set yet)');
  return lines;
}

const PROFILE_COLORS = [c.cyan, c.yellow, c.green, c.magenta, c.red];

function renderProfiles(profiles: Array<{ userId: string; profile: UserProfile | null }>): number {
  if (profiles.length === 0) {
    process.stdout.write(`${c.dim}  (no profiles yet — start a session with --user <name>)${c.reset}\n`);
    return 1;
  }

  const termWidth = process.stdout.columns || 120;
  const n = profiles.length;
  const colWidth = Math.max(20, Math.floor((termWidth - n - 1) / n));
  const inner = colWidth - 2;

  const lines: string[] = [];

  // Top border with user names
  const topParts = profiles.map(({ userId }, i) => {
    const col = PROFILE_COLORS[i % PROFILE_COLORS.length];
    const header = ` ${userId} `;
    const trail = Math.max(0, colWidth - header.length - 1);
    return `${c.bold}${col}${header}${c.reset}${c.dim}${'─'.repeat(trail)}${c.reset}`;
  });
  lines.push(`┌${topParts.join('┬')}┐`);

  // Content rows
  const cols = profiles.map(({ userId, profile }) => profileLines(profile, userId));
  const maxRows = Math.max(...cols.map(c => c.length));

  for (let row = 0; row < maxRows; row++) {
    const cells = cols.map((col, i) => {
      const color = PROFILE_COLORS[i % PROFILE_COLORS.length];
      const text = (col[row] ?? '').slice(0, inner);
      return `${c.dim}│${c.reset} ${color}${text.padEnd(inner)}${c.reset}`;
    });
    lines.push(`${cells.join('')}${c.dim}│${c.reset}`);
  }

  // Bottom border
  const botParts = Array(n).fill('─'.repeat(colWidth));
  lines.push(`${c.dim}└${botParts.join('┴')}┘${c.reset}`);

  for (const line of lines) process.stdout.write(line + '\n');
  return lines.length;
}

// ── LTM rendering ─────────────────────────────────────────────────────────────

function renderLTM(log: LTMEntry[], allEntries: LTMEntry[]): number {
  const termWidth = process.stdout.columns || 80;
  const boxWidth = Math.min(termWidth - 2, 80);
  const inner = boxWidth - 4;
  let lineCount = 0;

  const title = `LONG-TERM MEMORY (${allEntries.length} entries)`;
  const topBar = `┌─ ${c.bold}${c.cyan}${title}${c.reset}${c.dim} ${'─'.repeat(Math.max(0, boxWidth - title.length - 4))}${c.reset}`;
  process.stdout.write(topBar + '\n'); lineCount++;

  if (allEntries.length === 0) {
    process.stdout.write(`${c.dim}│  (empty — no facts stored yet)${c.reset}\n`); lineCount++;
  } else {
    const recent = log.slice(-8);
    for (const entry of recent) {
      const time = formatTime(entry.addedAt);
      const src = entry.source ? ` ${c.magenta}[${entry.source}]${c.reset}` : '';
      const content = entry.content.slice(0, inner - 22);
      process.stdout.write(`${c.dim}│  ${c.reset}${c.green}+${c.reset} ${c.dim}[${time}]${c.reset}${src} ${content}\n`);
      lineCount++;
    }
    if (log.length > 8) {
      process.stdout.write(`${c.dim}│  … and ${log.length - 8} older entries${c.reset}\n`); lineCount++;
    }
  }

  process.stdout.write(`${c.dim}└${'─'.repeat(boxWidth - 1)}${c.reset}\n`); lineCount++;
  return lineCount;
}

// ── WM rendering ──────────────────────────────────────────────────────────────

const EMPTY_WM: WorkingMemory = { goal: '', steps: [], constraints: [], entities: [] };

function renderWM(wm: WorkingMemory): number {
  const termWidth = process.stdout.columns || 80;
  const boxWidth = Math.min(termWidth - 2, 80);
  const inner = boxWidth - 4;
  let lineCount = 0;

  const title = 'WORKING MEMORY';
  process.stdout.write(`┌─ ${c.bold}${c.yellow}${title}${c.reset}${c.dim} ${'─'.repeat(Math.max(0, boxWidth - title.length - 4))}${c.reset}\n`);
  lineCount++;

  const hasContent = wm.goal || wm.steps.length || wm.constraints.length || wm.entities.length;
  if (!hasContent) {
    process.stdout.write(`${c.dim}│  (empty — no active task)${c.reset}\n`); lineCount++;
  } else {
    const row = (label: string, value: string | string[]) => {
      if (Array.isArray(value)) {
        if (value.length === 0) return;
        process.stdout.write(`${c.dim}│  ${c.reset}${c.bold}${label}:${c.reset}\n`); lineCount++;
        value.forEach((v, i) => {
          process.stdout.write(`${c.dim}│  ${c.reset}   [${i + 1}] ${v.slice(0, inner - 6)}\n`); lineCount++;
        });
      } else {
        if (!value) return;
        process.stdout.write(`${c.dim}│  ${c.reset}${c.bold}${label}:${c.reset} ${value.slice(0, inner)}\n`); lineCount++;
      }
    };
    row('Goal', wm.goal);
    row('Steps', wm.steps);
    row('Constraints', wm.constraints);
    row('Entities', wm.entities);
  }

  process.stdout.write(`${c.dim}└${'─'.repeat(boxWidth - 1)}${c.reset}\n`); lineCount++;
  return lineCount;
}

// ── Full render ───────────────────────────────────────────────────────────────

function loadProfiles(): Array<{ userId: string; profile: UserProfile | null }> {
  try {
    const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const userId = path.basename(f, '.json');
      const profile = readJSON<UserProfile | null>(path.join(PROFILES_DIR, f), null);
      return { userId, profile };
    });
  } catch {
    return [];
  }
}

function render(prevLineCount: number): number {
  const profiles = loadProfiles();
  const allLTM   = readJSON<LTMEntry[]>(LTM_PATH, []);
  const rawWM    = readJSON<Partial<WorkingMemory>>(WM_PATH, {});
  const wm: WorkingMemory = { ...EMPTY_WM, ...rawWM };
  const log      = readLTMLog(LOG_PATH);

  // Capture output for line counting
  const captured: string[] = [];
  const origWrite = (process.stdout.write as Function).bind(process.stdout);
  (process.stdout as any).write = (s: string) => { captured.push(s); return true; };

  const profileTitle = ' ◆ USER PROFILES ';
  process.stdout.write(`\n${c.bold}${c.magenta}${profileTitle}${c.reset}\n`);
  renderProfiles(profiles);
  process.stdout.write('\n');
  renderLTM(log, allLTM);
  process.stdout.write('\n');
  renderWM(wm);
  process.stdout.write(`\n${c.dim}Watching ${MEMORY_DIR} — Ctrl+C to stop${c.reset}\n`);

  (process.stdout as any).write = origWrite;

  // Erase previous render
  if (prevLineCount > 0) {
    process.stdout.write(`\x1b[${prevLineCount}A`);
    for (let i = 0; i < prevLineCount; i++) {
      process.stdout.write('\x1b[2K\n');
    }
    process.stdout.write(`\x1b[${prevLineCount}A`);
  }

  const fullOutput = captured.join('');
  const lineCount = (fullOutput.match(/\n/g) || []).length;
  process.stdout.write(fullOutput);

  return lineCount;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });

  console.log(`${c.bold}${c.cyan}Persona Inspector${c.reset} — watching ${PROFILES_DIR} + LTM + WM\n`);

  let prevLineCount = 0;
  prevLineCount = render(0);

  let lastMtime: Record<string, number> = {};
  const poll = setInterval(() => {
    // Always include fixed paths + dynamically discovered profile files
    const dynamicPaths: string[] = [LTM_PATH, LOG_PATH, WM_PATH];
    try {
      fs.readdirSync(PROFILES_DIR)
        .filter(f => f.endsWith('.json'))
        .forEach(f => dynamicPaths.push(path.join(PROFILES_DIR, f)));
    } catch { /* profiles dir may not exist yet */ }

    let changed = false;
    for (const f of dynamicPaths) {
      try {
        const stat = fs.statSync(f);
        const prev = lastMtime[f] ?? 0;
        if (stat.mtimeMs > prev) {
          lastMtime[f] = stat.mtimeMs;
          changed = true;
        }
      } catch {
        // file doesn't exist yet
      }
    }
    if (changed) {
      prevLineCount = render(prevLineCount);
    }
  }, 500);

  process.on('SIGINT', () => {
    clearInterval(poll);
    process.stdout.write('\n');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
