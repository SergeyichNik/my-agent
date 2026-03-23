# Agent — Step 1: CLI LLM Agent

## Status: TODO

---

## Claude Code Prompt

```
You are an expert TypeScript/Node.js engineer. Your task is to scaffold a CLI-based LLM agent from scratch.

## Goal
Build a minimal but production-architecture CLI agent that:
- Accepts user input from the terminal (readline loop)
- Sends it to an LLM via HTTP API
- Streams the response back to the terminal
- Maintains conversation history (multi-turn)
- Is designed for extensibility — not a one-off script

---

## Stack & Constraints
- Language: TypeScript (strict mode)
- Runtime: Node.js
- HTTP client: native fetch (Node 18+), no axios
- No LLM SDKs — raw HTTP calls only (we want to understand the transport layer)
- Package manager: npm
- Entry point: `src/index.ts`, runnable via `npx ts-node src/index.ts`

---

## Architecture Requirements

### 1. Provider Abstraction
Define an interface `LLMProvider` with a method:
```ts
streamChat(messages: Message[], onChunk: (chunk: string) => void): Promise<void>
```
Implement `DeepSeekProvider` as the first concrete provider.
The agent must depend on the interface, not the implementation.
This makes swapping to OpenRouter or Anthropic a matter of adding a new class.

### 2. Agent as a separate entity
Create an `Agent` class that:
- Holds conversation history: `Message[]`
- Has a `chat(userInput: string): Promise<void>` method
- Delegates LLM calls to the injected `LLMProvider`
- Does NOT handle I/O — that's the CLI's responsibility

### 3. Config via .env
Use `dotenv`. Required variables:
- `LLM_API_KEY`
- `LLM_MODEL` (e.g. `deepseek-chat`)
- `LLM_BASE_URL` (e.g. `https://api.deepseek.com`)

Fail fast with a clear error message if any variable is missing.

### 4. Streaming
DeepSeek (and OpenRouter) support OpenAI-compatible SSE streaming.
Implement real streaming: parse `data: {...}` chunks from the SSE response,
extract delta content, call `onChunk` incrementally.
Do NOT buffer the full response — print tokens as they arrive.

---

## File Structure to produce
```
src/
  index.ts          # CLI entry: readline loop, instantiates Agent
  agent.ts          # Agent class
  providers/
    types.ts        # LLMProvider interface + Message type
    deepseek.ts     # DeepSeekProvider implementation
  config.ts         # dotenv loader + validation
.env.example
tsconfig.json
package.json
```

---

## Message type
```ts
type Role = 'user' | 'assistant' | 'system';
interface Message {
  role: Role;
  content: string;
}
```

---

## CLI behavior
- On start: print `Agent ready. Type your message (Ctrl+C to exit):`
- After each user input: stream assistant response to stdout token by token
- After stream completes: print newline, wait for next input
- Conversation history persists for the entire session

---

## What NOT to do
- Do not use LangChain, openai SDK, or any LLM wrapper library
- Do not implement tool use or function calling (yet)
- Do not add a web server (yet)
- Do not over-engineer — no dependency injection containers, no decorators

---

## After implementation
Once the code is written:
1. Run `npm install` and confirm it compiles with `npx tsc --noEmit`
2. Show me the exact command to run it
3. Point out where in the architecture I would plug in:
   - A new provider (e.g. OpenRouter)
   - Tool use / function calling
   - A future HTTP transport layer
```

---

## Roadmap (next steps after this is working)

| Step | What | Why |
|------|------|-----|
| 2 | Add OpenRouter provider | Provider swap smoke test |
| 3 | Tool use / function calling | Agent starts doing things |
| 4 | HTTP transport (`src/server.ts`) | Same Agent, new entry point |
| 5 | Web UI | Only when HTTP layer is stable |

---

## Notes
- Web-UI → WebSocket from day one: **not worth it**. Adds 3-4x code complexity before core agent is stable. Add HTTP transport only when Agent is solid and you need multi-user or demo UI.
- Agent class must never import readline or any I/O — keeps it transport-agnostic for step 4.
