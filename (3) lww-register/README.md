# LWW-Register (Last-Write-Wins Register)

**Type:** State-based (CvRDT) | **Paper spec:** 6–7 (Register family)

→ [Back to main README](../README.md)

---

## What it is

A register (single-value store) that resolves write conflicts using timestamps. When two replicas have written different values, the one with the higher timestamp wins. The losing write is silently discarded.

```
Replica A writes ("alice", t=10)
Replica B writes ("bob",   t=20)   ← concurrent, neither knows about the other

merge(A, B) → "bob"    (t=20 > t=10)
merge(B, A) → "bob"    ← same result from both sides ✓
```

When timestamps are equal, a **replicaId tiebreaker** is used — higher replicaId wins. This makes merge deterministic even on ties, preserving commutativity.

## What it teaches

- **Timestamp-based conflict resolution** — the simplest way to pick a winner when replicas disagree.
- **Silent data loss** — the losing write leaves no trace. No error, no warning. This is the defining tradeoff of LWW.
- **Tiebreaker necessity** — without a secondary tiebreaker (replicaId), equal timestamps break commutativity: `merge(A,B) ≠ merge(B,A)`. Tiebreakers must be based on the data itself, not on who calls merge.
- **Generics (`<T>`)** — the register works for any value type, demonstrating how CRDTs can be type-parametric.

## Files

| File | Purpose |
|---|---|
| `implementation.ts` | LWWRegister<T> class with replicaId tiebreaker |
| `lww-register.test.ts` | Tests: operations, tiebreaker, convergence, merge laws |

---

## Drawbacks

### 1. Silent data loss — the losing write is gone forever

The most fundamental limitation of LWW. When two replicas write concurrently, one write is silently discarded after merge. The user who wrote it has no idea their change was overwritten.

**Solution — MV-Register (Multi-Value Register):** Instead of picking a winner, keep ALL concurrent values. After merge, the register holds a set of values. The application layer decides what to do with them (show a conflict UI, merge them programmatically, etc.). Git's merge conflicts are a form of this — it surfaces the conflict rather than silently discarding.

**Solution — Domain design:** Use LWW only when "last write should win" is actually correct for your domain — e.g. a user's profile photo, a sensor reading, a config flag. Avoid it for anything where both concurrent writes have independent value.

### 2. Timestamp collision breaks commutativity

If two replicas write at the exact same timestamp (common on systems with millisecond-resolution clocks), a naive "keep existing on tie" rule means:
- `A.merge(B)` → A wins (A thinks it's "existing")
- `B.merge(A)` → B wins (B thinks it's "existing")
- Replicas diverge permanently.

**Solution — ReplicaId tiebreaker (what we implemented):** Higher replicaId always wins on tie. Both replicas see the same two IDs and make the same decision.

**Solution — Hybrid Logical Clocks (HLC):** Combine wall clock time with a logical counter. The counter breaks ties that happen within the same millisecond. Used in CockroachDB and YugabyteDB.

**Solution — UUIDs per write:** Assign a random UUID to each write. On tie, compare UUIDs lexicographically. Collision probability is astronomically low.

### 3. Clock skew — wall clocks can lie

In a distributed system, clocks on different machines are never perfectly in sync. A replica with a clock running 2 seconds fast will always "win" conflicts, even if its write was logically earlier. LWW assumes clocks are reliable — they are not.

**Solution — Logical clocks (Lamport timestamps):** Instead of wall time, use a counter that increments on every write and is adjusted upward on every receive. Logical clocks track causal order, not wall time. They are immune to clock skew.

**Solution — Vector clocks:** Track the full causal history. If two writes have no causal relationship (neither happened-before the other), treat them as concurrent and surface the conflict rather than silently discarding.

### 4. "Latest" doesn't always mean "correct"

The replica with the fastest clock or the most recent network activity always wins. A stale write that happens to arrive with a higher timestamp (due to clock skew) will silently overwrite a newer logical write.

**Solution:** Accept that LWW is a heuristic, not a guarantee. Use it only in domains where approximate recency is good enough and occasional wrong overrides are tolerable (e.g. caches, ephemeral state).

---

## Checkpoint Answers

These answer the Phase 2 checklist questions from [STUDY_ROADMAP.md](../STUDY_ROADMAP.md) as they apply to LWW-Register.

**Why "last write wins" is usually a bad idea**
Because the losing write is silently discarded with no warning, no error, no conflict notification. Two users editing the same field concurrently — one edit simply vanishes. In most collaborative contexts, both edits had independent value. LWW throws one away without asking. It's only acceptable when "latest should win" is genuinely correct for the domain (sensor readings, profile photos, config flags).

**Why tiebreakers must be data-based, not caller-based**
Without a tiebreaker, equal timestamps produce `merge(A, B) ≠ merge(B, A)` — A keeps itself, B keeps itself, replicas diverge permanently. The bug: "keep existing" depends on who is calling merge, not on the data. Fix: use replicaId as a tiebreaker — both replicas look at the same two IDs and always pick the same winner. The decision is now in the data, not the caller.

**Why logical clocks are better than wall clocks**
Wall clocks can lie — a machine running 2 seconds fast always wins LWW conflicts, even for logically earlier writes. Logical clocks (Lamport, vector) track causal order instead of physical time. They never go backwards and are immune to clock skew.

**All replicas converge without coordination**
Verified by the convergence tests. Two replicas write different values at different timestamps — merging in either order always produces the value with the higher timestamp. The tiebreaker test confirms this holds even when timestamps are equal.

---

## Bridge to YJS

YJS maps (used in `Y.Map`) use LWW semantics for key conflicts. If two clients set the same key concurrently, the one with the higher Lamport clock wins. YJS uses logical clocks (not wall time) to avoid clock skew issues — but the resolution strategy is identical to what we implemented here.
