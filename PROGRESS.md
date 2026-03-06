# Study Progress Tracker

Update this file as you move through each phase. Mark items done with [x].

→ [Full Roadmap](./STUDY_ROADMAP.md) | → [Main README](./README.md)

---

## Current Position

**Phase:** 2.5 — Pre-YJS Reading
**Status:** All 7 implementations done. Ready to read Specs 19 and 21 from the paper, then move to YJS

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

- [ ] **Spec 19 — RGA** (Replicated Growable Array)
  Why: understand what YATA is fixing before you read YJS

- [ ] **Spec 21 — OR-Cart** (Observed-Remove Shopping Cart)
  Why: OR-Set applied to a map → direct precursor to Y.Map

Optional reads (do these if you have time, skip if not):

- [ ] Spec 7 — PN-Counter (CRDT composition)
- [ ] Spec 13 — U-Set (tombstones drop under causal delivery)
- [ ] Spec 9 — Op-based LWW (atSource/downstream on a real example)

---

## Phase 3 — YJS Internals (Days 6+)

Read in this order inside the YJS source:

- [ ] `StructStore` — how items are stored and indexed
- [ ] `Item` structure — the unit of every insertion (`{client, clock}` ID, content, links)
- [ ] `DeleteSet` — the tombstone system (maps directly to our tombstone work)
- [ ] Update encoding — how YJS compresses and transmits state
- [ ] Garbage collection — when and why YJS GC is optional

Connect to our implementations:

- [ ] Recognize state vector as G-Counter
- [ ] Recognize DeleteSet as the tombstone set (2P-Set `R` / OR-Set `tombstones`)
- [ ] Recognize Item ID `{client, clock}` as OR-Set unique tag
- [ ] Understand why Y.Map uses LWW (not MV-Register) for key conflicts
- [ ] See how YATA differs from RGA (what interleaving problem it solves)

---

## Phase 4 — Optional Depth

- [ ] YATA paper (basis for YJS algorithm) — only after Phase 3
- [ ] Kevin Jahns talks/slides — practical engineering decisions
- [ ] Undo support for CRDTs — if building an editor
