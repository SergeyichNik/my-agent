import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const provider = requireEnv('PROVIDER') as 'deepseek' | 'gemini';

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
  sessionsDir: process.env['SESSIONS_DIR'] ?? './sessions',
};

export const SYSTEM_PROMPT = 'You are a helpful assistant.';
