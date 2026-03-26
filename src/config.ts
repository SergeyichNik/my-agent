import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const provider = requireEnv('PROVIDER') as 'deepseek' | 'gemini' | 'lmstudio';

export const config = {
  provider,
  deepseek: provider === 'deepseek' ? {
    apiKey:  requireEnv('DEEPSEEK_API_KEY'),
    model:   requireEnv('DEEPSEEK_MODEL'),
    baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
  } : null,
  gemini: provider === 'gemini' ? {
    apiKey: requireEnv('GEMINI_API_KEY'),
    model:  process.env['GEMINI_MODEL'] ?? 'gemini-2.0-flash',
  } : null,
  lmstudio: provider === 'lmstudio' ? {
    baseUrl:     process.env['LMSTUDIO_BASE_URL'] ?? 'http://localhost:1234',
    model:       process.env['LMSTUDIO_MODEL'] ?? 'local-model',
    contextSize: parseInt(process.env['LMSTUDIO_CONTEXT_SIZE'] ?? '32768', 10),
  } : null,
  sessionsDir:      process.env['SESSIONS_DIR'] ?? './sessions',
  summaryEnabled:   process.env['SUMMARY_ENABLED'] !== 'false',
  summaryBatchSize: parseInt(process.env['SUMMARY_BATCH_SIZE'] ?? '10', 10),
  summaryTail:      parseInt(process.env['SUMMARY_TAIL'] ?? '6', 10),
  bench: {
    judgeModel: process.env['BENCH_JUDGE_MODEL'],
  },
};

export const SYSTEM_PROMPT = 'You are a helpful assistant.';
