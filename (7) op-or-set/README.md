# Op-based OR-Set (Spec 15)

**Type:** Operation-based (CmRDT) | **Paper spec:** 15 (Set family)

→ [Back to main README](../README.md) | → [State-based OR-Set (folder 4)](../(4)%20or-set/README.md)

---

## What it is

The paper's actual Spec 15. Our state-based OR-Set (folder 4) was a state-based interpretation — send full state, merge by union. This is the real thing: operations broadcast, applied at every replica.

The semantics are identical — add-wins, observed-remove, re-add after remove. The implementation is radically simpler:

```
State-based OR-Set (folder 4):
  entries    = Map<element, Set<tag>>   ← live tags
  tombstones = Map<element, Set<tag>>   ← dead tags — grow FOREVER
  lookup()   = tag in entries but NOT in tombstones
  merge()    = union(entries), union(tombstones)

Op-based OR-Set (this file):
  entries    = Map<element, Set<tag>>   ← live tags ONLY
  NO tombstones
  lookup()   = any tag in entries
  apply(op)  = physically add or delete tags
```

**Tombstones are gone.** A remove op targets specific tags and physically deletes them. New tags from concurrent adds are never targeted and survive. No trace of old deletes is kept.

```
Replica A: add("x")     → op: {type:'add', element:'x', tag:'0-0'}
Replica B: add("x")     → op: {type:'add', element:'x', tag:'1-0'}
Replica A: remove("x")  → op: {type:'remove', element:'x', tags:{'0-0'}}
                                ↑ only kills what A observed — not B's tag

Apply all ops to C:
  entries.x = {'1-0'}   ← '0-0' was killed, '1-0' survived

lookup('x') = true ✓    ← B's concurrent add wins
```

## What it teaches

- **Why tombstones exist in the state-based version — and why they're not needed here** — In state-based, a remove creates a tombstone to block future merges of the removed tag. In op-based, the remove op carries its target tags explicitly — future add ops have new tags not in the target list, so no blocking is needed.
- **Causal delivery as a replacement for tombstones** — The reason we can physically delete tags: causal delivery guarantees the remove arrives AFTER all adds it observed. Concurrent adds arrive independently. The network contract replaces the storage contract.
- **Operations as the source of truth** — A fresh replica can replay all ops from a log and reach the correct state. No need to ever transmit the full entries map.
- **Why op-based is preferred for sequences** — In a collaborative document, deleting characters without tombstones keeps the struct store small. YJS deletes items by setting a `deleted` flag — but only to maintain position references in the linked list. The actual content is discarded. This is a hybrid: structural tombstones (to maintain ordering) but no content storage for deleted items.

## Files

| File | Purpose |
|---|---|
| `implementation.ts` | OpORSet with add() / remove() / apply() / lookup() |
| `op-or-set.test.ts` | Tests: delivery, observed-remove, commutativity, no tombstone growth, causal delivery requirement |

---

## Why Tombstones Disappear

The state-based version needs tombstones to handle this scenario:

```
A adds x (tag "0-0") — state: entries={x:{"0-0"}}, tombstones={}
A removes x           — state: entries={x:{"0-0"}}, tombstones={x:{"0-0"}}
B (offline) later merges with A
  → union of entries: {x:{"0-0"}} — the add is still here!
  → union of tombstones: {x:{"0-0"}} — the tombstone kills it
  → lookup(x) = false ✓
```

Without the tombstone, B's merge would see `entries={x:{"0-0"}}` and think x is live.

In op-based, this scenario doesn't arise:
- The remove op is delivered to B directly: `{type:'remove', element:'x', tags:{"0-0"}}`
- B applies it: `entries.x.delete("0-0")` — physically gone
- No tombstone needed because the op itself carries the intent permanently

The tradeoff: the op log must be reliably delivered. If B never receives the remove op, x stays in B's set forever. State-based handles this gracefully — the next full-state sync includes the tombstone.

---

## Drawbacks

### 1. Causal delivery is required — without it, remove and add can reverse order

If a remove op arrives before the add op it observed, the remove is a no-op (tag not present yet). The add then arrives and creates the tag — permanently alive, even though the remove logically superseded it.

State-based is immune to this: tombstones block any add from the past, regardless of arrival order.

**Solution:** Enforce causal delivery — buffer operations until their causal dependencies have been applied. YJS does this: an item that references a left/right origin that hasn't arrived yet is held in a buffer and integrated once the dependency arrives.

