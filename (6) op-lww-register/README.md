# Op-based LWW-Register (Spec 9)

**Type:** Operation-based (CmRDT) | **Paper spec:** 9 (Register family)

→ [Back to main README](../README.md) | → [State-based version (Spec 8)](../(3)%20lww-register/README.md)

---

## What it is

The same Last-Write-Wins conflict resolution as Spec 8 — but instead of sending the full register state on every sync, you send the **operation**: a small `{value, timestamp, replicaId}` object.

```
State-based (Spec 8):
  A.merge(B)  ← send entire register state, call merge on receipt

Op-based (Spec 9):
  op = A.write("alice")     ← generates {value: "alice", timestamp: 2, replicaId: 0}
  B.apply(op)               ← B replays the operation
  C.apply(op)               ← C replays the same operation
```

The conflict resolution logic — higher timestamp wins, replicaId breaks ties — is identical. Only the delivery mechanism changes.

## What it teaches

- **The atSource / downstream split in code** — `write()` is atSource: it captures context and generates the op without mutating external state. `apply()` is downstream: it runs at every replica to mutate local state. This two-phase structure is the skeleton of every CmRDT, including YJS.
- **Operations as first-class objects** — the op is a plain value that can be broadcast to N replicas, queued, logged, and replayed. The register can be rebuilt from scratch by replaying the op log.
- **Lamport clock** — we generate timestamps using a logical counter, not wall time. It increments on every write and takes the max on every receive. This makes the ordering immune to clock skew while still allowing LWW to work.
- **Why LWW ops commute** — `apply(opA, opB) == apply(opB, opA)` because the winner is determined by `(timestamp, replicaId)` — data in the op, not the order of apply calls. This is what makes it a valid CmRDT.

## Files

| File | Purpose |
|---|---|
| `implementation.ts` | OpLWWRegister<T> with write() / apply() / read() |
| `op-lww-register.test.ts` | Tests: delivery, op structure, commutativity, Lamport clock |

---

## The Two-Phase Structure

Every CmRDT follows this pattern:

```
Phase 1 — atSource (write()):
  1. Capture context at this replica right now (clock, replicaId)
  2. Create the operation
  3. Apply at source — source is also a downstream replica
  4. Return the op — caller broadcasts it

Phase 2 — downstream (apply(op)):
  1. Update local clock (Lamport: take max of local and incoming)
  2. Apply the LWW rule: does this op win over the current state?
  3. If yes: update value, winningTimestamp, winningReplicaId
  4. If no: discard. State unchanged.
```

This is exactly how YJS handles every operation:
- An insertion is prepared at the source (capturing left/right neighbours, Lamport clock)
- It's broadcast as an operation to all peers
- Each peer calls its own version of `apply()` to integrate it into the document

## Drawbacks

### 1. Reliable delivery is required — drops corrupt state permanently

State-based: if a state sync is lost, the next sync will include everything missed. The lost sync is harmless.

Op-based: if an operation is dropped, the replica never sees it. State diverges permanently. The op must be retransmitted.

**Solution:** Use a reliable broadcast protocol (TCP, WebSocket with reconnect, or an op log with sequence numbers). YJS solves this by tracking which ops each peer has seen (via state vectors) and retransmitting missing ops on reconnect.

### 2. Exactly-once delivery is required — duplicate ops corrupt state for non-idempotent CmRDTs

For LWW specifically, applying the same op twice is safe (the same timestamp+replicaId either wins or doesn't — applying it again changes nothing). But many CmRDTs are not idempotent — a counter `increment` op applied twice would count twice.

**Solution:** Track received operation IDs and deduplicate on arrival. YJS uses Lamport clock + clientId as a unique op ID and filters duplicates at the struct store level.

### 3. All operations must commute — non-commuting ops require causal delivery

LWW ops commute naturally (the winner is data-dependent, not order-dependent). But for OR-Set remove ops, causal delivery is required: the remove must arrive after all the adds it observed. Without this guarantee, the remove can run before the add and be silently ignored, leaving a "zombie" entry.

**Solution:** Implement causal delivery using vector clocks or Lamport clocks with ordering rules. YJS enforces causal ordering: an operation that references a left/right origin that hasn't arrived yet is buffered until the origin arrives.

---

## Checkpoint Answers

**The atSource / downstream split — why two phases?**
atSource runs once, at the source, synchronously. It captures the state of the world at that moment (clock, ids, context) and packages it into an op. If the operation needs a precondition checked (`element must exist to be removed`), it's checked here against local state. downstream runs everywhere, asynchronously. It only receives the pre-packaged op — no need to re-check local state, no need to re-capture context. The split ensures the op carries everything it needs to be applied correctly anywhere.

**Why Lamport clock instead of wall time**
Wall clocks skew: a replica running 2 seconds fast always wins LWW conflicts. Lamport clocks track logical ordering: they increment on every local event and take the max on every receive. Two operations on the same replica are always ordered (later one has higher clock). Operations on different replicas may tie — the replicaId tiebreaker handles that. The ordering is causal, not physical.

**Why operations commute for LWW**
`apply(opA, opB) == apply(opB, opA)` because: whichever op has the higher `(timestamp, replicaId)` tuple wins, always. This comparison uses only data IN the op — not local state, not arrival order. Whether opA or opB arrives first, the final state is the same. This is what makes LWW a valid CmRDT.

---

## Bridge to YJS

YJS's update protocol is op-based. When a client inserts a character:

1. **atSource**: YJS captures the insertion context — the unique `{client, clock}` ID for this item, the left and right `origin` (which existing items neighbour this insertion), the content. This is packaged into an `Update`.

2. **broadcast**: the Update is sent to all connected peers (via WebSocket, IndexedDB, etc.)

3. **downstream (apply)**: each peer calls `Y.applyUpdate(doc, update)`. This is downstream — it integrates the operation into the document's struct store.

The `{client, clock}` ID in every YJS Item is the Lamport clock in our op. Every update carries a Lamport clock value. When two peers reconnect, they exchange state vectors to figure out which ops the other is missing — then retransmit only those, exactly like the "op log replay" in our test.

### Verification Status

| Claim | Status | Where to confirm |
|---|---|---|
| YJS update protocol is op-based | ✅ Established | `Y.applyUpdate()` public API; updates are encoded op logs |
| Insert captures `{client, clock}` + left/right origin | ✅ Established | `yjs/src/structs/Item.js` — `id`, `origin`, `rightOrigin` fields |
| `Y.applyUpdate(doc, update)` is the downstream call | ✅ Established | YJS public API, `yjs/src/utils/updates.js` |
| State vector exchange finds missing ops on reconnect | ✅ Established | `y-protocols/src/sync.js` — two-step sync protocol |
| `{client, clock}` is a Lamport clock, not wall time | ✅ Established | Clock increments per operation, never uses `Date.now()` |
