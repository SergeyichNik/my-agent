# my-agent

Minimal CLI agent that streams LLM responses token-by-token. Built on raw HTTP (no SDK), designed for extensibility.

## Setup

**1. Install dependencies**
```bash
npm install
```

**2. Create `.env`**
```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:
```
LLM_API_KEY=your-api-key-here
LLM_MODEL=deepseek-chat
LLM_BASE_URL=https://api.deepseek.com
```

**3. Run**
```bash
npx ts-node src/index.ts
```

## Usage

```
Agent ready. Type your message (Ctrl+C to exit):
> Hello!
Hi! How can I help you today?
> What did I just say?
You said "Hello!"
```

- Responses stream token-by-token as they arrive
- Conversation history is preserved for the entire session
- Press `Ctrl+C` to exit

## Architecture

```
src/
  index.ts              CLI entry — readline loop, I/O only
  agent.ts              Agent class — holds history, calls provider
  config.ts             Loads .env, validates required vars
  providers/
    types.ts            LLMProvider interface + Message type
    deepseek.ts         DeepSeek implementation (OpenAI-compatible SSE)
```

**Adding a new provider** (e.g. OpenRouter):
1. Create `src/providers/openrouter.ts` implementing `LLMProvider`
2. Swap it in `src/index.ts` — no other changes needed

## Requirements

- Node.js 18+
- npm