### 2. Exactly-once delivery required — duplicates must be filtered

The `apply(addOp)` is idempotent (Set.add is idempotent). But in general, CmRDT systems must deduplicate ops to avoid incorrect state.

**Solution:** Assign a unique ID to every op `{replicaId, counter}`. Track the highest counter seen per replica. Discard ops whose counter has already been seen.

### 3. No offline tolerance without an op log

If a replica is offline and misses operations, it must receive them on reconnect. The sender must know which ops the replica missed — which requires maintaining an op log.

State-based doesn't need this: the next full-state sync catches up any replica regardless of how long it was offline.

**Solution:** Maintain an op log per replica. On reconnect, exchange state vectors to determine what's missing and retransmit. This is exactly what YJS does: state vectors track `Map<clientId, highestClock>` and retransmit the missing ops on reconnect.

---

## Checkpoint Answers

**Why no tombstones are needed**
The remove op explicitly names the tags to remove: `{type:'remove', element:'x', tags:{'0-0'}}`. When applied at any replica, it deletes those exact tags. A concurrent add has a new tag not in this set — it arrives as a separate add op and is never deleted. There is no "future merge" that could accidentally revive the deleted tags, because op-based doesn't merge state — it applies individually named operations.

**Why observed-remove still works without tombstones**
Same reasoning as state-based, different mechanism. In state-based: the tombstone persists and blocks future union-merges of the dead tag. In op-based: the tag is physically gone, and concurrent adds have tags that were never in any remove op's target set. The `observed` part works because the remove op captures exactly what it observed at source — nothing more, nothing less.

**Why causal delivery is required**
If a remove op for tags `{t1}` arrives before the add op that created `t1`, the remove is a no-op. The add then creates `t1` — alive, unchecked. The logical intent of the remove (t1 should be dead) is lost. With causal delivery: the add for `t1` always arrives before any remove that observed `t1`. The remove runs after the add — it finds `t1` and deletes it correctly.

---

## Bridge to YJS

YJS insert and delete operations are op-based OR-Set operations applied to a sequence.

**Insert (add equivalent):**
```
atSource: generate Item with unique ID {client, clock}, capture left/right origin
broadcast: send the Item as part of a YJS Update
downstream: each peer calls applyUpdate() — integrates the Item into the linked list
```

**Delete (remove equivalent):**
```
atSource: capture the IDs of all currently-observed items to delete
broadcast: send the DeleteSet — a compact encoding of {client → clock ranges}
downstream: each peer marks the referenced Items as deleted (sets the 'deleted' flag)
```

The critical parallel:
- YJS's `{client, clock}` per Item = our `tag` per add op
- YJS's `DeleteSet` = our remove op's `tags` set (IDs of items to mark deleted)
- YJS's causal delivery (buffering items with missing origins) = our causal delivery requirement
- YJS's state vector exchange on reconnect = our op log retransmission

The one difference: YJS doesn't physically delete items from the linked list (it sets `deleted: true`). This is because items serve a second role as position anchors — concurrent inserts use the left/right origin IDs to determine where to insert. Physically removing an item would break those references. So YJS uses structural tombstones (the item stays, content is discarded), not the full tombstone set of state-based OR-Set.

### Verification Status

| Claim | Status | Where to confirm |
|---|---|---|
| Every Item has a unique `{client, clock}` ID | ✅ Established | `yjs/src/structs/Item.js` — `id` field of type `ID` |
| `DeleteSet` encodes `{client → clock ranges}` | ✅ Established | `yjs/src/utils/DeleteSet.js` — `Map<number, DeleteItem[]>` where each `DeleteItem` is `{clock, len}` |
| Deleted Items stay in linked list with `deleted: true` | ✅ Established | `yjs/src/structs/Item.js` — `deleted` property |
| Items serve as position anchors via left/right origin | ✅ Established | `yjs/src/structs/Item.js` — `origin`, `rightOrigin` fields |
| Operations buffered until origins arrive (causal delivery) | ✅ Established | `yjs/src/utils/StructStore.js` — `pendingStructs` / `integratePendingStructs` |
| Content of deleted Items is discarded (GC) | ⚠️ Verify — GC is optional in YJS; content may only be discarded when GC runs | `yjs/src/structs/Item.js` — `gc()` method; `doc.gc` flag |
