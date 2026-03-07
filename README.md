# CRDT Foundation — Study Notes

Working through **"A Comprehensive Study of Convergent and Commutative Replicated Data Types"** (Shapiro et al., INRIA).

Goal: understand the paper section by section, implement 7 CRDTs covering both state-based and op-based patterns, then move to YJS internals.

**→ [Study Roadmap, Day-by-Day Journal & Phase Checklists](./STUDY_ROADMAP.md)**

The roadmap captures the full learning plan, what was studied each day, why certain specs were skipped, and answers to every phase checkpoint — tracking the path from the paper's theory to YJS's engineering decisions.

**→ [YJS Source Notes, Doubts & Contribution Tracker](./yjs-learning/README.md)**

Tracks YJS source file annotations, the theory→code mapping, open questions from reading and building, and potential contribution candidates identified along the way.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [System Model](#system-model)
- [Section 2.1 — Atoms and Objects](#section-21--atoms-and-objects)
- [Section 2.2 — Operations](#section-22--operations)
- [Specification 1 — State-Based Object (CvRDT)](#specification-1--state-based-object-cvrdt)
- [Section 2.2.1 — State-Based Replication (deeper)](#section-221--state-based-replication-deeper)
- [Section 2.2.2 — Operation-Based Replication (CmRDT)](#section-222--operation-based-replication-cmrdt)
- [Implementations](#implementations)
  - [The 21 Specs — What to Read and What to Skip](#the-21-specs--what-to-read-and-what-to-skip)
  - [Why these 7?](#why-these-7)
  - [Why Both Models — State-Based and Op-Based?](#why-both-models--state-based-and-op-based)
  - [Reading Guide — Skipped Specs](#reading-guide--skipped-specs)
  - [How to Test Each CRDT](#how-to-test-each-crdt)
- [Spec 19 — RGA (Replicated Growable Array)](#spec-19--rga-replicated-growable-array)
- [YJS Source Notes →](./yjs-learning/README.md)
- [Section 4 — Garbage Collection](#section-4--garbage-collection)
  - [4.1 Stability Problems](#41-stability-problems)
  - [Specification 21 — Op-based OR-Cart](#specification-21--op-based-or-cart)
  - [4.2 Commitment Problems](#42-commitment-problems)
- [Section 5 — Putting CRDTs to Work](#section-5--putting-crdts-to-work)
  - [5.1 Observed-Remove Shopping Cart](#51-observed-remove-shopping-cart)
  - [5.2 E-commerce Bookstore](#52-e-commerce-bookstore)
- [Section 6 — Comparison with Previous Work](#section-6--comparison-with-previous-work)
- [Section 7 — Conclusion](#section-7--conclusion)

---

## Getting Started

```bash
npm install
npm test
```

Vitest will run all test files across all CRDT folders and watch for changes. Press `q` to quit.

---

## Project Structure

```
crdt-foundation/
├── (1) g-counter/
│   ├── implementation.ts       # G-Counter class
│   ├── implementation.test.ts  # Tests
│   └── README.md               # Concept, drawbacks, bridge to YJS
│
├── (2) 2p-set/
│   ├── implementation.ts       # TwoPhaseSet class
│   ├── implementation.test.ts  # Tests
│   └── README.md
│
├── (3) lww-register/
│   ├── implementation.ts       # LWWRegister<T> class
│   ├── lww-register.test.ts    # Tests
│   └── README.md
│
├── (4) or-set/
│   ├── implementation.ts       # ORSet class
│   ├── or-set.test.ts          # Tests
│   └── README.md
│
├── (5) mv-register/
│   ├── implementation.ts       # MVRegister<T> class
│   ├── mv-register.test.ts     # Tests
│   └── README.md
│
├── (6) op-lww-register/
│   ├── implementation.ts       # OpLWWRegister<T> — op-based, write()/apply()
│   ├── op-lww-register.test.ts # Tests
│   └── README.md
│
├── (7) op-or-set/
│   ├── implementation.ts       # OpORSet — op-based, no tombstones
│   ├── op-or-set.test.ts       # Tests
│   └── README.md
│
├── README.md                   # This file — theory notes + implementation index
├── package.json
└── tsconfig.json
```

---

## System Model

A distributed system where:
- Multiple **processes** each hold a local replica of shared data
- The network is **asynchronous** — messages can be delayed or lost
- The network can **partition** (nodes lose contact) and recover
- A node can **crash and restart** — its local memory survives
- Nodes are **non-byzantine** — they may fail, but they don't lie or send fake data

---

## Section 2.1 — Atoms and Objects

### Atoms

An **atom** is a plain, immutable value — a number, string, set, tuple, etc.

- `42`, `"hello"`, `{1, 2, 3}` are all atoms
- Two atoms are **equal if their content is the same** — no identity, just value
- Atoms can be freely copied between processes

> Think of atoms like sticky notes. Two notes both saying `"42"` are identical — doesn't matter who wrote them.

---

### Objects

An **object** is a mutable, replicated piece of state — a counter, a set, a register, etc.

- Every process holds its **own local replica** of the object
- Replicas can **diverge temporarily** when nodes are disconnected
- A CRDT guarantees they will **eventually converge** to the same state

> Think of a shared Google Doc where everyone edits offline. A CRDT is the rule that says how to merge everyone's edits when they reconnect — and guarantees the result is always the same regardless of order.

---

### Objects (continued)

An object has 4 properties:

| Property | What it means |
|---|---|
| **Identity** | A unique name/ID — like a variable name `x` |
| **Payload** | The actual data stored inside it (can be atoms or other objects) |
| **Initial state** | What it looks like when first created |
| **Interface** | The operations you can call — `add()`, `remove()`, `increment()`, etc. |

Atoms have no identity — two `42`s are the same thing. But two objects can share an identity while living on different machines — those are **replicas**.

```
Object x  (logical, abstract)
   ├── x1  (replica on process 1)
   ├── x2  (replica on process 2)
   └── x3  (replica on process 3)  ← payload = { 123, -99, 3.14159 }
```

**The paper's assumption:** it focuses on **one object at a time** — no transactions, no multi-object ops. This is why "process" and "replica" are used interchangeably throughout.

> When we implement CRDTs in code, we model exactly these four things: identity, payload, initial state, and interface.

#### Why no transactions?

In real systems you might want to do something like:

```
transfer(account_A, account_B, 100)
// deduct from A AND add to B — atomically
```

That's a **transaction** — it spans two objects and must succeed or fail together (**atomic** = either both happen, or neither does). This requires coordination — both objects must agree, at the same moment.

CRDTs are designed for systems where coordination is expensive or impossible (nodes offline, slow network, etc.). Requiring two objects to agree simultaneously defeats the whole point.

So the paper asks a smaller question instead:

> Can **one replicated object** converge across all nodes that hold a copy of it?

```
Node 1 has Account_A = 500
Node 2 has Account_A = 500

Node 1 does: -= 100  →  400
Node 2 does: -= 50   →  450

(network reconnects)

Merge → 350  ✓  (should reflect both operations)
```

Solving this — one object, multiple replicas, no coordination — is what the entire paper is about.

#### "Without loss of generality"

Means: by focusing on one object, we're not missing anything important. If every individual object can converge on its own, you can build larger systems by composing them. The core hard problem doesn't change by looking at one object at a time.

---

### The Two Classic Examples

#### G-Set (Grow-only Set) — Figure 2

- You can only **add** elements, never remove
- Merge rule: take the **union** of both replicas
- Convergence is trivial — union is commutative and associative

```
Replica A: {a, b}
Replica B: {b, c}
Merged:    {a, b, c}  ✓ always the same
```

#### 2P-Set (Two-Phase Set) — Figure 3

- Internally has two sets: `A` (added) and `R` (removed)
- You can add and remove elements
- **Once removed, an element can never come back** — the remove wins permanently
- An element is "in" the set if it's in `A` but not in `R`

```
add(a) → A={a}, R={}      → {a} is in the set
remove(a) → A={a}, R={a}  → {a} is NOT in the set
add(a) → A={a}, R={a}     → still NOT in the set (remove wins)
```

---

### The Big Picture

The whole paper answers one question:

> **How do you design data structures that multiple nodes can modify independently, and still end up consistent — without any coordination?**

The answer: design the **operations** and **merge rules** so that no matter what order things happen in, the final result is always the same.

This property is called **Strong Eventual Consistency (SEC)**.

---

## Section 2.2 — Operations

### Clients and Source Replicas

A **client** is anything that uses your data — a user, an app, a service. It doesn't talk to a central server. It picks any nearby replica and talks to that. That replica is called the **source replica** for that operation.

```
Client → picks → Replica 2 (source)
                     |
              does the operation here first
```

### Two Types of Operations

#### Query
- Read-only, executes **entirely locally** — no network involved
- Just looks at the local payload and returns a value
- Examples: `get()`, `contains(x)`, `size()`

#### Update
- Modifies state, has **two phases:**

```
Phase 1 — at the source replica:
  Client calls update (e.g. add("x"))
  Source does some initial processing locally

Phase 2 — downstream:
  The update is sent asynchronously to ALL other replicas
  Each replica applies it when it arrives
```

**Asynchronously** = the client doesn't wait. The source doesn't block until everyone agrees. It fires the update and moves on. Other replicas catch up eventually.

### The Two Styles (preview)

There are two ways to design how updates propagate:

| Style | What travels over the network |
|---|---|
| **State-based** | Send the entire payload — recipient merges it |
| **Op-based** | Send just the operation — recipient replays it |

Think of it like syncing a document:
- **State-based** = send the whole document every time, merge on arrival
- **Op-based** = send just "I added 'hello' at line 3", recipient applies that change

Both can achieve convergence — they make different tradeoffs.

> Key insight: updates are not instant and not global. They start local, then ripple out. The challenge of CRDTs is designing merge/apply rules so that no matter what order ripples arrive, every replica ends up in the same state.

---

## Specification 1 — State-Based Object (CvRDT)

This is the formal **template** every state-based CRDT must fill in:

```
payload  — what data does this object store?
initial  — what's the starting value?
query    — how do you read from it?
update   — how do you modify it (locally)?
compare  — how do you compare two states?
merge    — how do you combine two replicas?
```

### `payload` and `initial`

The data stored inside the replica and its starting value.

```
payload  integer x
initial  0          ← every replica starts at 0
```

### `query`

Read-only. Runs **locally**, no network. Optional `pre` (precondition) guards it.

```
query get() : integer
  let b = x        ← just read local payload, no side effects
  return b
```

### `update`

Modifies state at the **source replica first**. Has two sub-parts:
- `let` — evaluate something synchronously at source
- side-effects — actually mutate the local payload

```
update set(integer v)
  pre  v > x       ← precondition: only update if v is bigger
  let  x := v      ← mutate local state
```

The mutation then **propagates downstream** to all other replicas via `merge`.

### `compare` — the Semilattice

> "Is value1 ≤ value2 in semilattice?"

Forget math for a second. A **semilattice** is just a way of saying:

> "There is a direction things can only move in, and any two states can always be combined into one."

Think of it like **water flowing downhill**. Water only flows one way — down. It never flows back up. And if two streams meet, they merge into one. That's a semilattice. States only move "forward" (in terms of information), and any two states can always be merged into one.

For integers with `max`, the direction is just the number line — you can only go forward:

```
0 -- 1 -- 2 -- 3 -- 4 -- 5 -- 6 -- 7 ...
↑
start
```

You can never go from `7` back to `3`. Any integer is "above" all integers to its left. This ordering IS the semilattice.

```
compare(3, 5) → true    (3 ≤ 5, so 5 has seen more)
compare(5, 3) → false
```

For **sets**, the direction is subset ordering — more elements = higher up:

```
        {a, b}       ← "highest", seen the most
       /      \
     {a}      {b}    ← each replica saw something different
       \      /
         {}          ← "lowest", seen nothing
```

---

### `merge` — the Heart of CvRDTs

> "LUB merge of value1 and value2, at any replica"

**LUB = Least Upper Bound** = the smallest state that is ≥ both inputs — the minimum merge point that respects both replicas.

#### For integers:

```
Replica A evolved to: 5
Replica B evolved to: 3

Values ≥ 5:       5, 6, 7, 8, ...
Values ≥ 3:       3, 4, 5, 6, 7, ...
Values satisfying BOTH: 5, 6, 7, ...
Smallest → 5

LUB(5, 3) = max(5, 3) = 5
```

#### For sets:

```
Replica A: {a}     (added 'a')
Replica B: {b}     (added 'b')

Sets ⊇ {a}:   {a}, {a,b}, {a,c}, ...
Sets ⊇ {b}:   {b}, {a,b}, {b,c}, ...
Sets satisfying BOTH: {a,b}, {a,b,c}, ...
Smallest → {a, b}

LUB({a}, {b}) = union({a}, {b}) = {a, b}
```

Union IS the LUB for sets — that's why G-Set merge = union. Not a coincidence.

#### Quick reference:

```
For integers:  LUB = max()
For sets:      LUB = union()
For booleans:  LUB = OR()   (false < true, once true always true)
```

> The CRDT designer's job: pick a semilattice where your merge = LUB. If you do that, convergence is mathematically guaranteed for free.

---

`merge` must satisfy three laws to **guarantee convergence**:

| Law | Formal | Why it matters |
|---|---|---|
| **Commutative** | `merge(A, B) = merge(B, A)` | Network delivery order doesn't matter |
| **Associative** | `merge(A, merge(B,C)) = merge(merge(A,B), C)` | Who merges with who first doesn't matter |
| **Idempotent** | `merge(A, A) = A` | Duplicate messages don't corrupt state |

Without **commutativity**: replicas receiving updates in different order diverge permanently.
Without **associativity**: result depends on merge order — chaos.
Without **idempotency**: receiving the same state twice corrupts state.

---

### Figure 5 — Integer + Max (simplest CvRDT)

```
Start:  x1=0, x2=0, x3=0

x1 := 1   →   x1=1
x2 := 4   →   x2=4

merge(x1, x2) = max(1, 4) = 4
merge(x2, x3) = max(4, 0) = 4

Final: x1=4, x2=4, x3=4  ✓ converged
```

No matter what order the merges happen, everyone ends up at `4` — the maximum value seen across all replicas.

### Figure 4 — State-Based Replication (general pattern)

Three replicas, all start at the same state. Say `0`:

```
x1 = 0,  x2 = 0,  x3 = 0
```

**Step 1 — Local updates happen independently**

```
Client hits x1 → f(x1): set to 3   →   x1 = 3
Client hits x2 → g(x2): set to 7   →   x2 = 7
x3 = 0  (nobody talked to x3)
```

x1 has no idea x2 changed, and vice versa.

**Step 2 — x1 and x2 send their FULL state to x3**

They don't say "I did operation f". They say "my entire payload is now 3" / "my entire payload is now 7".

```
x1 → sends entire state (3) → x3
x2 → sends entire state (7) → x3
```

**Step 3 — x3 calls merge**

```
x3.merge(3, 7) = max(3, 7) = 7   →   x3 = 7  ✓
```

**Step 4 — x3 propagates merged state back**

```
x3 → sends 7 → x1    x1.merge(3, 7) = 7  ✓
x3 → sends 7 → x2    x2.merge(7, 7) = 7  ✓  (idempotent — harmless)
```

**Full timeline:**

```
         x1          x2          x3
          |           |           |
start:    0           0           0
          |           |           |
update:  f()→3      g()→7         |
          |           |           |
          |----(3)--------------->|   x1 sends full state
          |           |-(7)------>|   x2 sends full state
          |           |           |
          |           |      merge(3,7)=7
          |           |           |
          |<----------+-----(7)---|   x3 sends merged state back
          |<-(7)------+-----------|
          |           |           |
end:      7           7           7   ✓
```

**The important thing:** at no point did any replica wait for another before doing its update. x1 and x2 did their thing locally. Merge happened after the fact, asynchronously.

Because `merge = max` satisfies all three laws, it doesn't matter:
- which order states arrived at x3
- whether x3 got x1's state before or after x2's
- whether x1 received x3's merge before or after x2 did

The result is always `7`. That's the guarantee.

> The key: you send the **entire payload**, not just the operation. The recipient calls `merge` on arrival. As long as `merge` is a valid LUB, convergence is **mathematically guaranteed** — no coordination needed.

---

### Does x3 merge with itself?

Yes — x3 always merges its **current state** with each incoming state, one at a time. It never batch-merges. The full picture at x3:

```
x3 starts at 0

x1's state (3) arrives:
  x3 = merge(0, 3) = max(0, 3) = 3

x2's state (7) arrives:
  x3 = merge(3, 7) = max(3, 7) = 7
```

x3's initial `0` gets absorbed because `max(0, anything ≥ 0) = that thing`.

**What if x2 arrived first?**

```
x3 = merge(0, 7) = 7
x3 = merge(7, 3) = 7   ✓ same result  ← Commutativity
```

**What if both arrived at the same time?**

```
merge(merge(0, 3), 7) = merge(3, 7) = 7
merge(0, merge(3, 7)) = merge(0, 7) = 7   ✓ same result  ← Associativity
```

All three laws work together — none alone is enough:

| Law | Protects against |
|---|---|
| **Commutativity** | States arriving in different order |
| **Associativity** | States being grouped or batched differently |
| **Idempotency** | Same state arriving more than once |

---

## Section 2.2.1 — State-Based Replication (deeper)

### Atomicity

An operation either fully completes or doesn't happen at all. No replica ever sees a half-applied operation. While an update is running, nothing else can interrupt it.

### Preconditions (`pre`)

A precondition is a **guard** — the operation only runs if the condition is true at the source right now.

```
update remove(element e)
  pre  e ∈ payload        ← can only remove if e actually exists
  let  payload := payload \ {e}
```

If the precondition is false, the operation is **disabled** — it simply doesn't execute. Some operations have no precondition (always enabled):

```
update increment()
  let  x := x + 1         ← no pre needed, always valid
```

### Causal History `C(xi)`

A logical bookkeeping tool — not stored in the object, just used for reasoning. Tracks: *"what operations has this replica seen so far?"*

| Rule | Meaning |
|---|---|
| `C(xi) = ∅` | Replica starts knowing nothing |
| `C(f(xi)) = C(xi) ∪ {f}` | After update f — add f to what this replica has seen |
| `C(merge(xi, xj)) = C(xi) ∪ C(xj)` | After merge — union of what both replicas knew |

**Concrete example:**

```
x1 does add("a"):   C(x1) = {add_a}
x2 does add("b"):   C(x2) = {add_b}

x1 merges with x2:
  C(x1) = {add_a} ∪ {add_b} = {add_a, add_b}

x1 now knows about both operations.
x2 still only knows {add_b}.
```

### Happens-Before (`f → g`)

> `f → g  ⟺  C(f) ⊂ C(g)`

**f happened before g** means: g's causal history strictly contains f's — g "knows about" f, but f doesn't know about g.

```
x1 does add("a"):   C = {add_a}
x1 does add("b"):   C = {add_a, add_b}

{add_a} ⊂ {add_a, add_b}  →  add_a → add_b  ✓  (add_a happened before add_b)
```

If neither contains the other — the operations are **concurrent** (happened independently, neither knows about the other):

```
x1 does add("a"):   C(x1) = {add_a}
x2 does add("b"):   C(x2) = {add_b}

{add_a} ⊄ {add_b}  and  {add_b} ⊄ {add_a}

→ add_a and add_b are concurrent
```

### Liveness

> "Any update eventually reaches the causal history of every replica."

Two assumptions the paper makes to guarantee this:
1. The system transmits states between pairs of replicas **infinitely often**
2. Replica communication forms a **connected graph**

```
x1 --- x2 --- x3    ✓ connected — update from x1 will reach x3 via x2
x1     x2 --- x3    ✗ NOT connected — x1 is isolated, updates never reach x3
```

Without liveness you have **safety** (no incorrect states) but no **progress** (replicas might never converge).

---

## Section 2.2.2 — Operation-Based Replication (CmRDT)

Instead of sending the full payload, send the **operation itself**. Each replica replays it.

```
State-based:  "my payload is now {a, b, c}"   ← send whole state
Op-based:     "please execute add('c')"         ← send the operation
```

### The Two Phases

**Phase 1 — `atSource`** (local, synchronous, no side effects):
- Runs only at the source replica
- Validates the precondition against local state
- Prepares arguments to pass to phase 2
- Can return a result to the caller
- Cannot mutate state

**Phase 2 — `downstream`** (async, runs at every replica):
- Runs at source immediately, then at all other replicas asynchronously
- Actually mutates the payload
- Has its own precondition checked at each replica before applying
- Cannot return results

```
update add(element e)
  atSource(e):
    pre  e ∉ payload          ← validate locally (phase 1)
    let  t = now()            ← prepare args for phase 2

  downstream(e, t):
    payload := payload ∪ {e}  ← actual mutation (phase 2)
```

**Timeline:**

```
Client
  │
  ▼
Source replica
  │
  ├── Phase 1 (atSource): validate, prepare    ← here only, right now
  │
  └── Phase 2 (downstream): mutate ──────────► all replicas (async)
                                                 each applies when received
```

### Downstream Precondition

The downstream phase has its own `pre` checked at **each replica** before applying. This matters because replicas may be in different states when the operation arrives.

```
downstream remove("a"):
  pre  "a" was already added    ← must be true at THIS replica before removing
  payload := payload \ {"a"}
```

If a replica hasn't seen `add("a")` yet, it must **wait** before applying `remove("a")`. This is enforced by causal delivery.

### Reliable Broadcast

For op-based, the network must guarantee:
- Every operation is delivered to **every replica** (no drops)
- Delivered **exactly once** (no duplicates)
- In an order where downstream preconditions are satisfied

This is stronger than what state-based needs. State-based is forgiving because merge is idempotent — duplicate deliveries are harmless. Op-based operations may not be idempotent, so the network must do more work.

### Causal Delivery

> "If `f → g` then f is delivered before g at every replica."

If operation g causally depends on f, every replica must apply f before applying g — even if g arrives over the network first.

```
x1: add("a")  →  remove("a")    ← remove depends on add having happened

Replica x2 must receive and apply add("a") BEFORE remove("a")
Even if remove("a") arrives first — it must wait
```

Without causal delivery, a replica might try to remove "a" before it was ever added — violating the downstream precondition.

### State-based vs Op-based — Side by Side

| | State-based (CvRDT) | Op-based (CmRDT) |
|---|---|---|
| What travels over network | Full payload | The operation |
| Network requirement | Best-effort | Reliable broadcast |
| Duplicate messages | Harmless (idempotent merge) | Must be avoided |
| Merge rule needed | Yes (`merge` = LUB) | No |
| Operations must be | — | Commutative |
| Bandwidth | Higher (full state) | Lower (just the op) |

---

## Implementations

### All 21 Specs — What We Implemented and What We Skipped

The 21 specs in the paper are a **catalog, not a curriculum**. Specs 1 and 2 are skeleton templates — every other spec fills in those templates for a specific data structure.

| Spec | Exact Name in Paper | Our Decision |
|---|---|---|
| 1 | Outline of a state-based object (CvRDT template) | ✅ Covered during paper reading |
| 2 | Outline of an operation-based object (CmRDT template) | ✅ Covered during paper reading |
| 3 | Op-based emulation of state-based object | ⬜ Skip — pure theory |
| 4 | State-based emulation of op-based object | ⬜ Skip — pure theory |
| 5 | Op-based Counter | ⬜ Skip — trivial after G-Counter |
| 6 | State-based G-Counter (increment-only vector counter) | ✅ **Implemented** |
| 7 | State-based PN-Counter | 📖 Good to read — CRDT composition |
| 8 | State-based LWW-Register | ✅ **Implemented** |
| 9 | Op-based LWW-Register | ✅ **Implemented** |
| 10 | State-based MV-Register (Multi-Value Register) | ✅ **Implemented** |
| 11 | State-based G-Set (Grow-only Set) | ⬜ Skip — already inside 2P-Set and OR-Set |
| 12 | State-based 2P-Set (Two-Phase Set) | ✅ **Implemented** |
| 13 | Op-based U-Set (2P-Set with unique elements) | 📖 Good to read — tombstones drop under causal delivery |
| 14 | Op-based Molli-Weiss-Skaf Set (PN-Set variant) | ⬜ Skip — anomaly-for-anomaly tradeoff, unused |
| 15 | Op-based OR-Set (Observed-Remove Set) | ✅ **Implemented** (both state-based and op-based variants) |
| 16 | Op-based 2P2P-Graph | ⬜ Skip — graphs, not sequences |
| 17 | Op-based Add-only Monotonic DAG | ⬜ Skip — graphs, not sequences |
| 18 | Op-based Add-Remove Partial Order | ⬜ Skip — basis for WOOT, not YATA |
| 19 | Op-based RGA (Replicated Growable Array) | 📌 **Must read** — main competing sequence CRDT to YATA |
| 20 | Op-based Mutable sequence based on the continuum | 📖 Good to read — Logoot-style identifiers |
| 21 | Op-based OR-Cart (Observed-Remove Shopping Cart) | 📌 **Must read** — OR-Set applied to a map; direct precursor to Y.Map |

---

### Why these 7?

The first 5 cover every fundamental state-based pattern. The last 2 cover the op-based (CmRDT) model — which is how YJS actually works.

| Spec | CRDT | Model | Status | What it teaches |
|---|------|-------|--------|-------|
| **Spec 6** | **[G-Counter](./(1)%20g-counter/README.md)** | State-based | ✅ Done | Vector clocks, semilattice, element-wise max merge |
| **Spec 12** | **[2P-Set](./(2)%202p-set/README.md)** | State-based | ✅ Done | Tombstoning, remove-wins, preconditions |
| **Spec 8** | **[LWW-Register](./(3)%20lww-register/README.md)** | State-based | ✅ Done | Timestamp conflict resolution, tiebreakers, silent data loss |
| **Spec 15** | **[OR-Set (state-based)](./(4)%20or-set/README.md)** | State-based | ✅ Done | Unique tags, observed-remove, add-wins, unbounded tombstone storage |
| **Spec 10** | **[MV-Register](./(5)%20mv-register/README.md)** | State-based | ✅ Done | Conflict surfacing vs silent loss, vector-clock-based concurrency |
| **Spec 9** | **[Op-LWW-Register](./(6)%20op-lww-register/README.md)** | **Op-based** | ✅ Done | atSource/downstream split, ops as first-class objects, Lamport clock |
| **Spec 15** | **[Op-OR-Set](./(7)%20op-or-set/README.md)** | **Op-based** | ✅ Done | No tombstones, causal delivery, ops as direct YJS analogue |

---

### Why Both Models — State-Based and Op-Based?

YJS is op-based. So why did we spend 5 implementations on state-based CRDTs?

**State-based teaches the concepts. Op-based teaches the delivery mechanism. You cannot understand the delivery without first understanding the concepts.**

Every state-based implementation maps to something concrete inside YJS. Skip any one of them, and a piece of YJS becomes opaque:

| Our implementation | What it taught | Where it appears in YJS |
|---|---|---|
| **G-Counter** (state-based, Spec 6) | What a vector clock is and how replicas compare their knowledge | YJS's **state vector** (`Map<clientId, clock>`) is a G-Counter. When two peers connect, they exchange state vectors and compute what ops the other is missing — that comparison is exactly G-Counter's `compare()` |
| **2P-Set** (state-based, Spec 12) | Why you cannot truly delete distributed data — tombstoning is the only coordination-free approach | YJS's **DeleteSet** is a tombstone store. Deleted Items are not removed from the linked list — they are marked. Without understanding 2P-Set, the DeleteSet looks like an arbitrary design choice |
| **LWW-Register** (state-based, Spec 8) | How timestamp-based conflict resolution works, why tiebreakers must be data-based | **Y.Map** uses LWW with Lamport clocks for concurrent key writes. The conflict logic is identical — higher clock wins, clientId breaks ties |
| **OR-Set** (state-based, Spec 15 variant) | What unique tags per operation are, what observed-remove means, why tombstones grow unboundedly | Every YJS **Item** has a unique `{client, clock}` ID — this is the tag. The DeleteSet is the tombstone set. Observed-remove is how YJS handles concurrent insert+delete |
| **MV-Register** (state-based, Spec 10) | What the alternative to LWW looks like — keep all concurrent values, surface the conflict | Explains why YJS **chose LWW over MV for Y.Map**. Surfacing a conflict set on every concurrent map edit in a real-time editor would be unusable. LWW is the right tradeoff here |
| **Op-LWW-Register** (op-based, Spec 9) | The atSource/downstream two-phase split in code. Ops as small broadcast objects. Lamport clock generation | YJS insert: atSource captures `{client, clock}`, left/right origins → broadcast as an **Update** → each peer calls `Y.applyUpdate()` downstream. This is the exact same structure |
| **Op-OR-Set** (op-based, Spec 15) | No tombstone store when delivery is causal. Operations physically remove specific tags. Concurrent adds are never targeted | YJS insert/delete: the DeleteSet carries target Item IDs, not a separate accumulating store. Concurrent insertions are unaffected because they have fresh IDs never in any DeleteSet |

#### One important nuance about YJS's tombstones

The Op-OR-Set has no tombstones at all — physical deletion. YJS is slightly different:

YJS deleted Items **stay in the linked list** with a `deleted: true` flag — but their content is discarded. This is not the same as a growing tombstone store. The reason: Items serve a dual role in YJS. They are both **data** (the content you inserted) and **position anchors** (concurrent inserts reference left/right origin IDs to determine where to place themselves). Physically removing an Item would break those origin references and corrupt the ordering of concurrent inserts.

So YJS uses **structural tombstones** (keep the position, discard the content) — not the accumulating tombstone set that state-based OR-Set builds up. The Op-OR-Set teaches why tombstones can be avoided with causal delivery. YJS extends that idea: even the structural tombstone is minimised by discarding content.

#### Why YJS chose op-based

| Concern | State-based | Op-based (what YJS uses) |
|---|---|---|
| What travels on every keystroke | Full document state (MBs) | One operation (bytes) |
| Offline catch-up | Any sync catches up everything | Must retransmit missed ops from a log |
| Duplicate delivery | Harmless — merge is idempotent | Must be deduplicated (YJS uses `{client, clock}` as op ID) |
| Network requirement | Best-effort | Reliable + causal delivery |
| Rebuild from scratch | Impossible without full state sync | Replay the op log — YJS's document IS its op log |

Real-time collaborative editing has thousands of operations per minute. Sending full document state on every keystroke is not viable. Op-based wins on bandwidth by orders of magnitude. YJS manages the reliability and causal delivery requirements through state vector exchange on reconnect.

---

### Reading Guide — Skipped Specs

Not every spec needs to be implemented. But some are worth reading before moving to YJS. Here's the breakdown.

#### Legend
- 📌 **Must read** — directly required to understand YJS internals
- 📖 **Good to read** — builds useful context, 5–15 minutes each
- ⬜ **Skip** — no new insight beyond what we already implemented

---

#### ⬜ Specs 3–4: Emulation specs

Spec 3 shows how to emulate a state-based object using op-based delivery. Spec 4 is the reverse. Both prove the two styles are theoretically equivalent — but that proof is plumbing, not a new CRDT pattern. Skip.

#### ⬜ Spec 5: Op-based Counter

A trivial op-based counter. Increment and decrement just add/subtract locally — they commute because integer addition commutes. You already understand this from G-Counter. Skip.

#### 📖 Spec 7: State-based PN-Counter

Two G-Counters composed together — one for increments (`P`), one for decrements (`N`). `value() = sum(P) - sum(N)`. Merge each independently. Worth reading because it introduces **CRDT composition**: combining two CRDTs into a third. That pattern appears in OR-Set (two G-Sets inside it) and in YJS. Not worth implementing — it's literally two G-Counters.

#### ✅ Spec 9: Op-based LWW-Register

Implemented in folder `(6) op-lww-register/`. Same conflict resolution as Spec 8, but op-based — teaches the atSource/downstream two-phase structure in code. See [folder README](./(6)%20op-lww-register/README.md).

#### ⬜ Spec 11: State-based G-Set

Add-only set. Merge = union. We used this implicitly as the internal building block of 2P-Set and OR-Set. Already covered. Skip.

#### 📖 Spec 13: Op-based U-Set

2P-Set (Spec 12) simplified under two assumptions: elements are unique, and causal delivery guarantees add arrives before remove. Under these conditions the tombstone set (`R`) becomes unnecessary — remove can physically delete. Good to read because it shows how delivery guarantees can eliminate data structure complexity. That's a key insight for YJS, which relies heavily on causal delivery.

#### ⬜ Spec 14: Op-based Molli-Weiss-Skaf Set

A PN-Set variant that tries to fix one anomaly and creates another. Not clean enough to use in practice, introduces no new fundamental idea. Skip.

#### ⬜ Specs 16–18: Graph and Partial Order CRDTs

- **Spec 16 (2P2P-Graph):** Two 2P-Sets, one for vertices and one for edges, maintaining `E ⊆ V × V`.
- **Spec 17 (Add-only Monotonic DAG):** Edges can only be added if they maintain monotonic order — prevents cycles without coordination.
- **Spec 18 (Add-Remove Partial Order):** Basis for WOOT collaborative editing. Vertices in a partial order with tombstones.

YJS documents are sequences, not graphs. All three are theoretically interesting but contribute nothing to YJS understanding. Skip.

#### 📌 Spec 19: Op-based RGA (Replicated Growable Array)

**Read this before YJS.** RGA is the main competing sequence CRDT to YJS's YATA. The idea: every inserted element gets a unique `{replicaId, clock}` ID (sound familiar?). Concurrent inserts at the same position are ordered by comparing IDs — higher ID wins. The linked list is stable after merge.

YATA (YJS's algorithm) is a refinement of RGA that handles one interleaving anomaly RGA doesn't. You can't understand what YATA is fixing without knowing what RGA does. **Read the spec, don't implement.** Implementing would build muscle memory for the wrong algorithm.

#### 📖 Spec 20: Op-based Mutable sequence based on the continuum

Logoot-style: elements get real-number-like identifiers from a dense space, so a new ID can always be allocated between any two existing ones. The basis for Logoot and LSEQ. Further from YJS's approach than RGA, but worth 5 minutes to understand that there are two schools of sequence CRDT (identifier-based vs tombstone-linked-list-based). YJS is the latter.

#### 📌 Spec 21: Op-based OR-Cart (Observed-Remove Shopping Cart)

**Read this before YJS.** OR-Cart applies OR-Set (Spec 15) to a shopping cart map — the payload is `(isbn, quantity, unique-tag)` triplets instead of plain elements. `add` for an ISBN replaces all observed entries for that ISBN (observed-remove) with a new one. `remove` tombstones all observed entries for the ISBN.

This is OR-Set applied to a map. `Y.Map` is OR-Cart applied to a document. Reading it makes the jump from OR-Set to `Y.Map` a 2-line insight instead of a mystery.

---

### How to Test Each CRDT

Every CRDT needs the same three categories of tests:

**1. Operation correctness** — does `add`, `remove`, `increment` etc. actually do what it says?

**2. Convergence** — simulate replicas diverging, then merging in different orders. Both orderings must reach the same final state.

**3. Merge laws** — directly verify commutativity, associativity, idempotency.

Each implementation folder contains a test file covering all three categories, plus a **drawbacks** category that documents known limitations with concrete test cases.

---

## Spec 19 — RGA (Replicated Growable Array)

### The Problem

A text document is a **sequence** — a totally ordered list of characters. You need to insert and delete. The hard problem: two users concurrently insert at the **same position**. Who goes left? Who goes right? Without coordination, they must agree using only the data itself.

RGA's answer: give every insertion a **unique timestamp**. Use that timestamp as the tiebreaker. Higher timestamp = higher priority = goes earlier (to the left).

---

### The Data Structure

RGA is a **linked list** represented as a 2P-Set of vertices.

```
payload:
  VA  — set of added vertices     (the A set from 2P-Set)
  VR  — set of removed vertices   (tombstones, like 2P-Set's R set)
  E   — set of directed edges     (the linked list structure)
```

A **vertex** is a pair `(atom, timestamp)`:
- `atom` = the content — a character, string, XML tag, etc.
- `timestamp` = unique ID, ordered consistently with causality (later event = higher timestamp)

Two special sentinel vertices are always present:
```
⊢ = (⊥, -1)   ← left sentinel  — marks the START of the list
⊣ = (⊥,  0)   ← right sentinel — marks the END of the list
```

Initial state: just the two sentinels with one edge between them — an empty list:
```
⊢ ──→ ⊣
```

After inserting `'H'` then `'i'`:
```
⊢ ──→ H(ts=1) ──→ i(ts=2) ──→ ⊣
```

---

### Queries

**`lookup(v)`** — is vertex v visible?
```
v ∈ VA \ VR    (added AND not tombstoned — same as 2P-Set)
```

**`before(u, v)`** — does u come before v in the sequence?
```
∃ a path from u to v following edges E through added vertices
```

**`successor(u)`** — what's the next vertex after u?
```
find v where (u, v) ∈ E    (follow u's outgoing edge)
```

---

### The Key Operation: `addRight(u, a)`

Insert atom `a` immediately **after** vertex `u`.

**Phase 1 — atSource:**
```
pre: u ∈ VA \ (VR ∪ {⊣})   ← can't insert after right-sentinel or deleted vertex
let t = now()               ← generate a unique timestamp
let w = (a, t)              ← new vertex
```

**Phase 2 — downstream(u, w):**

Start at position `u`, walk forward to find the right slot:

```
l, r := u, successor(u)
while true:
  let t' = timestamp of r
  if t < t':                        ← w's timestamp is lower than r's
    l, r := r, successor(r)         ← skip right — r goes before w
  else:                             ← t > t' OR r = ⊣
    E := E \ {(l, r)} ∪ {(l, w), (w, r)}   ← splice w between l and r
    break
```

**The rule in plain English:**
> Walk forward through the list. Skip past any vertex whose timestamp is **higher** than yours. Insert yourself before the first vertex with a **lower** timestamp (or at the end).

Higher timestamp = earlier position = to the left.

---

### Why This Achieves Convergence

Say two replicas concurrently insert at the same position after vertex `v`:
- Replica A inserts `'X'` with `t=5`
- Replica B inserts `'Y'` with `t=3`

```
Replica A (locally):  ⊢ → X(5) → ⊣
Replica B (locally):  ⊢ → Y(3) → ⊣
```

**Replica A applies B's op** — `addRight(v, Y, t=3)`:
- Successor of `v` is `X(ts=5)`. Is `3 < 5`? Yes → skip past X.
- Successor is now `⊣(ts=0)`. Is `3 < 0`? No → splice Y between X and ⊣.
- Result: `⊢ → X(5) → Y(3) → ⊣`

**Replica B applies A's op** — `addRight(v, X, t=5)`:
- Successor of `v` is `Y(ts=3)`. Is `5 < 3`? No → splice X between v and Y.
- Result: `⊢ → X(5) → Y(3) → ⊣`

Both replicas agree: **X before Y**. Convergence, no coordination needed.

---

### Sequential Inserts at the Same Position

> "If a client inserts `addRight(v, a)` then `addRight(v, b)`, the latter insert occurs to the LEFT of the former."

```
addRight(v, 'a')  →  t=5  →  v → a(5)
addRight(v, 'b')  →  t=6  →  is 6 < 5? No → splice before a
                              v → b(6) → a(5)
```

`b` (inserted second, higher timestamp) lands **left** of `a`. Counterintuitive — but fine in practice. In real typing, after inserting `'a'` your cursor moves to `a`. The next keystroke is `addRight(a, 'b')`, not `addRight(v, 'b')`. Sequential typing works correctly. This "latest goes leftmost" rule only comes into play for **concurrent** inserts from different replicas.

---

### Remove

```
atSource(w):
  pre: lookup(w)                        ← can only remove a visible vertex

downstream(w):
  pre: addRight(_, w) has been delivered ← causal delivery: add before remove
  VR := VR ∪ {w}                         ← tombstone it
```

**Why tombstones must stay in the linked list:**

When A inserts `'c'` after `'b'`, and `'b'` is concurrently deleted by B:
```
A: ⊢ → a → b → c    ('c' anchors its position to 'b')
B: ⊢ → a → ⊣        ('b' is deleted)
```

When A's insert arrives at B, B must find where `'c'` goes — it was inserted after `'b'`. If `'b'` is physically gone, the position is lost and the structure is broken. Tombstoned vertices stay in the list as **position anchors**, invisible to users but structurally necessary. Same insight as OR-Set, same insight as YJS.

---

### What Problem Does YATA (YJS) Fix?

RGA's ordering rule is correct for single insertions. It breaks when multiple replicas type **sequences** of characters concurrently at the same position.

Say replica A types `"AA"` and replica B types `"BB"`, both starting after vertex `v`:
```
A inserts: A₁(ts=3), A₂(ts=4)  →  v → A₁ → A₂
B inserts: B₁(ts=5), B₂(ts=6)  →  v → B₁ → B₂
```

After merge, RGA orders purely by timestamp: `v → B₂ → B₁ → A₂ → A₁`. The two users' characters **interleave**. A user who typed "AA" sees their characters separated by B's characters. That's a semantic anomaly — the document no longer reflects what either user intended.

**YATA's fix:** each insertion records **two origin references** — left neighbor AND right neighbor at the time of insertion. The ordering algorithm uses both to detect when a new insert would "cut through" another user's in-progress sequence, and prevents it.

Result: `"AA"` and `"BB"` stay grouped — `v → BB → AA` or `v → AA → BB` — never interleaved. That's the one problem RGA doesn't solve and YATA does. Everything else in YJS (unique IDs, tombstones, causal delivery, state vector) comes directly from RGA.

---

## Section 4 — Garbage Collection

### The Problem

Every time you remove an element from a CRDT (like 2P-Set or OR-Set), you don't actually delete it — you leave a **tombstone**: a marker saying "this existed and was removed." This is necessary so concurrent replicas don't re-add it by mistake.

But tombstones **never go away** — they pile up forever. Two problems:
1. **Memory bloat** — the payload grows even when users "delete" things
2. **Unbalanced structures** — tree-based CRDTs (like Treedoc) get lopsided over time and slow down

The paper's answer: we need **garbage collection** — a way to clean up tombstones that are no longer needed.

> "Solving distributed GC would be difficult without synchronisation."

Perfect GC requires all replicas to coordinate. The paper splits GC into two sub-problems with different cost levels.

> "GC does not impact correctness (only performance), and the normal operations in the object's interface remain live."

If GC is delayed or blocked, the CRDT still works correctly. It just stays big. GC is off the critical path.

---

### 4.1 Stability Problems

When you apply an update, you sometimes leave extra bookkeeping in the payload to handle operations that might arrive later (concurrent with that update). Example: when you remove from an OR-Set, you leave the old tags as tombstones so a concurrent `add` that was already in-flight doesn't get mistakenly removed.

**Definition 4.1 (Stability):** Update f is **stable** at replica xi if every operation concurrent with f (in delivery order) has already been delivered to xi.

In plain terms: you're done waiting. Nobody else is going to show up with an operation that was racing with f. The bookkeeping for f can now be safely deleted.

```
f is concurrent with g₁, g₂, g₃

Once g₁, g₂, and g₃ have all arrived at xi:
  → f is stable at xi
  → r(f) (the bookkeeping for f) can be discarded
```

**How stability is detected:** each operation carries a vector clock. Each replica tracks the latest vector clock received from every other replica. From this, you can compute which operations are stable.

**Liveness requirement:** to detect stability, you must know all replicas, and none can crash permanently without detection. If a replica goes silent forever, you can never know if it has pending concurrent operations — so nothing is ever stable.

---

### Specification 21 — Op-based OR-Cart

OR-Cart extends OR-Set to a map structure. Instead of storing plain elements, it stores `(isbn, quantity, unique-tag)` triplets.

**Payload:** a set S of triplets, initially empty.

```
S = { ("978-0-13-468599-1", 2, tag_a),
      ("978-0-20-253440-3", 1, tag_b) }
```

**`query get(isbn k)`:** sum all quantities for a given isbn:
```
N = {n' | (k', n', u') ∈ S ∧ k' = k}
if N is empty → return 0
else → return sum(N)
```
Why sum? Because concurrent adds for the same isbn create multiple co-existing triplets — the sum is the correct merged quantity.

**`update add(isbn k, integer n)`:**
- *atSource:* generate a unique tag α, compute R = all existing triplets for this isbn
- *downstream(k, n, α, R):*
  - precondition: every add in R has been delivered (causal delivery ensures this)
  - `S := (S \ R) ∪ {(k, n, α)}` — replace all old entries for this isbn with one new one

This is the **observed-remove** pattern: when you add a new quantity for a book, you simultaneously remove all old entries you observed. The new entry has a fresh unique tag, so it can't interfere with concurrent adds from other replicas.

**`update remove(isbn k)`:**
- *atSource:* compute R = all existing triplets for this isbn
- *downstream(R):*
  - precondition: every add in R has been delivered
  - `S := S \ R` — remove exactly those entries observed at source

**Why concurrent operations commute:**
- Two adds → each creates a unique tag. They never overwrite each other.
- Two removes → both apply set-minus. Either independent (different triplets) or idempotent (same triplets, applying twice = applying once).
- Concurrent add + remove → the remove targets triplets that existed at source when remove was issued. A concurrent add creates a new triplet with a fresh tag — the remove never saw it and can't target it. The new add survives.

---

### 4.2 Commitment Problems

Some GC is harder than stability detection:
- Resetting a counter (removing zero entries from a vector clock)
- Removing tombstones from a 2P-Set (so deleted elements can be re-added)
- Rebalancing a tree (Treedoc)

These require **unanimous agreement** across all replicas simultaneously — otherwise replicas diverge on what the "cleaned up" state looks like. This needs a **commitment protocol** (2-Phase Commit or Paxos). Expensive: all replicas must be reachable and responsive.

**Optimization — the core:** don't require ALL replicas to agree. Only a small, stable **core group** of replicas participates in commitment. Other replicas asynchronously reconcile their state with core replicas. Weaker liveness requirement, practical in real systems.

---

## Section 5 — Putting CRDTs to Work

### 5.1 Observed-Remove Shopping Cart

> "A shopping cart must be always available for writes, despite failures or disconnection."

The classic Amazon Dynamo use case. Users must be able to add items to their cart even when offline or when the network is partitioned. Consistency can be deferred — availability cannot.

> "Linearisability would incur long response times; CRDTs provide the ideal solution."

Linearisability requires coordination (network round-trips). CRDTs trade linearisability for always-on local writes.

The cart is a **map from ISBN → integer**. OR-Set semantics are chosen because they minimise anomalies — specifically, add-wins / observed-remove semantics handle concurrent edits better than LWW would.

**Why not LWW for the cart?** LWW would silently drop one side of a concurrent add. OR-Cart keeps both concurrent adds. Only explicit removes delete things.

**Concurrent semantics:**
- Two concurrent adds → both survive (quantities accumulate)
- Concurrent remove + add → remove cancels old entries it observed, concurrent add's fresh triplet survives
- Two concurrent removes → commute — either independent or idempotent

This design does not incur the "remove anomaly" reported for Dynamo, and avoids the overhead of Dynamo's MV-Register approach (which surfaced conflicts and required the application to resolve them manually).

### 5.2 E-commerce Bookstore

Full system design:
- Each user has one OR-Cart
- User-to-cart mapping: a **U-Map** (derived from U-Set)
- Cart created when account is created, removed when account is deleted

**Web interface semantics:**

| User action | Interface call |
|---|---|
| Select book b with quantity q | `add(b, q)` |
| Increase to q' | `add(b, q' - q)` (add the delta) |
| Decrease to q' | `remove(b)` then `add(b, q')` |
| Cancel book | `remove(b)` |

Causal delivery + observed-remove guarantee that your own actions are always reflected in your own view — you can't see a stale version of your own edits.

When two users share the same account (e.g. family members):
- Concurrent adds → both survive, quantities accumulate — expected
- Concurrent remove + add → remove cancels observed entries, new add survives — cleanest possible semantics in this case

---

## Section 6 — Comparison with Previous Work

### 6.1 Commutativity in Transactional Systems

Even in traditional database systems, researchers noticed that **commutative transactions** are easier to reconcile. The CRDT paper formalises and extends this intuition.

The paper takes a stricter stance than earlier work: **design every operation to commute**. Not just some. This is more restrictive but eliminates the need for case-by-case conflict resolution logic.

Helland and Campbell's earlier suggestion — use associative, commutative and idempotent operations for fault tolerance — is essentially the merge laws for CvRDTs. The CRDT paper formalises this into a rigorous mathematical framework.

### 6.3 Commutativity-Oriented Design

**CvRDT foundations:** the state-based model (monotonic semilattice + LUB merge) was introduced by Baquero and Moura. This paper extends their work with a specification language, op-based CRDTs, more complex examples, and GC.

**RGA (Spec 19):** Roh et al. independently developed the Replicated Abstract Data Type concept. Every insert gets a unique `{replicaId, clock}` ID — concurrent inserts at the same position are ordered by comparing IDs. YATA (YJS's algorithm) is a refinement of RGA. Roh's observation that causal delivery can eliminate the need for some downstream preconditions was later formalised in this paper.

**Operational Transformation (OT):** Ellis and Gibbs' OT approach allows non-commutative operations but **transforms** them on arrival to account for what's changed since they were issued. The paper's position: designing for commutativity upfront is cleaner and simpler than transforming after the fact.

> "Oster et al. demonstrate that most OT algorithms for a decentralized architecture are incorrect."

Google Docs uses OT with a central server (which imposes a total order on all operations, trivially avoiding the concurrent transform problem). Decentralized OT is notoriously hard to get right. CRDTs avoid this problem entirely by design.

**CALM (Consistency As Logical Monotonicity):** Alvaro et al.'s Bloom language lets you write programs and statically detect which parts are non-monotonic (require coordination). Similar spirit to CvRDTs — monotonicity = convergence. But more restrictive: Bloom cannot express `remove` without synchronisation. CRDTs (with tombstones or causal delivery) can.

---

## Section 7 — Conclusion

The whole paper in one line:

> "A CRDT is a replicated data type for which some simple mathematical properties guarantee eventual consistency."

The "simple mathematical properties" are:
- **CvRDT:** successive states form a monotonic semilattice, merge = LUB
- **CmRDT:** concurrent operations commute

**State-based** needs nothing from the network except that states occasionally get delivered — no ordering guarantees, no reliability required. Idempotent merge handles duplicates, commutativity handles reordering.

**Op-based** needs more: reliable delivery (no drops, no duplicates) and causal ordering. Harder infrastructure, but pays off in bandwidth efficiency — sending one operation per keystroke instead of the full document.

Both converge to the same correct state **without any synchronisation**.

**The design hierarchy the paper reveals:**

```
G-Set (add only)
  └── 2P-Set (add + remove with tombstones)
        └── OR-Set (add + remove with unique tags, add-wins)
              └── OR-Cart / U-Map (OR-Set applied to key-value maps)
                    └── Y.Map (YJS's implementation)
```

Each level inherits the commutativity properties of the level below. Each level adds one new capability (removes, re-adds, map semantics) by solving one new problem (tombstoning, unique tagging, observed-remove on keys).

**GC is an optional maintenance concern**, not a safety concern. CRDTs are correct with or without GC — GC just prevents unbounded growth.

**Why this paper matters:**

Before it, eventually-consistent systems were built by intuition and testing. This paper provides the first systematic theoretical foundation — a unified framework that explains **why** things work, not just that they work. Every design decision in YJS, Automerge, and other production CRDTs traces back to the tradeoffs identified here.

---

*Next: YJS documentation.*
