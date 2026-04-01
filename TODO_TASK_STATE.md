# TODO_TASK_STATE.md

## Goal

Introduce a **formal Task State Machine (FSM)** into the agent architecture.

The agent must explicitly track and operate on **task state**, enabling:

* controlled progression through task stages
* pause/resume without losing context
* elimination of repeated explanations

This is not just tracking progress — it is about **making task execution deterministic and state-driven**.

---

## Core Principle

The agent must **not infer task progress from chat history**.

Instead, it must:

* explicitly store task state
* transition between states intentionally
* use state as a primary input for reasoning

---

## Task State Model

Define a structured **Task State**:

```id="p4x8zn"
TaskState = {
  stage: ...,
  step: ...,
  expectedAction: ...,
  data: { ... }
}
```

---

## Required State Dimensions

### 1. Stage (High-level phase)

Represents the global phase of the task.

**Example stages:**

* planning
* execution
* validation
* done

---

### 2. Step (Current step)

Represents the **specific unit of work** inside a stage.

Examples:

* "design architecture"
* "implement module"
* "write tests"

---

### 3. Expected Action

Represents what should happen next:

* user input required
* agent action required
* waiting / paused

---

### 4. Data (Optional but recommended)

Structured data relevant to the task:

* intermediate results
* decisions made
* artifacts

---

## System Architecture Changes

Extend existing pipeline:

```id="n8q2w1"
INPUT
  ↓
[1] Memory Read
  ↓
[2] Load User Profile
  ↓
[3] Load Task State
  ↓
[4] Context Builder (memory + profile + task state)
  ↓
[5] Prompt Construction
  ↓
[6] LLM Execution
  ↓
[7] State Transition Decision
  ↓
[8] Memory / State Write
  ↓
OUTPUT
```

---

## Components to Implement

### 1. Task State Manager

Responsible for:

* storing current task state
* retrieving state
* applying transitions

Requirements:

* state must be explicit and inspectable
* no implicit transitions
* persistent within task scope

---

### 2. State Machine Definition

Define allowed transitions:

```id="b2k9lx"
planning → execution → validation → done
```

Rules:

* transitions must be controlled
* skipping stages should be explicit
* invalid transitions must be prevented

---

### 3. Context Builder (Extended)

Must include:

* current task state
* relevant memory
* user profile

Rules:

* state must be first-class input
* do not reconstruct state from chat
* prioritize state over short-term memory when conflicting

---

### 4. State Transition Engine

After each interaction, decide:

* whether to stay in current state
* move to next step
* change stage
* pause

Input:

* user message
* current state
* agent output

Output:

```id="g7l2as"
{
  nextStage?: ...,
  nextStep?: ...,
  expectedAction?: ...
}
```

---

## State Behavior Rules

### Planning Stage

* define goal
* break into steps
* move to execution only when plan is clear

---

### Execution Stage

* perform steps
* update progress
* may loop across multiple steps

---

### Validation Stage

* verify results
* check completeness
* may return to execution if needed

---

### Done Stage

* finalize
* no further actions unless new task starts

---

## Pause / Resume Support

The system must support:

### Pause

```id="k8d1pz"
expectedAction = "waiting"
```

### Resume

* continue from same stage and step
* no re-explanation of previous work

---

## Integration with Working Memory

* Task State must be stored **separately but alongside working memory**
* Working memory holds **data**
* Task State holds **control flow**

Do not mix them.

---

## Observability (Required)

Expose:

* current task state
* state transitions
* history of transitions (optional but recommended)

---

## Evaluation Scenarios

### 1. Multi-step Task

* verify correct transitions
* ensure no step repetition

---

### 2. Pause Mid-Execution

* user interrupts
* system must preserve state

---

### 3. Resume Task

* user continues later
* agent must not restart or re-explain

---

### 4. Invalid Input

* ensure state does not break
* remain stable or request clarification

---

## Constraints

* no hidden state
* no inference from chat instead of state
* transitions must be explicit
* state must remain minimal but sufficient

---

## Anti-Patterns

* deriving task progress from conversation
* mixing task state with memory layers
* skipping validation stage implicitly
* resetting state unintentionally

---

## Expected Outcome

An agent that:

* operates as a **state-driven system**
* progresses through tasks predictably
* supports pause and resume seamlessly
* avoids redundant explanations
* maintains clear execution flow

---

## Key Idea

Task State is not memory.

It is a **control system that governs how the agent thinks and acts over time**.
 