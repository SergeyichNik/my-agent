import * as readline from 'readline';
import { config } from './config';
import { Agent } from './agent';
import { DeepSeekProvider } from './providers/deepseek';

const provider = new DeepSeekProvider(config);
const agent = new Agent(provider);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('Agent ready. Press Enter to send. Paste multi-line code — it sends as one message.');
console.log('Type /ml to switch to multi-line mode (use --- to send). Ctrl+C to exit.');

const buffer: string[] = [];
let isProcessing = false;
let submitTimer: ReturnType<typeof setTimeout> | null = null;
let multilineMode = false;

const PASTE_WINDOW_MS = 50;

function getPrompt(): string {
  return multilineMode ? 'ml> ' : '> ';
}

async function submit(): Promise<void> {
  const input = buffer.join('\n').trim();
  buffer.length = 0;

  if (!input) {
    rl.setPrompt(getPrompt());
    rl.prompt();
    return;
  }

  rl.setPrompt('');
  isProcessing = true;
  try {
    await agent.chat(input, (chunk) => process.stdout.write(chunk));
    process.stdout.write('\n');
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
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

  // toggle command
  if (line.trim() === '/ml') {
    multilineMode = !multilineMode;
    buffer.length = 0;
    if (submitTimer) { clearTimeout(submitTimer); submitTimer = null; }
    console.log(multilineMode
      ? 'Multi-line mode ON — type --- on a new line to send.'
      : 'Multi-line mode OFF — Enter sends, paste auto-detected.');
    rl.setPrompt(getPrompt());
    rl.prompt();
    return;
  }

  if (multilineMode) {
    if (line.trim() === '---') {
      submit();
    } else {
      buffer.push(line);
      rl.setPrompt('... ');
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
