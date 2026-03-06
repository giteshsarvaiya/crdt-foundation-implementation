# G-Counter (Grow-only Counter)

**Type:** State-based (CvRDT) | **Paper spec:** 3–5 (Counter family)

→ [Back to main README](../README.md)

---

## What it is

A distributed counter that only goes up. Each replica owns one slot in a shared array and can only increment its own slot. The total value is the sum of all slots. Merging two replicas takes the element-wise max.

```
3 replicas, initial state: [0, 0, 0]

Replica 0 increments twice:  [2, 0, 0]
Replica 1 increments once:   [0, 1, 0]   ← concurrent, no coordination

Merge (element-wise max):    [2, 1, 0]
Value (sum):                  3           ← correct, no coordination needed
```

## What it teaches

- **Vector clocks** — the payload IS a vector clock. Each slot tracks how much one replica has contributed. This pattern appears in almost every other CRDT.
- **Semilattice ordering** — `max` per slot is the Least Upper Bound for vectors of integers. Once you pick a valid LUB as your merge, convergence is mathematically guaranteed.
- **The three merge laws** — commutativity, associativity, idempotency. All three are satisfied by element-wise max.

## Files

| File | Purpose |
|---|---|
| `implementation.ts` | G-Counter class |
| `implementation.test.ts` | Tests: operations, convergence, merge laws |

---

## Drawbacks

### 1. Fixed replica count

The array size is set at construction (`new GCounter(3)`). You cannot add a new replica later without resizing the array — and resizing requires coordination across all existing replicas.

**Solution:** Use a `Map<replicaId, count>` instead of a fixed array. New replicas start with no entry (treated as 0) and are added lazily as they appear. This is how production systems implement it.

### 2. Only counts up — no decrement

A G-Counter can never decrease. You cannot undo an increment.

**Solution:** PN-Counter (Spec 5 in the paper). Use two G-Counters internally — one for increments (`P`) and one for decrements (`N`). Value = `P.value() - N.value()`. Merge = merge both G-Counters independently. We skipped implementing this because once you understand G-Counter, PN-Counter is a 5-line extension — there's no new concept.

### 3. Bandwidth grows with replica count

Every sync sends the full array — even slots that haven't changed. With 100 replicas, you send 100 integers even if only one changed.

**Solution:** Delta-CRDTs. Instead of sending the full state, send only the "delta" — the part that changed since the last sync. The delta is merged the same way as the full state. YJS uses a form of this in its update protocol.

---

## Checkpoint Answers

These answer the Phase 2 and Phase 3 checklist questions from [STUDY_ROADMAP.md](../STUDY_ROADMAP.md) as they apply to G-Counter.

**All replicas converge without coordination**
Yes — verified by the convergence test. Two replicas increment independently, merge in both orders, reach the same value. No lock, no leader, no network agreement required.

**Simulate duplicate messages**
Covered by the idempotency test: `merge(A, A).value() === A.value()`. Receiving the same state twice changes nothing — element-wise max of identical vectors is the same vector.

**Simulate reordered messages**
Covered by the commutativity test: `merge(A, B).value() === merge(B, A).value()`. Whether A's state arrives before B's or after makes no difference.

**Simulate delayed merges**
Covered by the associativity test: `merge(A, merge(B,C)) === merge(merge(A,B), C)`. Whether replicas sync in pairs or all at once, the result is identical.

**Why sending full state doesn't scale**
G-Counter sends the entire vector on every sync. With N replicas, every sync is O(N) even if only one slot changed. This is the bandwidth drawback documented above — the solution is delta-CRDTs.

**Why vector clocks exist**
G-Counter's payload IS a vector clock. Each slot answers "how much has replica i contributed?" When two peers connect and exchange vectors, they can compute exactly which operations the other is missing — without sending the full history. This is precisely how YJS state vectors work.

---

## Bridge to YJS

YJS tracks which operations each replica has seen using **state vectors** — a `Map<clientId, clock>` where `clock` is a logical counter. This is a G-Counter. When two YJS peers connect, they exchange state vectors to figure out what the other is missing — then only send the missing operations, not the full document.
