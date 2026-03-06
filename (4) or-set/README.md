# OR-Set (Observed-Remove Set)

**Type:** State-based (CvRDT) | **Paper spec:** Spec 15 (state-based interpretation — the paper's Spec 15 is op-based; see folder 7)

→ [Back to main README](../README.md)

---

## What it is

A set that supports add, remove, and — unlike 2P-Set — **re-add after removal**. Every `add()` attaches a globally unique tag to the element. `remove()` only tombstones the tags it has currently observed. Tags added concurrently by other replicas (not yet received) survive the merge.

```
Both replicas start with: entries={}, tombstones={}

Replica A adds "x"   → entries: { x: {tag "0-0"} }
Replica B adds "x"   → entries: { x: {tag "1-0"} }   ← concurrent, different tag
Replica B removes "x" → tombstones: { x: {"1-0"} }    ← only kills what B saw

Merge:
  entries    = { x: {"0-0", "1-0"} }   ← union
  tombstones = { x: {"1-0"} }          ← union

lookup("x"): is any tag in entries but NOT in tombstones?
  "0-0" → not tombstoned → YES → x is in the set ✓

2P-Set would say: x was removed, gone forever.
OR-Set says:      B only removed what B saw. A's concurrent add survived.
```

This is **add-wins** semantics. It's also why the name is "Observed-Remove" — you only remove what you have observed.

## What it teaches

- **Unique tag per operation** — every `add()` gets a tag that is globally unique (`replicaId-counter`). This tag IS the identity of that specific add. It's the same insight YJS uses for every inserted character.
- **Observed-remove** — `remove()` only kills tags it currently sees. This makes concurrent add+remove resolve in favour of the add, without any explicit "add-wins" rule — it falls out naturally from the tag structure.
- **Re-add after remove** — a new `add()` gets a new tag that was never tombstoned. The old dead tags stay dead; the new live tag makes the element visible again. 2P-Set cannot do this.
- **Unbounded storage as a real-world concern** — OR-Set makes the tombstone growth problem concrete and undeniable.

## Files

| File | Purpose |
|---|---|
| `implementation.ts` | ORSet class with entries + tombstones |
| `or-set.test.ts` | Tests: operations, OR-Set behaviour, convergence, merge laws, drawbacks |

---

## Drawbacks

### 1. Tombstones grow forever — no built-in garbage collection

Every `remove()` adds permanently to `tombstones`. Even after an element is removed and never re-added, its (element, tag) pairs remain in both `entries` and `tombstones` forever. A system with frequent adds and removes will accumulate unbounded state.

**The core problem:** To safely delete a tombstone, you must know every replica has received it. But knowing that requires a consensus round — coordination — which defeats the purpose of a CRDT.

**Solution — Stable causal GC:** Track a "stable frontier" — the set of operations that every known replica has seen. Tombstones below the frontier can be safely deleted. This requires a periodic coordination step (e.g. a heartbeat protocol). It's a hybrid: CRDT for normal operation, coordination for GC only.

**Solution — YJS's approach:** YJS maintains a "delete set" (tombstones) alongside document snapshots. When loading from a snapshot, operations before the snapshot's frontier are already baked in and their tombstones can be discarded. This is the same idea — defer GC to snapshot time, which requires a weak form of coordination.

### 2. Add-wins semantics are baked in — cannot choose remove-wins

Concurrent add and remove always resolves to "add wins." There is no switch to flip. If your domain needs remove-wins (a blocklist, a ban system, an access revocation), OR-Set will give you wrong answers.

**Solution:** Use 2P-Set if remove-wins is required. The choice between 2P-Set and OR-Set is a domain decision made at design time — it cannot be changed later without migrating all data.

**Solution — Flags on elements:** Some systems implement both behaviours by adding a "force-remove" flag that acts as a 2P-Set tombstone on top of OR-Set's tag structure. This is complex and typically not worth it — pick the right tool for the domain.

### 3. Tag uniqueness is a hard assumption — collision = silent corruption

If two replicas generate the same tag for different `add()` calls, a `remove()` on one element will accidentally tombstone the other's tag. The element silently disappears. No error is raised.

Our implementation prevents this with `${replicaId}-${counter}`. This works as long as replicaIds are unique across replicas — which itself is an assumption.

**Solution — UUIDs (v4):** Use `crypto.randomUUID()` as the tag. The collision probability is ~1 in 2¹²². Production systems (Riak, YJS) use UUIDs for this reason.

**Solution — Hybrid:** `${replicaId}-${lamportClock}` where the Lamport clock is incremented on every operation and adjusted on receive. This gives both uniqueness and causal ordering.

### 4. Deleted data is never truly gone — GDPR and privacy concern

Because tombstones must be kept for GC to work correctly, user data that has been "deleted" is still physically present in `entries` (the original add) and `tombstones` (the remove marker). In privacy-sensitive systems, this creates compliance problems.

**Solution:** There is no clean solution within the CRDT model. Options:
- **Encryption:** Store encrypted values. "Deletion" = discard the decryption key. Data remains but is unreadable.
- **Indirection:** Store references (IDs) in the CRDT, actual data in a separate deletable store. Delete from the external store — the CRDT retains a dangling reference.
- **Out-of-band deletion:** Accept that true deletion requires coordination and implement a separate, centralised deletion protocol. This is what most real systems do.

---

## Checkpoint Answers

These answer the Phase 2 checklist questions from [STUDY_ROADMAP.md](../STUDY_ROADMAP.md) as they apply to OR-Set.

**Why OR-Set needs unique tags**
Without unique tags, remove would have to target the element by name — which means it would kill all adds of that element, including concurrent ones from other replicas that haven't been received yet. Unique tags let remove target only the specific adds it has observed. Tags added concurrently survive because they were never tombstoned. The uniqueness is what makes "observed-remove" possible.

**Why remove cannot blindly delete**
If remove erased the element outright, any concurrent add from another replica would bring it back on merge (union would restore it). OR-Set solves this differently from 2P-Set: instead of preventing re-adds (2P-Set), it allows them — by giving each add its own tag, a remove only kills what it saw. Concurrent adds are untouched.

**Understand tombstones and their cost**
OR-Set has the same fundamental tombstone problem as 2P-Set, but worse — instead of one entry per element in `R`, OR-Set stores one entry per (element, tag) pair. Each add/remove cycle adds two permanent records. A high-churn system accumulates unbounded state. There is no safe way to delete tombstones without coordination.

**All replicas converge without coordination**
Verified by convergence tests. Two replicas independently add and remove elements — merging in either order produces identical `lookup()` results. No lock, no leader.

**The key invariant: tag uniqueness**
OR-Set's entire correctness depends on no two adds ever sharing a tag. If they do, a remove on one element silently tombstones the other's tag — data corruption with no error. In our implementation: `replicaId-counter`. In production: UUID v4.

---

## Bridge to YJS

YJS's `Item` — the unit of every insertion in a document — has a unique ID: `{client: number, clock: number}`. This is identical to our `"replicaId-counter"` tag. Every character, every element in a YJS array, every key-value pair in a YJS map is an `Item` with a unique ID.

When a YJS item is deleted, it is **not removed** from the document's linked list. Its `deleted` flag is set to true, and its ID is added to the delete set. This is tombstoning — exactly what OR-Set does. On merge, delete sets are unioned, and items flagged as deleted are not surfaced to the application — exactly `lookup()` filtering by tombstones.

The unique ID per operation + tombstone deletion pattern IS OR-Set. YJS is OR-Set applied to sequences.

### Verification Status

| Claim | Status | Where to confirm |
|---|---|---|
| Every Item has a unique `{client, clock}` ID | ✅ Established | `yjs/src/structs/Item.js` — `id` field |
| Deleted Items stay in linked list with `deleted: true` | ✅ Established | `yjs/src/structs/Item.js` — `deleted` flag |
| Delete sets are unioned on merge | ✅ Established | `yjs/src/utils/DeleteSet.js` — `mergeDeleteSets()` |
| Items flagged deleted are not surfaced to the application | ✅ Established | `yjs/src/types/YArray.js`, `YText.js` — iterators skip deleted items |
| Every Y.Array element / Y.Map entry is an Item | ⚠️ Verify — Items wrap content; confirm every entry path goes through an Item | `yjs/src/types/YArray.js`, `yjs/src/types/YMap.js` |
| Item ID added to delete set on deletion | ⚠️ Simplified — ID is encoded into `DeleteSet` as a clock range, not stored as `"replicaId-counter"` string | `yjs/src/utils/DeleteSet.js` — `addToDeleteSet()` |
