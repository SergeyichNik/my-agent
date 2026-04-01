/**
 * status-bar.ts — Persistent bottom status bar via ANSI scroll region.
 * Works like vim/less/htop: reserves the last terminal row for status,
 * all other output scrolls normally above it.
 *
 * Key ANSI codes:
 *   \x1b[1;Nr  — set scroll region rows 1..N (bottom row stays fixed)
 *   \x1b[s/u   — save / restore cursor position
 *   \x1b[R;1H  — move cursor to row R, column 1
 *   \x1b[r     — reset scroll region to full screen
 */

import { TaskStage } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StatusData {
  strategy: string;
  stage: TaskStage | 'idle';
  tokensSession: number;
  model: string;
}

// ── ANSI primitives ───────────────────────────────────────────────────────────

const ESC = '\x1b';
const RESET   = `${ESC}[0m`;
const BOLD    = `${ESC}[1m`;
const DIM     = `${ESC}[2m`;
const CYAN    = `${ESC}[36m`;
const YELLOW  = `${ESC}[33m`;
const MAGENTA = `${ESC}[35m`;
const GREEN   = `${ESC}[32m`;
const RED     = `${ESC}[31m`;
const BG_BAR  = `${ESC}[48;5;235m`;  // dark grey background

const save    = () => `${ESC}[s`;
const restore = () => `${ESC}[u`;
const moveTo  = (row: number, col: number) => `${ESC}[${row};${col}H`;
const clearLine = () => `${ESC}[2K`;
const scrollRegion = (top: number, bot: number) => `${ESC}[${top};${bot}r`;

// ── Stage colors (matches watch-memory.ts) ────────────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  idle:       DIM,
  planning:   CYAN,
  execution:  YELLOW,
  validation: MAGENTA,
  done:       GREEN,
  paused:     RED,
};

// ── State ─────────────────────────────────────────────────────────────────────

let _initialized = false;
let _current: StatusData = { strategy: 'rolling', stage: 'idle', tokensSession: 0, model: '' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[mhfHJKrsu]/g, '');
}

function buildBarLine(data: StatusData): string {
  const cols = process.stdout.columns || 80;
  const stageParts = STAGE_COLORS[data.stage] ?? DIM;

  const segments = [
    { styled: `${BOLD}${CYAN}◆${RESET}`,                         raw: '◆' },
    { styled: `${DIM}${data.strategy}${RESET}`,                   raw: data.strategy },
    { styled: `${stageParts}${data.stage}${RESET}`,               raw: data.stage },
    { styled: `${DIM}${formatTokens(data.tokensSession)} tok${RESET}`, raw: `${formatTokens(data.tokensSession)} tok` },
    { styled: `${DIM}${data.model}${RESET}`,                      raw: data.model },
  ];

  const SEP_STYLED = `  ${DIM}│${RESET}  `;
  const SEP_RAW    = '  │  ';

  const styledLine = segments.map(s => s.styled).join(SEP_STYLED);
  const rawLine    = segments.map(s => s.raw).join(SEP_RAW);

  const pad = Math.max(0, cols - rawLine.length);
  return `${BG_BAR}${styledLine}${' '.repeat(pad)}${RESET}`;
}

function redraw(): void {
  const rows = process.stdout.rows || 24;
  process.stdout.write(
    scrollRegion(1, rows - 1) +
    save() +
    moveTo(rows, 1) +
    clearLine() +
    buildBarLine(_current) +
    restore()
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initStatusBar(data: StatusData): void {
  _current = { ..._current, ...data };
  _initialized = true;
  redraw();
  process.stdout.on('resize', () => { if (_initialized) redraw(); });
}

export function updateStatusBar(data: Partial<StatusData>): void {
  if (!_initialized) return;
  _current = { ..._current, ...data };
  redraw();
}

export function destroyStatusBar(): void {
  if (!_initialized) return;
  _initialized = false;
  const rows = process.stdout.rows || 24;
  process.stdout.write(
    `${ESC}[r` +           // reset scroll region to full screen
    save() +
    moveTo(rows, 1) +
    clearLine() +
    restore()
  );
}
