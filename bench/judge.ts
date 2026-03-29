import { LLMProvider } from '../src/types';
import { config } from '../src/config';
import { DeepSeekProvider } from '../src/providers/deepseek';
import { GeminiProvider } from '../src/providers/gemini';
import { LMStudioProvider } from '../src/providers/lmstudio';

// ── Result types ──────────────────────────────────────────────────────────────

export interface JudgeResult {
  context:      { scoreA: number; scoreB: number };
  quality:      { scoreA: number; scoreB: number };
  completeness: { scoreA: number; scoreB: number };
  overall:      { scoreA: number; scoreB: number };
  conclusion:   string;
}

export interface ThreeWayJudgeResult {
  context:      { scoreA: number; scoreB: number; scoreC: number };
  quality:      { scoreA: number; scoreB: number; scoreC: number };
  completeness: { scoreA: number; scoreB: number; scoreC: number };
  overall:      { scoreA: number; scoreB: number; scoreC: number };
  conclusion:   string;
}

// ── System prompts ────────────────────────────────────────────────────────────

const TWO_WAY_SYSTEM_PROMPT = `Ты судья, оцениваешь два ответа ИИ-ассистента на один вопрос в многоходовом диалоге.
Ответ A получен без сжатия истории разговора. Ответ B получен со сжатием (rolling summary).

Оцени каждый ответ по четырём критериям от 1 до 10:
- context: сохранение контекста из предыдущих сообщений
- quality: точность и полезность ответа
- completeness: полнота раскрытия темы
- overall: итоговая оценка

Отвечай ТОЛЬКО валидным JSON без какого-либо другого текста:
{"context":{"scoreA":N,"scoreB":N},"quality":{"scoreA":N,"scoreB":N},"completeness":{"scoreA":N,"scoreB":N},"overall":{"scoreA":N,"scoreB":N},"conclusion":"одно предложение на русском"}`;

const THREE_WAY_SYSTEM_PROMPT = `Ты судья, оцениваешь три ответа ИИ-ассистента на один вопрос в многоходовом диалоге.
Ответ A — агент со стратегией Sliding Window (последние N сообщений, старое отброшено).
Ответ B — агент со стратегией Sticky Facts (структурированные факты + последние N сообщений).
Ответ C — агент со стратегией Branching (полный контекст, ветки диалога).

Оцени каждый ответ по четырём критериям от 1 до 10:
- context: сохранение контекста из предыдущих сообщений
- quality: точность и полезность ответа
- completeness: полнота раскрытия темы
- overall: итоговая оценка

Отвечай ТОЛЬКО валидным JSON без какого-либо другого текста:
{"context":{"scoreA":N,"scoreB":N,"scoreC":N},"quality":{"scoreA":N,"scoreB":N,"scoreC":N},"completeness":{"scoreA":N,"scoreB":N,"scoreC":N},"overall":{"scoreA":N,"scoreB":N,"scoreC":N},"conclusion":"одно предложение на русском"}`;

// ── Judge class ───────────────────────────────────────────────────────────────

export class Judge {
  private constructor(private readonly provider: LLMProvider) {}

  /** Evaluate two responses (A vs B). */
  async evaluate(
    question: string,
    responseA: string,
    responseB: string,
    instruction: string
  ): Promise<JudgeResult> {
    const userPrompt = `Дополнительный критерий оценки: ${instruction}

Вопрос: ${question}

Ответ A (без сжатия истории):
${responseA}

Ответ B (со сжатием истории):
${responseB}`;

    const raw = await this.call(TWO_WAY_SYSTEM_PROMPT, userPrompt);
    const parsed = JSON.parse(raw);
    return {
      context:      { scoreA: Number(parsed.context?.scoreA),      scoreB: Number(parsed.context?.scoreB) },
      quality:      { scoreA: Number(parsed.quality?.scoreA),      scoreB: Number(parsed.quality?.scoreB) },
      completeness: { scoreA: Number(parsed.completeness?.scoreA), scoreB: Number(parsed.completeness?.scoreB) },
      overall:      { scoreA: Number(parsed.overall?.scoreA),      scoreB: Number(parsed.overall?.scoreB) },
      conclusion:   String(parsed.conclusion ?? ''),
    };
  }

  /** Evaluate three responses (Window / Facts / Branch). */
  async evaluateThreeWay(
    question: string,
    responseA: string,
    responseB: string,
    responseC: string,
    instruction: string
  ): Promise<ThreeWayJudgeResult> {
    const userPrompt = `Дополнительный критерий оценки: ${instruction}

Вопрос: ${question}

Ответ A (Sliding Window):
${responseA}

Ответ B (Sticky Facts):
${responseB}

Ответ C (Branching / полный контекст):
${responseC}`;

    const raw = await this.call(THREE_WAY_SYSTEM_PROMPT, userPrompt);
    const parsed = JSON.parse(raw);
    return {
      context:      { scoreA: Number(parsed.context?.scoreA),      scoreB: Number(parsed.context?.scoreB),      scoreC: Number(parsed.context?.scoreC) },
      quality:      { scoreA: Number(parsed.quality?.scoreA),      scoreB: Number(parsed.quality?.scoreB),      scoreC: Number(parsed.quality?.scoreC) },
      completeness: { scoreA: Number(parsed.completeness?.scoreA), scoreB: Number(parsed.completeness?.scoreB), scoreC: Number(parsed.completeness?.scoreC) },
      overall:      { scoreA: Number(parsed.overall?.scoreA),      scoreB: Number(parsed.overall?.scoreB),      scoreC: Number(parsed.overall?.scoreC) },
      conclusion:   String(parsed.conclusion ?? ''),
    };
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    let raw = '';
    await this.provider.streamChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      (chunk) => { raw += chunk; }
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Judge returned non-JSON: ${raw.slice(0, 200)}`);
    return match[0];
  }

  /**
   * Factory — resolves judge provider independently from the main PROVIDER.
   *
   * Resolution order:
   *   provider: BENCH_JUDGE_PROVIDER ?? PROVIDER
   *   model:    BENCH_JUDGE_MODEL    ?? (model from resolved provider config)
   */
  static create(): Judge {
    const { bench } = config;
    const providerName = bench.judgeProvider ?? config.provider;

    if (providerName === 'deepseek') {
      const apiKey = bench.deepseekApiKey ?? config.deepseek?.apiKey;
      if (!apiKey) {
        throw new Error('BENCH_JUDGE_PROVIDER=deepseek requires DEEPSEEK_API_KEY in .env.old');
      }
      const model = bench.judgeModel ?? config.deepseek?.model ?? 'deepseek-chat';
      return new Judge(new DeepSeekProvider({
        apiKey,
        model,
        baseUrl: bench.deepseekBaseUrl,
      }));
    }

    if (providerName === 'gemini') {
      const apiKey = bench.geminiApiKey ?? config.gemini?.apiKey;
      if (!apiKey) {
        throw new Error('BENCH_JUDGE_PROVIDER=gemini requires GEMINI_API_KEY in .env.old');
      }
      const model = bench.judgeModel ?? config.gemini?.model ?? 'gemini-2.0-flash';
      return new Judge(new GeminiProvider({ apiKey, model }));
    }

    // lmstudio
    const lm = config.lmstudio;
    if (!lm) {
      throw new Error('BENCH_JUDGE_PROVIDER=lmstudio requires PROVIDER=lmstudio or lmstudio config in .env.old');
    }
    const model = bench.judgeModel ?? lm.model;
    return new Judge(new LMStudioProvider({ baseUrl: lm.baseUrl, model }));
  }
}
