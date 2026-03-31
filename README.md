# my-agent

Minimal CLI agent that streams LLM responses token-by-token. Supports multiple providers (DeepSeek, Gemini, LM Studio), selected at launch via npm scripts.

## Setup

**1. Install dependencies**
```bash
npm install
```

**2. Create `.env`**
```bash
cp .env.old.example .env.old
```

Edit `.env` and fill in your credentials for the provider(s) you want to use:
```
# DeepSeek
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat

# Gemini
GEMINI_API_KEY=AIza...
# GEMINI_MODEL=gemini-2.0-flash  (optional, this is the default)

# LM Studio — no API key needed, all vars are optional
# LMSTUDIO_BASE_URL=http://localhost:1234   (default)
# LMSTUDIO_MODEL=local-model               (default, LM Studio ignores it and uses loaded model)
# LMSTUDIO_CONTEXT_SIZE=32768              (default)
```

**3. Run**
```bash
npm run start:deepseek   # DeepSeek
npm run start:gemini     # Gemini
npm run start:lmstudio   # LM Studio (local)
npm start                # alias for start:deepseek
```

**Optional: run as a specific user (enables personalization)**
```bash
npm start -- --user alice
npm run start:gemini -- --user bob
```

When `--user` is set and the Memory strategy is active (`/ctx memory`), the agent builds and applies a per-user profile stored in `memory/profiles/<user>.json`. The agent detects explicit preferences you state (e.g. "answer briefly", "I use Python", "no markdown") and applies them automatically in future turns.

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
- Braille spinner while waiting for the first token
- Responses stream token-by-token as they arrive
- Dim token stats line printed after each response (prompt / completion / total / session cumulative)
- Dim separator line printed after each response
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

## Context Management

The agent supports three context management strategies, switchable at any time with `/ctx`:

### Strategy 1: Rolling Summary (default)
Automatically summarizes older messages to keep the context window bounded.
- Last `SUMMARY_TAIL` messages (default: 6) are always kept verbatim
- When older messages reach `SUMMARY_BATCH_SIZE` (default: 10), they are compressed into a rolling summary
- Summary is injected as a system message and persists with the session

### Strategy 2: Sliding Window
Keeps only the last N messages in every prompt. Fast and token-efficient, but older details are dropped.
- Switch: `/ctx window` or `/ctx window 20` (custom N)
- Default window size: 10 (configurable via `WINDOW_SIZE` env var)

### Strategy 3: Sticky Facts
After each turn, an LLM call extracts key facts (Goal / Constraints / Decisions / Preferences) from the conversation and prepends them as a structured system message. Combines structured memory with a recent-message window.
- Switch: `/ctx facts` or `/ctx facts 8` (custom recent-window N)
- Default window: 6 (configurable via `FACTS_WINDOW_SIZE` env var)
- 1 extra LLM call per turn (small prompt, cheap)

### Strategy 4: Branching
Snapshot the conversation at any point and explore multiple independent directions.
- Switch: `/ctx branch`
- `/branch save <name>` — snapshot current history as a named branch
- `/branch list` — show all branches
- `/branch load <name>` — restore a branch (replaces current history)
- Full history sent on every request (no compression)

### Strategy 5: Memory (Layered Memory System)
Three-layer memory architecture with cross-session persistence:
- **Short-term**: last N messages (same as sliding window)
- **Working memory**: current task state (goal / steps / constraints / entities), session-scoped
- **Long-term memory**: facts that persist across sessions, stored in `memory/ltm.json`

Switch: `/ctx memory`

**Pipeline per turn:**
1. LLM retrieval — selects relevant long-term facts for current message
2. Context is built: LTM facts + working memory state + last N messages
3. Main LLM call (streaming response)
4. Decision engine — extracts WM updates and new LTM facts from the completed turn

**2 extra LLM calls per turn** (retrieval + decision engine). Long-term memory accumulates globally across all sessions using this strategy.

**Inspect memory layers live** (separate terminal):
```bash
npm run watch-memory
```
Shows real-time updates to both layers as the agent runs.

**Switching strategies is lossless** — full history is preserved in memory regardless of strategy.

**Check current strategy:** `/ctx`

**Configuration** (optional, all have defaults):
```
SUMMARY_ENABLED=true    # set to false to disable initial rolling summary
SUMMARY_BATCH_SIZE=10   # messages accumulated before summarization triggers
SUMMARY_TAIL=6          # last N messages always kept verbatim in rolling summary
WINDOW_SIZE=10          # default window size for sliding window strategy
FACTS_WINDOW_SIZE=6     # recent messages included alongside facts
```

## Sessions

Sessions are stored in `~/.my-agent/sessions/` as JSON files (one per session). They persist across working directories.

