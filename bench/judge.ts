import { LLMProvider } from '../src/types';

export interface JudgeResult {
  context:      { scoreA: number; scoreB: number };
  quality:      { scoreA: number; scoreB: number };
  completeness: { scoreA: number; scoreB: number };
  overall:      { scoreA: number; scoreB: number };
  conclusion:   string;
}

const JUDGE_SYSTEM_PROMPT = `Ты судья, оцениваешь два ответа ИИ-ассистента на один вопрос в многоходовом диалоге.
Ответ A получен без сжатия истории разговора. Ответ B получен со сжатием (rolling summary).

Оцени каждый ответ по четырём критериям от 1 до 10:
- context: сохранение контекста из предыдущих сообщений
- quality: точность и полезность ответа
- completeness: полнота раскрытия темы
- overall: итоговая оценка

Отвечай ТОЛЬКО валидным JSON без какого-либо другого текста:
{"context":{"scoreA":N,"scoreB":N},"quality":{"scoreA":N,"scoreB":N},"completeness":{"scoreA":N,"scoreB":N},"overall":{"scoreA":N,"scoreB":N},"conclusion":"одно предложение на русском"}`;

export async function runJudge(
  provider: LLMProvider,
  question: string,
  responseA: string,
  responseB: string,
  judgeInstruction: string
): Promise<JudgeResult> {
  const userPrompt = `Дополнительный критерий оценки: ${judgeInstruction}

Вопрос: ${question}

Ответ A (без сжатия истории):
${responseA}

Ответ B (со сжатием истории):
${responseB}`;

  let raw = '';
  await provider.streamChat(
    [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    (chunk) => { raw += chunk; }
  );

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge returned non-JSON: ${raw.slice(0, 200)}`);

  const parsed = JSON.parse(match[0]);
  return {
    context:      { scoreA: Number(parsed.context?.scoreA), scoreB: Number(parsed.context?.scoreB) },
    quality:      { scoreA: Number(parsed.quality?.scoreA), scoreB: Number(parsed.quality?.scoreB) },
    completeness: { scoreA: Number(parsed.completeness?.scoreA), scoreB: Number(parsed.completeness?.scoreB) },
    overall:      { scoreA: Number(parsed.overall?.scoreA), scoreB: Number(parsed.overall?.scoreB) },
    conclusion:   String(parsed.conclusion ?? ''),
  };
}
