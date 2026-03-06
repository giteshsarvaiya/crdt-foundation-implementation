# CRDT → YJS Study Roadmap

This document captures the full learning plan, day-by-day journal, phase checklist, and key insights from studying the Shapiro et al. CRDT paper and implementing 4 CRDTs before moving to YJS internals.

→ [Back to main README](./README.md)

---

## Resources

| Resource | Relevance | Order |
|---|---|---|
| CRDT Foundational Paper (Shapiro et al., INRIA) | High | 1st |
| YJS Internals documentation | High | 2nd |
| Slides and talks by Kevin Jahns (YJS author) | High | 3rd |
| Undo Support for CRDTs | Medium | Optional |
| Real Differences between OT and CRDT in Co-Editors | Low | Optional |
| YATA CRDT paper (basis for YJS algorithm) | Low | Optional |

---

## Learning Order

```
Paper (Phase 1) → Implementations (Phase 2) → YJS Internals (Phase 3)
                                                    ↓
                                          Optional: Undo, OT vs CRDT, YATA
```

---

## Phase Plan

### Phase 1 — Read the Foundational Paper (Days 1–2)

Do NOT skim. Focus on:

- Definition of convergence
- CvRDT (state-based) vs CmRDT (operation-based)
- Join-semilattice requirement
- Commutativity, associativity, idempotency
- Causal history, happens-before, liveness

Ignore on first pass:
- Heavy formal proof notation

Goal: be able to explain semilattice in your own words. If you can't, re-read.

### Phase 2 — Implement CRDTs (Days 3–6)

Implement in this order — each one adds a new idea the next one needs:

**State-based (CvRDT):**
1. **G-Counter (Spec 6)** — vector slots, element-wise max, three laws
2. **2P-Set (Spec 12)** — tombstoning, preconditions, remove-wins
3. **LWW-Register (Spec 8)** — timestamp conflict, tiebreaker necessity, silent data loss
4. **OR-Set state-based (Spec 15 variant)** — unique tags, observed-remove, add-wins, tombstone growth
5. **MV-Register (Spec 10)** — surfacing conflicts instead of silently discarding

**Op-based (CmRDT) — how YJS actually works:**
6. **Op-LWW-Register (Spec 9)** — atSource/downstream split in code, Lamport clock, ops as first-class objects
7. **Op-OR-Set (Spec 15)** — no tombstones, causal delivery replaces storage, direct YJS analogue

### Phase 2.5 — Read Before YJS (Day 5, after MV-Register)

Before jumping to YJS, read these two specs from the paper. No implementation needed — just read the spec text and understand the idea.

| Spec | Why |
|---|---|
| **Spec 19 (RGA)** | Main competing sequence CRDT to YJS's YATA. Can't understand what YATA fixes without knowing what RGA does. |
| **Spec 21 (OR-Cart)** | OR-Set applied to a map. `Y.Map` is OR-Cart. Reading it makes the leap from OR-Set to YJS maps obvious. |

Optional reads (good context, not required):

| Spec | Why |
|---|---|
| Spec 7 (PN-Counter) | Shows CRDT composition pattern — combining two CRDTs into one |
| Spec 13 (U-Set) | Shows how causal delivery can eliminate tombstones entirely |
| Spec 9 (Op-based LWW) | Makes atSource/downstream split concrete on a familiar example |
| Spec 20 (Continuum sequence) | Understand the two schools of sequence CRDT (identifier-based vs linked-list) |

### Phase 3 — YJS Internals (Days 6+)

Read in this order:
- StructStore
- Item structure
- DeleteSet
- Update encoding
- Garbage collection

Compare your implementations to YJS:

