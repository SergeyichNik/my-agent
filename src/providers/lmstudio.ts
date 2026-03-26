import { LLMProvider, Message, UsageData } from '../types';

interface LMStudioConfig {
  baseUrl: string;
  model: string;
}

export class LMStudioProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor({ baseUrl, model }: LMStudioConfig) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async streamChat(messages: Message[], onChunk: (chunk: string) => void): Promise<UsageData | null> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LM Studio API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let capturedUsage: UsageData | null = null;

    for await (const rawChunk of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(rawChunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice('data: '.length);
        if (data === '[DONE]') return capturedUsage;

        try {
          const parsed = JSON.parse(data);
          const content: string | undefined = parsed.choices?.[0]?.delta?.content;
          if (content) {
            onChunk(content);
          }
          if (parsed.usage) {
            capturedUsage = parsed.usage;
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }

    return capturedUsage;
  }
}