Each session saves the full conversation history (excluding the system prompt) and auto-saves after every assistant response. The cumulative token count (`totalTokensUsed`) is also persisted — if you resume a session, the counter carries over from previous runs.

## Architecture

```
src/
  index.ts              CLI entry — session picker, readline loop, /ctx /branch commands
  agent.ts              Agent class — holds history, delegates to ContextStrategy
  config.ts             Loads .env, selects provider config conditionally
  types.ts              Shared types: Message, LLMProvider, Session, StrategyState, ...
  strategies/
    context-strategy.ts ContextStrategy interface + StrategyName type
    rolling-summary.ts  Rolling summarization (default)
    sliding-window.ts   Sliding window — last N messages only
    sticky-facts.ts     Sticky facts — LLM-extracted key-value memory
    branching.ts        Branching — named snapshots, independent conversation branches
    memory.ts           Memory strategy — 3-layer memory (STM/WM/LTM)
    index.ts            createStrategy() factory + re-exports
  memory/
    manager.ts          MemoryManager — LTM read/write, WM state persistence
  profile/
    manager.ts          ProfileManager — per-user profile load/save/update
  providers/
    deepseek.ts         DeepSeek implementation (OpenAI-compatible SSE, raw HTTP)
    gemini.ts           Gemini implementation (@google/generative-ai SDK)
    lmstudio.ts         LM Studio implementation (OpenAI-compatible SSE, no auth)
  storage/
    json.ts             JsonSessionStorage — one JSON file per session
```

**Adding a new provider** (e.g. OpenRouter):
1. Create `src/providers/openrouter.ts` implementing `LLMProvider`
2. Add its env vars to `src/config.ts` (conditionally required)
3. Add a branch in `src/index.ts` provider selection
4. Add `start:openrouter` script to `package.json`

**Migrating sessions to SQLite:**
1. Create `src/storage/sqlite.ts` implementing `SessionStorage`
2. Change one line in `src/index.ts` where `JsonSessionStorage` is instantiated

## Benchmarking

### Two-way benchmark (with/without summarization)
```bash
npm run bench                    # interactive script picker
npm run bench -- summarization   # run a specific script by name
```

Reports saved to `bench/reports/YYYY-MM-DD-{name}.md`.

### Personalization benchmark
Tests whether the agent adapts responses to two different user profiles (alice vs bob):

```bash
npm run bench:personalization           # DeepSeek
npm run bench:personalization:gemini    # Gemini
npm run bench:personalization:lm        # LM Studio
```

Phase 1 builds profiles via explicit preference statements. Phase 2 asks both users the same 3 questions. The judge scores each question on Style Match, Format Match, Tech Match, and Differentiation (all 0–10), producing a final Personalization Score. Reports saved to `bench/reports/personalization-<timestamp>.md`.

### Memory benchmark (cross-session recall)
Tests whether the Memory strategy correctly stores and retrieves facts across sessions:

```bash
npm run bench:memory                 # DeepSeek
npm run bench:memory:gemini          # Gemini
npm run bench:memory:lm              # LM Studio
```

Runs 3 sessions: session 1 introduces facts, sessions 2–3 test recall. Compares Memory strategy vs Sliding Window (control). Reports saved to `bench/reports/memory-bench-YYYY-MM-DD.md`.

**Live memory inspector** (run in a separate terminal during the agent or bench):
```bash
npm run watch-memory
```

### Three-way strategy benchmark
Compare all three context strategies (Sliding Window vs Sticky Facts vs Branching) on the same scenario:

```bash
npm run bench:strategies             # interactive script picker (DeepSeek)
npm run bench:strategies:gemini      # Gemini
npm run bench:strategies:lm          # LM Studio
npm run bench:strategies -- tz-requirements   # run specific scenario directly
```

Reports saved to `bench/reports/YYYY-MM-DD-strategies-{name}.md` with:
- Three-column response comparison per checkpoint message
- LLM judge scores: context retention / quality / completeness / overall
- Token usage per strategy and savings vs full-context (Branching) baseline

**Built-in benchmark scenarios:**
- `tz-requirements` — 15-message requirements gathering session for a web platform. Tests how well each strategy retains early context (budget, stack, deadlines, roles) by message 15.
- `summarization`, `context-retention`, `quick` — existing two-way scenarios

**Adding a new scenario:**
1. Create `bench/scripts/{name}.json` with `name`, `description`, `judgePrompt`, and `messages`
2. Mark important messages with `{ "text": "...", "checkpoint": true }` for judge evaluation

**Optional config:**
```
BENCH_JUDGE_MODEL=deepseek-reasoner   # use a stronger model for judging
```

## Requirements

- Node.js 18+
- npm