| Your Implementation | YJS Equivalent |
|---|---|
| G-Counter vector | State vector (`Map<clientId, clock>`) |
| Tombstone set (2P-Set `R`) | DeleteSet (structural tombstones) |
| LWW-Register timestamp | Lamport clock on `Y.Map` keys |
| OR-Set (element, tag) pair | Item with unique `{client, clock}` ID |
| MV-Register concurrent value set | Why YJS chose LWW over MV for `Y.Map` (surfacing conflicts is too noisy for text) |
| **Op-LWW write() → op → apply()** | **YJS insert: atSource → Update → applyUpdate()** |
| **Op-OR-Set add/remove ops** | **YJS insert/delete: broadcast ops, no tombstone content** |

### Skipped Phases (from original plan)

**Phase 3 (Op-based model)** — skipped as a standalone phase. CmRDT concepts were covered during paper reading (Section 2.2.2). The transition from state-based to op-based was understood conceptually without needing a separate implementation.

**Phase 4 (Minimal Sequence CRDT)** — skipped intentionally. The paper's sequence specs (Logoot, RGA) use different algorithms than YJS's YATA. Implementing them would build wrong intuitions for the wrong algorithm. Instead: read Spec 19 (RGA) conceptually in Phase 2.5, understand what problem it solves, then go directly to YJS's YATA. All the building blocks are already in place (unique tags from OR-Set, tombstoning from 2P-Set, vector clocks from G-Counter).

---

## Day-by-Day Journal

### Day 1 — Paper: Theory Foundations

**Covered:**
- System Model — asynchronous network, non-byzantine nodes, crash-restart, partitions
- Section 2.1 — Atoms vs Objects, four properties of an object (identity, payload, initial state, interface), why no transactions
- Section 2.2 — Query vs Update operations, two styles (state-based, op-based)
- Specification 1 (CvRDT template) — payload, query, update, compare, merge
- Semilattice and LUB — why `max` = LUB for integers, why `union` = LUB for sets
- The three merge laws — commutativity, associativity, idempotency, and what breaks without each

**Key insight of the day:**
The CRDT designer's job is just to pick a data structure where merge = LUB. If you do that, convergence is mathematically guaranteed without any coordination. The hard part is picking the right structure.

**Analogy that clicked:**
Semilattice = water flowing downhill. States only move "forward" (more information), never back. Two streams always merge into one.

---

### Day 2 — Paper: Deeper Replication + Op-Based Model

**Covered:**
- Section 2.2.1 — Atomicity, preconditions, causal history `C(xi)`, happens-before (`f → g`), concurrent operations, liveness
- Section 2.2.2 — CmRDT two phases (atSource + downstream), downstream preconditions, reliable broadcast requirement, causal delivery
- State-based vs op-based comparison — bandwidth tradeoff, network assumptions, idempotency requirement

**Key insight of the day:**
Concurrent operations are not a failure mode — they are the normal case. A CRDT is a data structure designed so that concurrency is safe by construction, not avoided by locking.

**Question that came up:**
Why is this called "distributed systems" — isn't that just servers?

Answer: No. A system is distributed whenever multiple independent agents hold state and must coordinate without a shared clock or shared memory. Browsers, mobile apps, and browser tabs are just as distributed as server clusters. The math is identical — the deployment shape is different.

---

### Day 3 — Implementations: G-Counter + 2P-Set

**G-Counter:**
- Implemented vector of integers, one slot per replica
- Each replica increments only its own slot — this constraint is what makes concurrent increments safe
- Merge = element-wise max = LUB for integer vectors
- Verified all three laws via tests: commutativity (order of merge irrelevant), associativity (grouping irrelevant), idempotency (duplicates harmless)

**Key moment:** Watching the tests pass and realising the laws hold mathematically — not because we coded them in, but because element-wise max inherently satisfies them.

**2P-Set:**
- Two internal G-Sets: `A` (added) and `R` (removed/tombstones)
- Element in set iff in `A` but not in `R`
- Merge = union of both `A` sets + union of both `R` sets
- Precondition: can only remove what's currently in the set

