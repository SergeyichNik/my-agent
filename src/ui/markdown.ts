/**
 * markdown.ts — Pure ANSI markdown renderer. No dependencies.
 * Call renderMarkdown(text) on the complete buffered agent response.
 * Line-by-line FSM — tracks code block state across lines.
 */

const ESC = '\x1b';
const RESET     = `${ESC}[0m`;
const BOLD      = `${ESC}[1m`;
const DIM       = `${ESC}[2m`;
const UNDERLINE = `${ESC}[4m`;
const CYAN      = `${ESC}[36m`;
const YELLOW    = `${ESC}[33m`;
const BG_CODE   = `${ESC}[48;5;236m`;   // slightly lighter dark grey
const FG_CODE   = `${ESC}[38;5;252m`;   // light grey text

// ── Inline transforms ─────────────────────────────────────────────────────────

function applyInline(line: string): string {
  // Bold: **text** or __text__
  line = line.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
  line = line.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);
  // Inline code: `code`
  line = line.replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`);
  return line;
}

// ── Line renderers ────────────────────────────────────────────────────────────

function renderHeader(line: string): string {
  const m = line.match(/^(#{1,3})\s+(.*)/);
  if (!m) return line;
  const level = m[1].length;
  const text = applyInline(m[2]);
  if (level === 1) return `\n${BOLD}${UNDERLINE}${text}${RESET}\n`;
  if (level === 2) return `\n${BOLD}${text}${RESET}\n`;
  return `${BOLD}${DIM}${text}${RESET}`;
}

function renderBullet(line: string): string {
  const m = line.match(/^(\s*)[-*]\s+(.*)/);
  if (!m) return line;
  return `${m[1]}  ${CYAN}•${RESET} ${applyInline(m[2])}`;
}

function renderNumbered(line: string): string {
  const m = line.match(/^(\s*)(\d+)\.\s+(.*)/);
  if (!m) return line;
  return `${m[1]}  ${DIM}${m[2]}.${RESET} ${applyInline(m[3])}`;
}

function renderCodeLine(line: string, width: number): string {
  const padded = line.padEnd(width);
  return `${BG_CODE}${FG_CODE}${padded}${RESET}`;
}

function renderFenceBorder(lang: string, width: number): string {
  const border = `${DIM}${'─'.repeat(width)}${RESET}`;
  if (lang) return `${border} ${YELLOW}${lang}${RESET}`;
  return border;
}

// ── Main entry ────────────────────────────────────────────────────────────────

export function renderMarkdown(text: string): string {
  const width = Math.min(process.stdout.columns || 80, 120);
  const lines = text.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';

  for (const raw of lines) {
    // Code fence open
    const fenceOpen = raw.match(/^```(\w*)/);
    if (fenceOpen && !inCode) {
      codeLang = fenceOpen[1] ?? '';
      inCode = true;
      out.push(renderFenceBorder(codeLang, width));
      continue;
    }
    // Code fence close
    if (raw.startsWith('```') && inCode) {
      inCode = false;
      out.push(renderFenceBorder('', width));
      codeLang = '';
      continue;
    }
    // Inside code block
    if (inCode) {
      out.push(renderCodeLine(raw, width));
      continue;
    }
    // Header
    if (/^#{1,3}\s/.test(raw)) { out.push(renderHeader(raw)); continue; }
    // Bullet
    if (/^\s*[-*]\s/.test(raw)) { out.push(renderBullet(raw)); continue; }
    // Numbered
    if (/^\s*\d+\.\s/.test(raw)) { out.push(renderNumbered(raw)); continue; }
    // Plain text
    out.push(applyInline(raw));
  }

  // Gracefully close unclosed block (model sometimes forgets)
  if (inCode) out.push(renderFenceBorder('', width));

  return out.join('\n');
}
