/**
 * watch-memory.ts — Live memory layer inspector.
 * Run in a separate terminal while the agent is active:
 *   npx ts-node bench/watch-memory.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { LTMEntry, WorkingMemory } from '../src/types';

const MEMORY_DIR = path.join(__dirname, '../memory');
const LTM_PATH     = path.join(MEMORY_DIR, 'ltm.json');
const LOG_PATH     = path.join(MEMORY_DIR, 'ltm-log.jsonl');
const WM_PATH      = path.join(MEMORY_DIR, 'wm-state.json');

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  yellow:  '\x1b[33m',
  green:   '\x1b[32m',
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
  blue:    '\x1b[34m',
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
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function renderWM(wm: WorkingMemory): void {
  const termWidth = process.stdout.columns || 80;
  const boxWidth = Math.min(termWidth - 2, 70);
  const inner = boxWidth - 4;

  const title = 'WORKING MEMORY';
  const topBar = `┌─ ${c.bold}${c.yellow}${title}${c.reset}${c.dim} ${'─'.repeat(boxWidth - title.length - 4)}${c.reset}`;
  process.stdout.write(topBar + '\n');

  const line = (label: string, value: string | string[]) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      process.stdout.write(`${c.dim}│  ${c.reset}${c.bold}${label}:${c.reset}\n`);
      value.forEach((v, i) => {
        const text = `   [${i + 1}] ${v}`;
        process.stdout.write(`${c.dim}│  ${c.reset}${text.slice(0, inner)}\n`);
      });
    } else {
      if (!value) return;
      const text = `${c.bold}${label}:${c.reset} ${value}`;
      process.stdout.write(`${c.dim}│  ${c.reset}${text.slice(0, inner + 10)}\n`);
    }
  };

  const hasContent = wm.goal || wm.steps.length || wm.constraints.length || wm.entities.length;
  if (!hasContent) {
    process.stdout.write(`${c.dim}│  (empty — no active task)${c.reset}\n`);
  } else {
    line('Goal', wm.goal);
    line('Steps', wm.steps);
    line('Constraints', wm.constraints);
    line('Entities', wm.entities);
  }

  process.stdout.write(`${c.dim}└${'─'.repeat(boxWidth - 1)}${c.reset}\n`);
}

function renderLTM(log: LTMEntry[], allEntries: LTMEntry[]): void {
  const termWidth = process.stdout.columns || 80;
  const boxWidth = Math.min(termWidth - 2, 70);
  const inner = boxWidth - 4;

  const title = `LONG-TERM MEMORY (${allEntries.length} entries)`;
  const topBar = `┌─ ${c.bold}${c.cyan}${title}${c.reset}${c.dim} ${'─'.repeat(Math.max(0, boxWidth - title.length - 4))}${c.reset}`;
  process.stdout.write(topBar + '\n');

  if (allEntries.length === 0) {
    process.stdout.write(`${c.dim}│  (empty — no facts stored yet)${c.reset}\n`);
  } else {
    // Show last 10 log entries
    const recent = log.slice(-10);
    for (const entry of recent) {
      const time = formatTime(entry.addedAt);
      const prefix = `${c.green}➕${c.reset} ${c.dim}[${time}]${c.reset} `;
      const content = entry.content.slice(0, inner - 20);
      process.stdout.write(`${c.dim}│  ${c.reset}${prefix}${content}\n`);
    }
    if (log.length > 10) {
      process.stdout.write(`${c.dim}│  ... and ${log.length - 10} older entries${c.reset}\n`);
    }
  }

  process.stdout.write(`${c.dim}└${'─'.repeat(boxWidth - 1)}${c.reset}\n`);
}

function render(prevLineCount: number): number {
  const wm = readJSON<WorkingMemory>(WM_PATH, { goal: '', steps: [], constraints: [], entities: [] });
  const allEntries = readJSON<LTMEntry[]>(LTM_PATH, []);
  const log = readLTMLog(LOG_PATH);

  // Erase previous render
  if (prevLineCount > 0) {
    process.stdout.write(`\x1b[${prevLineCount}A`);
    for (let i = 0; i < prevLineCount; i++) {
      process.stdout.write('\x1b[2K\n');
    }
    process.stdout.write(`\x1b[${prevLineCount}A`);
  }

  // Count lines written
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  let lineCount = 0;

  // We'll do a two-pass: first capture, then write.
  // Instead, just render and count newlines manually.
  const captured: string[] = [];
  const mockWrite = (s: string) => { captured.push(s); return true; };

  // Temporarily redirect stdout for counting
  (process.stdout as any).write = mockWrite;
  renderLTM(log, allEntries);
  process.stdout.write('\n');
  renderWM(wm);
  process.stdout.write(`\n${c.dim}Watching ${MEMORY_DIR} — Ctrl+C to stop${c.reset}\n`);
  (process.stdout as any).write = origWrite;

  // Count lines
  const fullOutput = captured.join('');
  lineCount = (fullOutput.match(/\n/g) || []).length;

  // Actually write
  process.stdout.write(fullOutput);

  return lineCount;
}

async function main() {
  // Ensure memory dir exists
  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  console.log(`${c.bold}${c.cyan}Memory Inspector${c.reset} — watching ${MEMORY_DIR}\n`);

  let prevLineCount = 0;
  prevLineCount = render(0);

  // Watch for file changes
  const watchFiles = [LTM_PATH, LOG_PATH, WM_PATH];
  const watchExisting = watchFiles.filter(f => {
    try { fs.accessSync(f); return true; } catch { return false; }
  });

  const onChange = () => {
    prevLineCount = render(prevLineCount);
  };

  // Poll every 500ms (fs.watch is unreliable across platforms)
  let lastMtime: Record<string, number> = {};
  const poll = setInterval(() => {
    let changed = false;
    for (const f of watchFiles) {
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
    if (changed) onChange();
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