**Key insight:** You cannot truly erase data in a distributed system without coordination. Tombstoning (marking as deleted, never erasing) is the only coordination-free approach. The cost: `R` grows forever.

**Drawback discovered:** Once in `R`, an element can never come back. The remove wins permanently. This is a design choice — but a limiting one.

---

### Day 4 — Implementations: LWW-Register + OR-Set

**LWW-Register:**
- Single value + timestamp. Higher timestamp wins on merge.
- Silent data loss: the losing write leaves no trace, no warning. This is the LWW tradeoff.
- **Bug discovered mid-implementation:** what if two replicas write at the exact same timestamp?
  - `A.merge(B)` → A keeps itself ("existing")
  - `B.merge(A)` → B keeps itself ("existing")
  - `merge(A, B) ≠ merge(B, A)` → commutativity broken → replicas permanently diverge
- **Fix:** replicaId tiebreaker. Higher replicaId always wins on tie. Both replicas see the same two IDs, make the same decision. Commutativity restored.

**Key insight:** Tiebreakers must be based on the data itself — not on who is calling merge. "Keep existing" is caller-dependent. "Higher replicaId wins" is data-dependent. Only the latter is safe.

**OR-Set:**
- Payload: `entries` (element → Set of tags) + `tombstones` (element → Set of tags)
- Every `add()` generates a unique tag (`replicaId-counter`)
- `remove()` tombstones only the tags it currently observes — not tags from replicas it hasn't seen
- `merge()` = union of entries + union of tombstones
- `lookup()` = does any tag exist in entries but NOT in tombstones?

**The moment OR-Set clicked:** After implementing `remove()`, the question was "why doesn't B's remove kill A's concurrent add?" The answer: B's remove only knows about B's tags. A's tag was added concurrently — B never saw it, never tombstoned it, so after merge it's still alive. The "observed-remove" semantics fall out of the implementation naturally.

**Re-add after remove worked:** New `add()` → new tag → never tombstoned → element visible again. 2P-Set cannot do this.

**Drawbacks discovered:**
1. Tombstones grow forever — same problem as 2P-Set, but now with tags making it worse
2. Add-wins is baked in — no way to choose remove-wins without switching to 2P-Set
3. Tag uniqueness is a hard assumption — collision = silent data corruption
4. GDPR problem — deleted data is still physically present

---

### Day 5 — MV-Register + Reading Decisions

**Implemented: MV-Register (Spec 10)**

Instead of picking one winner when two replicas write concurrently (LWW), MV-Register keeps ALL concurrent values. After merge, the register holds a set of values. The application layer sees the conflict and decides what to do — show a UI prompt, merge programmatically, etc.

Key contrast with LWW-Register (Day 4):
- LWW: concurrent writes → one wins, one silently disappears
- MV-Register: concurrent writes → both survive, conflict surfaced explicitly

The internal payload is a `Map<replicaId, {value, timestamp}>`. A value is "concurrent" with another if neither causally happened before the other — detected by comparing timestamps. `values()` returns all entries where no other entry has a strictly higher timestamp from the same or later replica.

**Why this matters for YJS:** `Y.Map` uses LWW, not MV-Register. Understanding MV-Register makes it clear this was a deliberate choice — surfacing conflicts on every concurrent map edit would be too noisy for real-time collaborative text. YJS picks LWW and trusts Lamport clocks to make it deterministic.

**Documentation:**
- README.md for each CRDT folder (concept, drawbacks, solutions, bridge to YJS)
- Updated main README with project structure, getting started, implementation index, reading guide

**Decision: read but don't implement RGA and OR-Cart (Specs 19 and 21)**

RGA is the closest sequence CRDT to YJS's YATA — but YATA fixes an interleaving problem RGA has. Reading the spec is enough to understand what YATA is solving. Implementing RGA would build the wrong muscle memory. OR-Cart (Spec 21) is OR-Set on a map — reading it takes 5 minutes and directly explains how `Y.Map` works.

