import { LLMProvider, Message } from './types';

interface DeepSeekConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export class DeepSeekProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor({ apiKey, model, baseUrl }: DeepSeekConfig) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async streamChat(messages: Message[], onChunk: (chunk: string) => void): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const rawChunk of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(rawChunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice('data: '.length);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const content: string | undefined = parsed.choices?.[0]?.delta?.content;
          if (content) {
            onChunk(content);
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }
}
