import * as readline from 'readline';
import { config } from './config';
import { Agent } from './agent';
import { DeepSeekProvider } from './providers/deepseek';

const provider = new DeepSeekProvider(config);
const agent = new Agent(provider);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const c = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  cyan:     '\x1b[36m',
  yellow:   '\x1b[33m',
};

function label(text: string, style: string): string {
  return `${style}${text}${c.reset}`;
}

console.log(label('Agent ready.', c.bold), 'Press Enter to send. Paste multi-line code — it sends as one message.');
console.log(`Type ${label('/ml', c.bold)} to switch to multi-line mode (use ${label('---', c.bold)} to send). Ctrl+C to exit.\n`);

const buffer: string[] = [];
let isProcessing = false;
let submitTimer: ReturnType<typeof setTimeout> | null = null;
let multilineMode = false;

const PASTE_WINDOW_MS = 50;

function getPrompt(): string {
  const indicator = multilineMode ? 'ml' : 'you';
  return `${c.dim}${indicator}>${c.reset} `;
}

async function submit(): Promise<void> {
  const input = buffer.join('\n').trim();
  buffer.length = 0;

  if (!input) {
    rl.setPrompt(getPrompt());
    rl.prompt();
    return;
  }

  process.stdout.write(`\n${label('agent:', c.bold + c.cyan)}\n`);
  rl.setPrompt('');
  isProcessing = true;
  try {
    await agent.chat(input, (chunk) => process.stdout.write(chunk));
    process.stdout.write('\n\n');
  } catch (err) {
    console.error(label('Error:', c.bold + c.yellow), err instanceof Error ? err.message : err);
  } finally {
    isProcessing = false;
    rl.setPrompt(getPrompt());
    rl.prompt();
  }
}

rl.setPrompt(getPrompt());
rl.prompt();

rl.on('line', (line) => {
  if (isProcessing) return;

  if (line.trim() === '/ml') {
    multilineMode = !multilineMode;
    buffer.length = 0;
    if (submitTimer) { clearTimeout(submitTimer); submitTimer = null; }
    console.log(multilineMode
      ? `${label('Multi-line mode ON', c.bold)} — type ${label('---', c.bold)} on a new line to send.`
      : `${label('Multi-line mode OFF', c.bold)} — Enter sends, paste auto-detected.`);
    rl.setPrompt(getPrompt());
    rl.prompt();
    return;
  }

  if (multilineMode) {
    if (line.trim() === '---') {
      submit();
    } else {
      buffer.push(line);
      rl.setPrompt(`${c.dim}...${c.reset} `);
      rl.prompt();
    }
  } else {
    buffer.push(line);
    if (submitTimer) clearTimeout(submitTimer);
    submitTimer = setTimeout(() => {
      submitTimer = null;
      submit();
    }, PASTE_WINDOW_MS);
  }
});

rl.on('close', () => process.exit(0));
