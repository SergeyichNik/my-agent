// MultiColumnRenderer: fixed-height viewport with side-by-side streaming columns
// Uses pure ANSI escape codes, no external dependencies.

export class MultiColumnRenderer {
  private readonly buffers: string[][];
  private readonly done: boolean[];
  private readonly doneTokens: (number | undefined)[];
  private readonly colWidth: number;
  private readonly viewportHeight: number;
  private lastRenderHeight: number = 0;
  private pendingRender: boolean = false;

  constructor(
    private readonly names: string[],
    private readonly colors: string[]
  ) {
    const n = names.length;
    const termWidth = process.stdout.columns || 120;
    this.colWidth = Math.max(20, Math.floor((termWidth - n - 1) / n));
    this.viewportHeight = Math.max(10, Math.min(25, (process.stdout.rows || 30) - 6));
    this.buffers = names.map(() => ['']);
    this.done = names.map(() => false);
    this.doneTokens = names.map(() => undefined);
  }

  append(colIndex: number, text: string): void {
    const inner = this.colWidth - 2;
    const buf = this.buffers[colIndex];
    const segments = text.split('\n');

    for (let si = 0; si < segments.length; si++) {
      if (si > 0) buf.push('');
      let seg = segments[si];
      while (seg.length > 0) {
        const lastLine = buf[buf.length - 1];
        const available = inner - lastLine.length;
        if (available <= 0) {
          buf.push('');
          continue;
        }
        buf[buf.length - 1] += seg.slice(0, available);
        seg = seg.slice(available);
        if (seg.length > 0) buf.push('');
      }
    }

    this.scheduleRender();
  }

  markDone(colIndex: number, tokens?: number): void {
    this.done[colIndex] = true;
    this.doneTokens[colIndex] = tokens;
    this.render();
  }

  clear(): void {
    if (this.lastRenderHeight > 0) {
      process.stdout.write(`\x1b[${this.lastRenderHeight}A`);
      for (let i = 0; i < this.lastRenderHeight; i++) {
        process.stdout.write('\x1b[2K\n');
      }
      process.stdout.write(`\x1b[${this.lastRenderHeight}A`);
    }
    this.lastRenderHeight = 0;
  }

  private scheduleRender(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    setImmediate(() => {
      this.pendingRender = false;
      this.render();
    });
  }

  private render(): void {
    const colWidth = this.colWidth;
    const inner = colWidth - 2; // 1 space padding on each side
    const reset = '\x1b[0m';
    const dim = '\x1b[2m';
    const bold = '\x1b[1m';
    const green = '\x1b[32m';

    const outputLines: string[] = [];

    // Top border with column names
    const topParts = this.names.map((name, i) => {
      const color = this.colors[i];
      const truncName = name.slice(0, colWidth - 5);
      const used = 2 + truncName.length + 1; // "─ name "
      const trailing = Math.max(0, colWidth - used);
      return `${color}${bold}─ ${truncName} ${reset}${dim}${'─'.repeat(trailing)}${reset}`;
    });
    outputLines.push(`┌${topParts.join('┬')}┐`);

    // Content rows (tail of each buffer)
    for (let row = 0; row < this.viewportHeight; row++) {
      const cells = this.buffers.map(buf => {
        const lineIdx = buf.length - this.viewportHeight + row;
        const text = lineIdx >= 0 ? buf[lineIdx] : '';
        return ' ' + text.padEnd(inner) + ' ';
      });
      outputLines.push(`│${cells.join('│')}│`);
    }

    // Bottom border with status
    const botParts = this.done.map((isDone, i) => {
      let status: string;
      if (isDone) {
        const tok = this.doneTokens[i];
        status = tok != null ? `DONE ${tok}tok` : 'DONE';
      } else {
        status = 'streaming…';
      }
      const used = 1 + status.length + 1; // " status "
      const trailing = Math.max(0, colWidth - used);
      const color = isDone ? dim : green;
      return `${color} ${status} ${'─'.repeat(trailing)}${reset}`;
    });
    outputLines.push(`└${botParts.join('┴')}┘`);

    let output = '';
    if (this.lastRenderHeight > 0) {
      output += `\x1b[${this.lastRenderHeight}A`;
    }
    for (const line of outputLines) {
      output += `\x1b[2K${line}\n`;
    }

    this.lastRenderHeight = outputLines.length;
    process.stdout.write(output);
  }
}
