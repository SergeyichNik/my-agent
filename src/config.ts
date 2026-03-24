import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  apiKey: requireEnv('LLM_API_KEY'),
  model: requireEnv('LLM_MODEL'),
  baseUrl: requireEnv('LLM_BASE_URL'),
  sessionsDir: process.env['SESSIONS_DIR'] ?? './sessions',
};

export const SYSTEM_PROMPT = 'You are a helpful assistant.';
