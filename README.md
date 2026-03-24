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

On startup, you'll see a session picker:

```
Sessions:
  [1] code-review (12 messages, last: 2 hours ago)
  [2] auth-feature (4 messages, last: yesterday)
  [n] Start new session

> _
```

Pick a number to resume, or `n` to start a new session (you'll be prompted for a name).

---

User input and agent response are visually separated with labels and colors:

```
you> Hello!

agent: Hi! How can I help you today?

you>
```

- `you>` — dim prompt for user input
- `agent:` — bold cyan label before each response
- Responses stream token-by-token as they arrive
- Conversation history is saved automatically after each response
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

## Sessions

Sessions are stored in `~/.my-agent/sessions/` as JSON files (one per session). They persist across working directories.

Each session saves the full conversation history (excluding the system prompt) and auto-saves after every assistant response.

## Architecture

```
src/
  index.ts              CLI entry — session picker, readline loop, I/O only
  agent.ts              Agent class — holds history, calls provider, auto-saves
  config.ts             Loads .env, validates required vars
  types.ts              Shared types: Message, LLMProvider, Session, SessionStorage
  providers/
    types.ts            Re-exports from types.ts
    deepseek.ts         DeepSeek implementation (OpenAI-compatible SSE)
  storage/
    json.ts             JsonSessionStorage — one JSON file per session
```

**Adding a new provider** (e.g. OpenRouter):
1. Create `src/providers/openrouter.ts` implementing `LLMProvider`
2. Swap it in `src/index.ts` — no other changes needed

**Migrating sessions to SQLite:**
1. Create `src/storage/sqlite.ts` implementing `SessionStorage`
2. Change one line in `src/index.ts` where `JsonSessionStorage` is instantiated

## Requirements

- Node.js 18+
- npm