**Decision: skip graphs entirely (Specs 16–18), skip Logoot in depth (Spec 20)**

YJS doesn't use graph CRDTs. Logoot's identifier-based approach is further from YATA than RGA is.

**Pattern that emerged across all 5 implementations:**

Every CRDT drawback is a tension between two things:
- **Convergence without coordination** (the CRDT promise)
- **Some other property** (garbage collection, true deletion, ordering, re-add, conflict visibility)

You can always have convergence. But every other property costs something. CRDTs make those costs explicit.

---

### Day 6 — Op-based Implementations

**Why op-based matters:** Everything up to Day 5 was state-based — send full state, merge on receipt. YJS is op-based — send operations, apply on receipt. The mental model is different enough that both need to be implemented.

**Op-LWW-Register (Spec 9):**
- Same LWW conflict logic as Spec 8, different delivery
- Introduced the two-phase structure in code: `write()` = atSource, `apply()` = downstream
- `write()` generates an op and returns it — the caller broadcasts it
- `apply()` runs at EVERY replica, including source — applying Lamport clock update + LWW rule
- Key insight: the op is a 3-field object `{value, timestamp, replicaId}` — small and self-contained
- Lamport clock: increment on write, take max on receive — immune to clock skew

**Op-OR-Set (Spec 15 — the actual paper spec):**
- Our folder 4 was a state-based interpretation. This is the real paper spec.
- **No tombstones.** Removes physically delete the targeted tags.
- `add()`: generate unique tag → apply at source → return op for broadcast
- `remove()`: capture observed tags at source → apply at source → return op for broadcast
- `apply(removeOp)`: deletes the specific tags named in the op — concurrent add tags with different names are untouched
- Key insight: tombstones in state-based exist to block future state merges. Op-based has no state merges — each op targets specific tags. Causal delivery ensures the ordering is correct.

**The contrast that emerged:**
- State-based: tolerant of network failures (next sync catches up everything), but tombstones grow forever
- Op-based: smaller payload, no tombstones, but requires reliable+causal delivery and an op log for reconnect

YJS is op-based and handles the network requirements with state vectors (tracking which ops each peer has seen) and op retransmission on reconnect. The op log IS the document — a new peer can reconstruct the document from scratch by replaying all ops.

---

## Phase Checklists

### Phase 1 — Core CRDT Theory

| Checkpoint | Answer |
|---|---|
| Explain convergence in one sentence | All replicas that have seen the same set of operations will hold identical state — regardless of the order those operations arrived |
| Define CvRDT vs CmRDT | CvRDT: send full state, merge on receipt. CmRDT: send operations, replay on receipt |
| Explain join-semilattice | A partial order where any two elements have a Least Upper Bound. States only move "forward" — merge always produces something ≥ both inputs |
| Why merge must be commutative, associative, idempotent | Commutative: network order doesn't matter. Associative: grouping/batching doesn't matter. Idempotent: duplicate delivery doesn't corrupt state |
| What breaks if merge is not monotonic | States can go backwards. A replica that receives an older state could overwrite newer information — convergence fails |
| Why "last write wins" is usually a bad idea | It silently discards concurrent writes with no warning. Any write with a lower timestamp is gone forever, regardless of its logical importance |

---

### Phase 2 — Implementations

Checkpoint answers are in each CRDT's README:

