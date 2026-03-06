# MV-Register (Multi-Value Register)

**Type:** State-based (CvRDT) | **Paper spec:** 10 (Register family)

→ [Back to main README](../README.md)

---

## What it is

A register that **surfaces concurrent writes instead of silently discarding them**. When two replicas write different values concurrently, both values survive the merge. The application layer sees a set of values and decides what to do — show a conflict UI, merge programmatically, ask the user. Nothing is thrown away without acknowledgment.

```
Both replicas start with: entries=[], vv=[0,0]

Replica A assigns "alice"  → entries: [("alice", vv=[1,0])]
Replica B assigns "bob"    → entries: [("bob",   vv=[0,1])]   ← concurrent, neither knew about the other

Merge:
  entries = [("alice", [1,0]), ("bob", [0,1])]
  [1,0] and [0,1] are INCOMPARABLE — neither happened-before the other
  Both survive.

values() → ["alice", "bob"]   ← the conflict is visible

Contrast with LWW-Register:
  merge(A, B) → "bob"   ← "alice" is gone. No warning.
```

This is the alternative to Last-Write-Wins: **Multi-Value** — keep everything concurrent, let the application decide.

## What it teaches

- **Version vectors as causal timestamps** — each write is tagged with a version vector that records what the writing replica had seen at the time. Two VVs can be compared: one happened-before another, or they are incomparable (concurrent).
- **The "dominated entry" rule** — merge keeps only entries whose VV is not happened-before any other entry's VV. Entries that causally follow others supersede them; entries that are concurrent coexist.
- **Conflict surfacing vs conflict hiding** — LWW hides the conflict (picks one winner silently). MV-Register exposes it. Neither is universally right — the choice is a domain decision.
- **Resolution by reassignment** — a client that sees the conflicting set and calls `assign("resolved")` generates a VV that dominates all concurrent entries. After merge, only "resolved" survives. The conflict was acknowledged and resolved.

## Files

| File | Purpose |
|---|---|
| `implementation.ts` | MVRegister<T> class with version-vector-based entries |
| `mv-register.test.ts` | Tests: operations, concurrent/sequential behaviour, convergence, merge laws, drawbacks |

---

## How the version vector works

Every write gets tagged with the writer's current version vector, incremented at the writer's slot. The VV is the write's "causal birth certificate" — it encodes exactly what the writer had seen before writing.

```
Start:    vv = [0, 0, 0]

A writes "alice":   vv[0]++  →  newVV = [1, 0, 0]
                    entries = [("alice", [1, 0, 0])]

(A merges B's state, B had vv [0, 1, 0])
A's vv = max([1,0,0], [0,1,0]) = [1, 1, 0]

A writes "charlie": vv[0]++  →  newVV = [2, 1, 0]
                    entries = [("charlie", [2, 1, 0])]

[2, 1, 0] dominates [1, 0, 0] and [0, 1, 0]
→ merge will discard alice and bob, keep only charlie
```

The merge rule: take the union of all entries from both replicas, keep only entries whose VV is not happened-before any other entry's VV.

---

## Drawbacks

### 1. Application complexity — values() may return multiple values

Every piece of code that reads the register must handle the multi-value case. A UI must decide how to show two concurrent values. A sync protocol must decide how to merge them. With LWW, the caller always gets exactly one value. With MV-Register, it must be ready for any number.

**Solution:** Design your application layer to explicitly handle conflicts. Git's merge UI is a good model — surface the conflict, let the user resolve it. For domains where automatic resolution is correct (e.g. sensor readings), LWW is the better fit.

### 2. Conflict set is unbounded — N concurrent writers = N surviving values

In a system with many writers who are all offline and then reconnect simultaneously, `values()` can return a list of N items. The application must handle arbitrarily large conflict sets.

**Solution:** Limit the number of concurrent writers in practice, or periodically run a "conflict resolution" sweep. In most collaborative editing systems, true many-way conflicts are rare — usually 2–3 concurrent users at most.

