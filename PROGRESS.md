# Study Progress Tracker

Update this file as you move through each phase. Mark items done with [x].

→ [Full Roadmap](./STUDY_ROADMAP.md) | → [Main README](./README.md)

---

## Current Position

**Phase:** 3 — YJS Internals
**Status:** All 7 implementations done. Specs 19 (RGA) and 21 (OR-Cart) read and documented. Ready to move to YJS.

---

## Phase 1 — Paper Theory (Days 1–2)

- [x] System model (async network, non-byzantine, crash-restart, partitions)
- [x] Section 2.1 — Atoms vs Objects, four properties of an object
- [x] Section 2.2 — Query vs Update, two propagation styles
- [x] Specification 1 — CvRDT template (payload, query, update, compare, merge)
- [x] Semilattice and LUB — why `max` = LUB for integers, `union` = LUB for sets
- [x] Three merge laws — commutativity, associativity, idempotency
- [x] Section 2.2.1 — Atomicity, preconditions, causal history, happens-before, liveness
- [x] Section 2.2.2 — CmRDT two phases (atSource + downstream), causal delivery, reliable broadcast
- [x] State-based vs op-based comparison

---

## Phase 2 — Implementations (Days 3–6)

**State-based (CvRDT):**
- [x] **Spec 6 — G-Counter** → `(1) g-counter/`
- [x] **Spec 12 — 2P-Set** → `(2) 2p-set/`
- [x] **Spec 8 — LWW-Register (state-based)** → `(3) lww-register/`
- [x] **Spec 15 — OR-Set (state-based variant)** → `(4) or-set/`
- [x] **Spec 10 — MV-Register** → `(5) mv-register/`

**Op-based (CmRDT) — how YJS actually works:**
- [x] **Spec 9 — Op-LWW-Register** → `(6) op-lww-register/`
- [x] **Spec 15 — Op-OR-Set (paper's actual spec)** → `(7) op-or-set/`

---

## Phase 2.5 — Pre-YJS Reading (Day 5)

Read these two specs from the paper — no implementation, just understand the idea:

- [x] **Spec 19 — RGA** (Replicated Growable Array)
  Why: understand what YATA is fixing before you read YJS

- [x] **Spec 21 — OR-Cart** (Observed-Remove Shopping Cart)
  Why: OR-Set applied to a map → direct precursor to Y.Map

Optional reads (do these if you have time, skip if not):

- [ ] Spec 7 — PN-Counter (CRDT composition)
- [ ] Spec 13 — U-Set (tombstones drop under causal delivery)
- [ ] Spec 9 — Op-based LWW (atSource/downstream on a real example)

---

## Phase 3 — YJS Source Reading

Detailed notes per file in [yjs-learning/](./yjs-learning/README.md).

**Original source files (v1 architecture):**
- [x] `src/structs/Item.js` — core unit, `integrate()` (YATA algorithm)
- [x] `src/utils/StructStore.js` — state vector as G-Counter
- [x] `src/utils/DeleteSet.js` — tombstone system (replaced by IdSet in refactor)
- [x] `src/types/AbstractType.js` — shared base for Y.Text / Y.Map / Y.Array

**Refactored source files (current main branch):**
- [x] `src/utils/Doc.js` — document root, event hub, clientID
- [x] `src/utils/Transaction.js` — commit pipeline, `cleanupTransactions()`
- [x] `src/utils/IdSet.js` — DeleteSet replacement, range set with diff/intersection/slice
- [x] `src/utils/BlockSet.js` — network-layer struct container, exclude/merge logic

Connect to implementations:

- [x] Recognize state vector as G-Counter
- [x] Recognize DeleteSet/IdSet as 2P-Set R / OR-Set tombstones
- [x] Recognize Item `{client, clock}` as OR-Set unique tag
- [x] Understand why Y.Map uses LWW (not MV-Register)
- [x] Annotate the YATA `integrate()` method

---

## Phase 4 — Build: Collaborative Markdown Editor

- [ ] Project scaffolded (YJS + y-webrtc + y-indexeddb + editor)
- [ ] Collaborative text editing working (Y.Text)
- [ ] Formatting / marks working (Y.Map)
- [ ] Presence / cursors working (Awareness)
- [ ] Offline sync working (disconnect tab, edit, reconnect)
- [ ] Persistence working (reload page, state survives)
- [ ] Two browser tabs fully in sync as separate replicas

Log build notes and surprises in [YJS.md](./YJS.md) under Build Log.

---

## Phase 5 — Contribute or Go Deeper

- [ ] Identify at least one contribution candidate from Phase 4 (bug / dx / docs / feature)
- [ ] YATA paper — optional, after Phase 4
- [ ] Kevin Jahns talks/slides — practical engineering decisions
- [ ] Automerge comparison — optional depth
