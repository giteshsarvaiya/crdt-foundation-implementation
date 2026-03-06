# CRDT Foundation — Study Notes

Working through **"A Comprehensive Study of Convergent and Commutative Replicated Data Types"** (Shapiro et al., INRIA).

Goal: understand the paper section by section, implement 4 CRDTs covering every fundamental pattern, then move to YJS internals.

**→ [Study Roadmap, Day-by-Day Journal & Phase Checklists](./STUDY_ROADMAP.md)**

The roadmap captures the full learning plan, what was studied each day, why certain specs were skipped, and answers to every phase checkpoint — tracking the path from the paper's theory to YJS's engineering decisions.

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
  - [Why these 5?](#why-these-5)
  - [Skipped Specs — and Why](#skipped-specs--and-why)
  - [How to Test Each CRDT](#how-to-test-each-crdt)

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
| 9 | Op-based LWW-Register | 📖 Good to read — atSource/downstream in practice |
| 10 | State-based MV-Register (Multi-Value Register) | ✅ **Implemented** |
| 11 | State-based G-Set (Grow-only Set) | ⬜ Skip — already inside 2P-Set and OR-Set |
| 12 | State-based 2P-Set (Two-Phase Set) | ✅ **Implemented** |
| 13 | Op-based U-Set (2P-Set with unique elements) | 📖 Good to read — tombstones drop under causal delivery |
| 14 | Op-based Molli-Weiss-Skaf Set (PN-Set variant) | ⬜ Skip — anomaly-for-anomaly tradeoff, unused |
| 15 | Op-based OR-Set (Observed-Remove Set) | ✅ **Implemented** |
| 16 | Op-based 2P2P-Graph | ⬜ Skip — graphs, not sequences |
| 17 | Op-based Add-only Monotonic DAG | ⬜ Skip — graphs, not sequences |
| 18 | Op-based Add-Remove Partial Order | ⬜ Skip — basis for WOOT, not YATA |
| 19 | Op-based RGA (Replicated Growable Array) | 📌 **Must read** — main competing sequence CRDT to YATA |
| 20 | Op-based Mutable sequence based on the continuum | 📖 Good to read — Logoot-style identifiers |
| 21 | Op-based OR-Cart (Observed-Remove Shopping Cart) | 📌 **Must read** — OR-Set applied to a map; direct precursor to Y.Map |

---

### Why these 5?

Each implements a distinct pattern. Together they cover every fundamental idea you need before reading YJS internals.

| Spec | CRDT | Status | What it teaches |
|---|------|--------|-------|
| **Spec 6** | **[G-Counter](./(1)%20g-counter/README.md)** | ✅ Done | Vector clocks, semilattice, element-wise max merge |
| **Spec 12** | **[2P-Set](./(2)%202p-set/README.md)** | ✅ Done | Tombstoning, remove-wins, preconditions |
| **Spec 8** | **[LWW-Register](./(3)%20lww-register/README.md)** | ✅ Done | Timestamp conflict resolution, tiebreakers, silent data loss |
| **Spec 15** | **[OR-Set](./(4)%20or-set/README.md)** | ✅ Done | Unique tags per add, observed-remove, add-wins, unbounded storage |
| **Spec 10** | **[MV-Register](./(5)%20mv-register/README.md)** | ✅ Done | Conflict surfacing vs silent loss, vector-clock-based concurrency tracking |

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

#### 📖 Spec 9: Op-based LWW-Register

Same conflict resolution as the state-based LWW-Register (Spec 8) we built, just delivered as operations. Reading it takes 5 minutes and makes the atSource/downstream split concrete on a real example — useful for understanding CmRDT delivery before reading YJS's update protocol.

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

*Next: YJS documentation.*
