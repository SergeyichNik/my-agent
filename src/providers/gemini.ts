import { GoogleGenerativeAI, Content } from '@google/generative-ai';
import { LLMProvider, Message, UsageData } from '../types';

interface GeminiConfig {
  apiKey: string;
  model: string;
}

export class GeminiProvider implements LLMProvider {
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelName: string;

  constructor({ apiKey, model }: GeminiConfig) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = model;
  }

  async streamChat(messages: Message[], onChunk: (chunk: string) => void): Promise<UsageData | null> {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const contents: Content[] = chatMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: systemMsg?.content,
    });

    const streamResult = await model.generateContentStream({ contents });

    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) onChunk(text);
    }

    const response = await streamResult.response;
    const usage = response.usageMetadata;
    if (!usage) return null;

    return {
      prompt_tokens:     usage.promptTokenCount     ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens:      usage.totalTokenCount      ?? 0,
    };
  }
}
