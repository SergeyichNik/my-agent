import { LLMProvider, Message } from './providers/types';
import { SYSTEM_PROMPT } from './config';

export class Agent {
  private readonly provider: LLMProvider;
  private readonly history: Message[];

  constructor(provider: LLMProvider) {
    this.provider = provider;
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  async chat(userInput: string, onChunk: (chunk: string) => void): Promise<void> {
    this.history.push({ role: 'user', content: userInput });

    let fullResponse = '';
    await this.provider.streamChat(this.history, (chunk) => {
      fullResponse += chunk;
      onChunk(chunk);
    });

    this.history.push({ role: 'assistant', content: fullResponse });
  }
}
