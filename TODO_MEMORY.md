# TODO_MEMORY.md

## Goal

Design and implement a **layered memory system** as part of the agent architecture.

This is **not a storage task**, but a **context orchestration system** that controls:

* what the agent remembers
* what the agent uses for reasoning
* what the agent persists over time

---

## Core Principle

Memory must be treated as part of the **agent decision pipeline**, not as a passive datastore.

The system must explicitly handle:

* **selection** (what to read)
* **injection** (what goes into context)
* **extraction** (what to save)
* **separation** (where it belongs)

---

## Memory Layers

Implement **three strictly separated memory layers**:

### 1. Short-Term Memory

Represents the **current conversation**.

**Characteristics:**

* stores recent messages
* limited size (sliding window)
* ephemeral (session-scoped)

**Purpose:**

* maintain conversational continuity

---

### 2. Working Memory

Represents the **state of the current task**.

**Characteristics:**

* structured (not raw text)
* mutable
* task-scoped

**Examples:**

* current goal
* intermediate steps
* constraints
* extracted entities

**Purpose:**

* prevent re-parsing conversation
* maintain focus and state

---

### 3. Long-Term Memory

Represents **persistent knowledge about the user and past interactions**.

**Characteristics:**

* durable across sessions
* selectively written
* structured

**Examples:**

* preferences
* recurring patterns
* stable facts

**Purpose:**

* personalization
* consistency across sessions

---

## System Architecture

Memory must be integrated into the agent pipeline as follows:

```
INPUT
  ↓
[1] Memory Read
  ↓
[2] Context Builder
  ↓
[3] Prompt Construction
  ↓
[4] LLM Execution
  ↓
[5] Memory Decision
  ↓
[6] Memory Write
  ↓
OUTPUT
```

---

## Components to Implement

### 1. Memory Manager

Responsible for:

* storing layers independently
* reading layers
* writing updates

Requirements:

* layers must not leak into each other
* clear API for read/write operations

---

### 2. Context Builder (Critical Component)

Responsible for:

* selecting relevant data from each memory layer
* constructing structured context

Rules:

* do not pass entire memory blindly
* prioritize relevance over completeness
* enforce separation of layers in context

---

### 3. Prompt Builder

Responsible for:

* assembling final LLM input

Prompt must:

* describe system behavior (not just task)
* clearly distinguish memory layers
* avoid dumping raw data without structure

---

### 4. Decision Engine (Post-Processing)

Responsible for:

* deciding what to store after each interaction

Must:

* classify information into memory layers
* ignore irrelevant/noisy data
* prevent duplication and drift

---

## Memory Write Strategy

Every interaction must go through explicit classification:

| Data Type                 | Layer      |
| ------------------------- | ---------- |
| Recent messages           | Short-term |
| Task-related state        | Working    |
| Preferences / stable info | Long-term  |

Do not:

* store everything
* store raw text without structure
* promote temporary data to long-term

---

## Memory Read Strategy

When building context:

* Short-term → recent messages only
* Working → full current task state
* Long-term → only relevant subset

Filtering is mandatory.

---

## Constraints

* No implicit memory usage
* No hidden side effects
* All memory writes must be explicit and observable
* All layers must be independently inspectable

---

## Observability (Required)

Add logging or inspection tools to verify:

* what is stored in each layer
* what is injected into context
* what is written after each step

Example checks:

* does short-term memory overflow correctly?
* does working memory update instead of append?
* does long-term memory avoid noise?

---

## Evaluation Scenarios

Test the system against:

1. **Single-turn question**

    * should only use short-term memory

2. **Multi-step task**

    * should rely on working memory

3. **Preference learning**

    * should update long-term memory

4. **Context switching**

    * working memory must reset or adapt

---

## Anti-Patterns to Avoid

* dumping entire memory into prompt
* mixing memory layers
* storing unfiltered LLM outputs
* treating memory as a log instead of a system

---

## Expected Outcome

An agent that:

* maintains clean separation of memory layers
* uses memory intentionally, not passively
* produces more stable and context-aware responses
* can be extended with new memory strategies without breaking existing logic

---

## Key Idea

This system is not about remembering more.

It is about **remembering the right things, in the right place, at the right time**.