### 3. Fixed replica count — same limitation as G-Counter

The version vector size is set at construction (`new MVRegister(replicaId, numReplicas)`). Adding a new replica requires resizing, which requires coordination.

**Solution:** Use `Map<replicaId, clock>` instead of a fixed array. Absent entries are treated as 0. New replicas join lazily. This is the same fix as for G-Counter.

### 4. More storage than LWW — one entry per concurrent write

LWW stores one value and one timestamp. MV-Register stores one `(value, versionVector)` pair per concurrent write. In the conflict case, that's N pairs, each with a VV of size R (replica count).

**Solution:** Accept the tradeoff. MV-Register is the right tool when lost writes are unacceptable and the application can handle conflicts. If storage is constrained and occasional data loss is acceptable, use LWW.

---

## Checkpoint Answers

These answer the Phase 2 checklist questions from [STUDY_ROADMAP.md](../STUDY_ROADMAP.md) as they apply to MV-Register.

**Why concurrent writes both survive**
Each write is tagged with the version vector of the writer at the time of writing. Two concurrent writes produce VVs that are incomparable — neither happened-before the other. The merge rule keeps entries whose VVs are not dominated by any other. Both incomparable VVs survive. This is mathematically automatic: no explicit "both survive" rule, just the dominance filter applied to a union.

**Why a sequential write supersedes concurrent ones**
If replica A has seen a conflict (merged both VVs), its current VV is the element-wise max of all entry VVs. When A calls `assign(v)`, it increments its own slot on top of that combined VV. The resulting VV is strictly greater than every existing entry VV. After merge, every old entry is dominated and filtered out. Only the new value survives — the conflict is resolved.

**Why version vectors are better than wall-clock timestamps for this**
Wall clocks can skew — a replica whose clock runs fast will always "win" LWW, even if its write was logically earlier. Version vectors track causal order, not physical time. Two concurrent writes always produce incomparable VVs regardless of what the clocks say. Two sequential writes always produce dominating VVs regardless of clock skew.

**All replicas converge without coordination**
Verified by the convergence tests. Replicas writing concurrently and merging in any order always produce the same set of values. The three merge laws hold: commutative (union is symmetric), associative (union is associative), idempotent (union with itself changes nothing).

---

## Bridge to YJS

`Y.Map` uses **LWW**, not MV-Register. When two clients set the same key concurrently, the one with the higher Lamport clock wins — the other write is silently discarded.

Why not MV-Register? In a collaborative text editor, every keystroke is a write. Concurrent edits happen hundreds of times per second. An MV-Register `Y.Map` would surface conflicts on virtually every operation — the application would be constantly asked to resolve sets of 2–3 values for every character. That's unusable.

The engineering tradeoff:
- **MV-Register** — correct for domain data (user profiles, config, shared state) where concurrent edits are rare and losing one is unacceptable
- **LWW** — correct for high-frequency updates where Lamport clock ordering is a good-enough heuristic and the conflict resolution overhead would dominate

YJS's designers chose LWW for `Y.Map` because real-time collaboration produces so many concurrent operations that surfacing each as a conflict would destroy usability. For the document sequence itself (characters, blocks), YJS uses the YATA algorithm — a purpose-built sequence CRDT, not a register.

### Verification Status

| Claim | Status | Where to confirm |
|---|---|---|
| `Y.Map` uses LWW, not MV-Register | ✅ Established | `yjs/src/types/YMap.js` — `_integrate()` |
| Higher Lamport clock wins on concurrent key write | ✅ Established | `yjs/src/types/YMap.js` |
| YJS uses YATA for document sequence (not a register) | ✅ Established | YATA paper + `yjs/src/structs/Item.js` left/right origin logic |
| "designers chose LWW because conflicts would be too noisy" | ⚠️ Design intent inferred — no official statement found | Cross-check with Kevin Jahns talks or YJS GitHub issues |