- [G-Counter checkpoints](./(1)%20g-counter/README.md#checkpoint-answers)
- [2P-Set checkpoints](./(2)%202p-set/README.md#checkpoint-answers)
- [LWW-Register checkpoints](./(3)%20lww-register/README.md#checkpoint-answers)
- [OR-Set checkpoints](./(4)%20or-set/README.md#checkpoint-answers)
- [MV-Register checkpoints](./(5)%20mv-register/README.md#checkpoint-answers)
- [Op-LWW-Register checkpoints](./(6)%20op-lww-register/README.md#checkpoint-answers)
- [Op-OR-Set checkpoints](./(7)%20op-or-set/README.md#checkpoint-answers)

---

### Phase 3 — Operation-Based Model

| Checkpoint | Answer |
|---|---|
| Why sending full state doesn't scale | State grows over time. Sending the full G-Counter vector with 1000 replicas = 1000 integers per sync, even if only 1 changed. Op-based sends just the operation. |
| Idempotent operations | An operation that can be applied multiple times without changing the result beyond the first application. State-based merge is inherently idempotent. Op-based operations must be designed to be idempotent. |
| Causal delivery vs total ordering | Causal: if A happened before B, every replica applies A before B. Total: every replica applies all ops in the same global order. Causal is weaker (and achievable without coordination). Total requires coordination. |
| Duplicate operation replay | State-based: harmless (merge is idempotent). Op-based: must be handled explicitly — either by tracking seen operation IDs or by designing operations to be idempotent. |
| Why vector clocks / Lamport clocks exist | Wall clocks lie (clock skew). Logical clocks track causal order without relying on physical time. Lamport: single counter adjusted upward on receive. Vector: one counter per replica — tracks full causal history. |

---

### Phase 5 — Invariant Thinking

| Question | Answer from our implementations |
|---|---|
| What invariant must always hold? | merge(A, B) = merge(B, A). Every replica that has seen the same operations must hold identical state. |
| What state is allowed to grow forever? | Tombstone sets (2P-Set `R`, OR-Set `tombstones`), G-Counter slots, OR-Set `entries` |
| What state can be garbage-collected? | Tombstones where every known replica has already received them. Requires coordination to determine the stable frontier. |
| What breaks if messages are delayed indefinitely? | Safety (no wrong states) is preserved. Liveness (eventual convergence) is lost — replicas never catch up. |
| What breaks if replicas go offline for days? | Nothing, structurally. When they reconnect, merge brings them up to date. The cost: catching up may mean applying a large number of operations at once. |

---

### Phase 6 — YJS Internals

*(To be filled in during YJS study)*

| Checkpoint | Answer |
|---|---|
| Recognize StructStore as a sequence CRDT | |
| Understand why YJS compresses identifiers | |
| Understand what DeleteSet represents | |
| See how YJS avoids metadata explosion | |
| Understand why GC is optional | |
| Point at an optimization and explain what pain it solves | |

---

## The Distributed Systems Question

**Q: Why do we call this "distributed systems"? Is it the same as server architecture?**

No — but it is the same problem class.

A system is distributed when:
- State lives in more than one place
- Updates happen independently
- Messages can be delayed, reordered, duplicated, or dropped
- No single authority can say "this happened first"

This applies equally to server clusters, browser tabs, mobile devices, and offline-capable apps. The deployment shape is different. The constraints are identical.

**The key misconception:** "Distributed systems = server clusters."

That's only one deployment shape. Distributed systems theory is about constraints, not topology.

**Why CRDTs feel harder than classic distributed systems:**

In server-side distributed systems, you often "cheat" with leader election, locks, transactions, and total ordering. In CRDT systems, all cheats are removed — no leader, no lock, no coordination. Consistency must emerge mathematically from the merge rules. That's why CRDTs feel brutal.

**Comparison:**

| Aspect | Server Architecture | CRDT / Collaboration |
|---|---|---|
| Nodes | Servers | Clients / replicas |
| Ownership | Central authority | No single authority |
| Writes | Often serialized | Concurrent by design |
| Consistency | Enforced | Emergent |
| Coordination | Explicit | Avoided |
| Failure model | Node crashes | Network partitions |
| Recovery | Replay logs | Merge state |

Same theory. Different battlefield.

CRDTs are an AP system (per CAP theorem) by design — they choose Availability and Partition tolerance, giving up Strong Consistency. That's the deliberate tradeoff that makes offline editing possible.
