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

User input and agent response are visually separated with labels and colors:

```
you> Hello!

agent: Hi! How can I help you today?

you>
```

- `you>` — dim prompt for user input
- `agent:` — bold cyan label before each response
- Responses stream token-by-token as they arrive
- Conversation history is preserved for the entire session
- Press `Ctrl+C` to exit

### Normal mode (default)

- **Enter** sends the message
- **Paste multi-line code** — detected automatically, sends as one message (blank lines preserved)

```
you> Here is my function, review it:
function fetchUser(id) {
  return fetch('/users/' + id).then(r => r.json())
}
← sends automatically after paste

agent: Here's my review...
```

### Multi-line mode

Type `/ml` to toggle. Prompt changes to `ml>`. Use `---` on its own line to send.
Type `/ml` again to go back to normal mode.

```
you> /ml
Multi-line mode ON — type --- on a new line to send.

ml> First paragraph.
...
... Second paragraph after an empty line.
... ---

agent: ...
```

Use this mode when you need to manually type a message with empty lines.

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
