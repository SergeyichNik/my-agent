import * as readline from 'readline';
import { config } from './config';
import { Agent } from './agent';
import { DeepSeekProvider } from './providers/deepseek';

const provider = new DeepSeekProvider(config);
const agent = new Agent(provider);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('Agent ready. Type your message (Ctrl+C to exit):');

function prompt(): void {
  rl.question('> ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    try {
      await agent.chat(trimmed, (chunk) => process.stdout.write(chunk));
      process.stdout.write('\n');
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : err);
    }

    prompt();
  });
}

prompt();
