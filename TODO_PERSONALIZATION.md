# TODO_PERSONALIZATION.md

## Goal

Extend the existing memory system with a **personalization layer**.

The agent must adapt its behavior based on a **user profile**, applied automatically on every request.

This is not just storing preferences — it is about **systematically influencing responses through profile-aware context building**.

---

## Core Principle

Personalization must be:

* **explicitly modeled** (not implicit in memory)
* **consistently applied** (every request)
* **separate from memory layers**, but integrated into context

---

## User Profile

Introduce a dedicated **User Profile model**.

### Requirements:

* structured (no raw text blobs)
* persistent (stored in long-term memory or separate storage)
* updatable over time

---

### Profile Structure (conceptual)

```id="9f3x2k"
UserProfile = {
  preferences: {
    style: ...,
    verbosity: ...,
    tone: ...
  },
  format: {
    codeStyle: ...,
    responseStructure: ...
  },
  constraints: {
    doNot: [...],
    must: [...]
  }
}
```

---

## Examples of Preferences

* short vs detailed answers
* language (EN / RU / etc.)
* technical depth
* code vs explanation balance
* formatting (lists, steps, minimal text)

---

## System Architecture Changes

Extend the agent pipeline:

```id="t7k2m1"
INPUT
  ↓
[1] Memory Read
  ↓
[2] Load User Profile
  ↓
[3] Context Builder (memory + profile)
  ↓
[4] Prompt Construction
  ↓
[5] LLM Execution
  ↓
[6] Memory Decision
  ↓
[7] Profile Update Decision
  ↓
OUTPUT
```

---

## Components to Implement

### 1. Profile Manager

Responsible for:

* storing user profile
* retrieving profile on each request
* updating profile when needed

Requirements:

* profile must be independent from other memory layers
* clear API (get / update)

---

### 2. Context Builder (Extended)

Must now include:

* relevant memory
* **user profile**

Rules:

* profile must always be injected
* must be structured (not dumped as text)
* must influence response behavior, not content facts

---

### 3. Prompt Builder (Updated)

Prompt must:

* describe system behavior
* include profile as **rules/instructions**
* enforce preferences (style, tone, constraints)

---

### 4. Profile Decision Engine

After each interaction:

* detect if new preferences appeared
* decide whether to update profile

Examples:

| Input                        | Action           |
| ---------------------------- | ---------------- |
| "be shorter"                 | update verbosity |
| "use bullet points"          | update format    |
| "no explanations, only code" | add constraint   |

---

## Profile vs Memory (Important Distinction)

| Aspect     | Memory Layers   | User Profile      |
| ---------- | --------------- | ----------------- |
| Purpose    | context & state | behavior control  |
| Volatility | varies          | relatively stable |
| Structure  | mixed           | strict            |
| Usage      | optional        | always applied    |

---

## Integration Rules

* profile must NOT be mixed into working memory
* profile must NOT be treated as chat history
* profile must be injected **every time**
* memory and profile must be combined only in context builder

---

## Behavior Expectations

With personalization, the agent should:

* automatically adjust response style
* not require repeated user instructions
* remain consistent across interactions

---

## Evaluation Scenarios

### 1. Different Profiles

Test with multiple profiles:

* concise user
* verbose user
* code-only user

Check:

* response length
* structure
* tone

---

### 2. Dynamic Preference Update

User changes preference mid-session:

```id="k2l9zm"
User: explain
User: actually, be short
```

Expected:

* profile updates
* next responses adapt automatically

---

### 3. No Explicit Instructions

If profile exists:

* agent must apply it without user reminders

---

## Observability (Required)

Add visibility into:

* current user profile
* profile changes after each interaction
* how profile affects prompt

---

## Constraints

* do not overfit (avoid storing temporary instructions)
* do not overwrite profile aggressively
* avoid conflicting preferences (resolve or normalize)

---

## Anti-Patterns

* treating profile as long-term memory dump
* injecting profile as raw text without structure
* ignoring profile during prompt building
* updating profile on every message without filtering

---

## Expected Outcome

An agent that:

* adapts responses to the user automatically
* maintains consistent style and format
* evolves profile over time
* integrates personalization cleanly into the existing architecture

---

## Key Idea

Personalization is not memory.

It is a **control layer over behavior**, applied systematically on top of memory.
