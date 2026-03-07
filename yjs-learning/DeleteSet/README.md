# DeleteSet.js — Annotated

> **Note: This file no longer exists in the current YJS main branch.**
> `DeleteSet.js` was replaced by two files in the refactor:
> - **[`IdSet.js`](../IdSet/README.md)** — general-purpose range set that replaced `DeleteSet` for both deletions and insertions
> - **[`BlockSet.js`](../BlockSet/README.md)** — network-layer struct container that replaced the update-decoding role
>
> The concepts documented here (range compression, tombstone merge, causal delivery buffer) are still valid — they transferred directly into `IdSet` and `BlockSet`. Read this for the theory, then read IdSet/BlockSet for the current implementation.

`src/utils/DeleteSet.js` was the tombstone system. Maps to our 2P-Set's `R` set — but with one critical upgrade: instead of storing individual deleted IDs, it stores **ranges**. One `DeleteItem` covers thousands of consecutive deletions.

→ [Improvements and open questions](./improvements.md)

---

## Table of Contents

- [The Key Design Decision — DeleteSet is Ephemeral](#the-key-design-decision--deleteset-is-ephemeral)
- [The Data Structures](#the-data-structures)
- [Membership Check — `isDeleted` and `findIndexDS`](#membership-check--isdeleted-and-findindexds)
- [The Range Compression — `sortAndMergeDeleteSet`](#the-range-compression--sortandmergedelete)
- [Merging Multiple DeleteSets — `mergeDeleteSets`](#merging-multiple-deletesets--mergedeletesets)
- [Building from StructStore — `createDeleteSetFromStructStore`](#building-from-structstore--createdeleteset-fromstructstore)
- [Applying Incoming Deletions — `readAndApplyDeleteSet`](#applying-incoming-deletions--readandapplydeleteset)
- [Serialization — `writeDeleteSet` / `readDeleteSet`](#serialization--writedeleteset--readdeleteset)
- [Theory Mapping](#theory-mapping)
- [Key Takeaways](#key-takeaways)

---

## The Key Design Decision — DeleteSet is Ephemeral

The comment at the top of the file is the most important thing in it:

```javascript
/**
 * We no longer maintain a DeleteStore. DeleteSet is a temporary object
 * that is created when needed.
 * - When created in a transaction, it must only be accessed after sorting and merging
 * - We do not create a DeleteSet when we send a sync message.
 *   The DeleteSet message is created directly from StructStore
 * - We read a DeleteSet as part of a sync/update message.
 *   In this case the DeleteSet is already sorted and merged.
 */
```

**DeleteSet is not a persistent data structure.** There is no long-lived `R` set sitting next to the document. The real source of truth for deletions is the `deleted` flag on each Item in `StructStore`.

DeleteSet is computed on demand:
- During a **transaction** — built up as deletions happen, sent to peers at commit
- During **sync** — reconstructed from StructStore via `createDeleteSetFromStructStore`
- During **receiving an update** — decoded and applied immediately via `readAndApplyDeleteSet`

This is different from our 2P-Set where `R` was a persistent field on the object. YJS's approach saves memory — you never store a separate tombstone set; you just scan the flags when you need them.

---

## The Data Structures

### `DeleteItem`

```javascript
class DeleteItem {
  constructor(clock, len) {
    this.clock = clock   // start of the range
    this.len = len       // length of the range
  }
}
```

Represents a **range** of deleted clocks: `[clock, clock + len)`.

Compare to our 2P-Set:
```
2P-Set R:   { id_5, id_6, id_7, id_8, id_9 }  ← 5 entries
DeleteItem: { clock: 5, len: 5 }                ← 1 entry, same coverage
```

When a user selects 10,000 characters and deletes them, that's ONE `DeleteItem`. Our 2P-Set would need 10,000 entries.

### `DeleteSet`

```javascript
class DeleteSet {
  constructor() {
    this.clients = new Map()   // Map<clientId, Array<DeleteItem>>
  }
}
```

Same shape as `StructStore.clients` — per-client arrays. But here the arrays hold `DeleteItem` ranges instead of `Item` structs.

---

## Membership Check — `isDeleted` and `findIndexDS`

```javascript
export const isDeleted = (ds, id) => {
  const dis = ds.clients.get(id.client)
  return dis !== undefined && findIndexDS(dis, id.clock) !== null
}
```

```javascript
export const findIndexDS = (dis, clock) => {
  let left = 0
  let right = dis.length - 1
  while (left <= right) {
    const midindex = math.floor((left + right) / 2)
    const mid = dis[midindex]
    const midclock = mid.clock
    if (midclock <= clock) {
      if (clock < midclock + mid.len) {
        return midindex      // clock is within this range — deleted
      }
      left = midindex + 1
    } else {
      right = midindex - 1
    }
  }
  return null               // not found — not deleted
}
```

Standard binary search over sorted ranges. Same range-aware comparison as `findIndexSS` in StructStore — `midclock <= clock < midclock + mid.len`.

**Two important differences from `findIndexSS`:**

1. **Returns `null` instead of throwing.** "Not found" is a valid result here — it means "not deleted." In StructStore, not finding a struct means something is wrong with the store (throw). In DeleteSet, not finding an ID just means it's alive.

2. **No pivot optimization.** `findIndexSS` had a proportional first-guess. `findIndexDS` uses plain binary search. Interesting inconsistency — see improvements.

---

## The Range Compression — `sortAndMergeDeleteSet`

This is the most algorithmically interesting function in the file.

```javascript
export const sortAndMergeDeleteSet = ds => {
  ds.clients.forEach(dels => {
    dels.sort((a, b) => a.clock - b.clock)

    let i, j
    for (i = 1, j = 1; i < dels.length; i++) {
      const left = dels[j - 1]
      const right = dels[i]
      if (left.clock + left.len === right.clock) {
        left.len += right.len          // adjacent ranges — extend left, skip right
      } else {
        if (j < i) {
          dels[j] = right              // move right into the write position
        }
        j++
      }
    }
    dels.length = j                    // truncate to compacted length
  })
}
```

**Two-pointer in-place compaction:**

- `i` = read pointer (scans every element)
- `j` = write pointer (tracks where to place the next non-merged result)

When two ranges are adjacent (`left.clock + left.len === right.clock`), merge them by extending `left.len`. The right range is discarded — `j` doesn't advance, so it gets overwritten by the next distinct range.

When ranges are not adjacent, write `dels[i]` at position `j` (if `j < i`, meaning we've already compacted some ranges) and advance `j`.

At the end, `dels.length = j` chops off the now-unused tail.

**Example:**

```
Input (after sort): [{clock:0,len:3}, {clock:3,len:2}, {clock:7,len:1}, {clock:8,len:4}]

i=1: left={0,3}, right={3,2} → adjacent (0+3=3) → extend: {0,5}. j stays at 1.
i=2: left={0,5}, right={7,1} → not adjacent (5≠7) → write {7,1} at j=1. j=2.
i=3: left={7,1}, right={8,4} → adjacent (7+1=8) → extend: {7,5}. j stays at 2.

Result (length=2): [{clock:0,len:5}, {clock:7,len:5}]
```

Four entries compressed to two. **No extra allocation** — the array is modified in place.

---

## Merging Multiple DeleteSets — `mergeDeleteSets`

```javascript
export const mergeDeleteSets = dss => {
  const merged = new DeleteSet()
  for (let dssI = 0; dssI < dss.length; dssI++) {
    dss[dssI].clients.forEach((delsLeft, client) => {
      if (!merged.clients.has(client)) {
        const dels = delsLeft.slice()
        for (let i = dssI + 1; i < dss.length; i++) {
          array.appendTo(dels, dss[i].clients.get(client) || [])
        }
        merged.clients.set(client, dels)
      }
    })
  }
  sortAndMergeDeleteSet(merged)
  return merged
}
```

Merges an array of DeleteSets into one. Used during sync when combining tombstones from multiple sources.

The optimization: when a client is first encountered at `dssI`, collect its deletions from ALL remaining DeleteSets (`dssI+1` onwards) in one pass. The `!merged.clients.has(client)` check ensures this only happens once per client. Then `sortAndMergeDeleteSet` handles compaction.

This avoids processing the same client multiple times across different DeleteSets.

---

## Building from StructStore — `createDeleteSetFromStructStore`

```javascript
export const createDeleteSetFromStructStore = ss => {
  const ds = createDeleteSet()
  ss.clients.forEach((structs, client) => {
    const dsitems = []
    for (let i = 0; i < structs.length; i++) {
      const struct = structs[i]
      if (struct.deleted) {
        const clock = struct.id.clock
        let len = struct.length
        // greedily extend: keep consuming consecutive deleted structs
        if (i + 1 < structs.length) {
          for (
            let next = structs[i + 1];
            i + 1 < structs.length && next.id.clock === clock + len && next.deleted;
            next = structs[++i + 1]
          ) {
            len += next.length
          }
        }
        dsitems.push(new DeleteItem(clock, len))
      }
    }
    if (dsitems.length > 0) ds.clients.set(client, dsitems)
  })
  return ds
}
```

The inverse of applying a DeleteSet — reconstructs ranges from the `deleted` flags on Items.

Since StructStore arrays have no gaps and are sorted by clock, consecutive deleted items can be greedily merged in one pass. The inner `for` loop advances `i` while the next struct is deleted and adjacent — consuming a run of deletions into one `DeleteItem`.

**This is O(n) where n = total structs.** Called when constructing sync messages, not on every operation.

---

## Applying Incoming Deletions — `readAndApplyDeleteSet`

```javascript
export const readAndApplyDeleteSet = (decoder, transaction, store) => {
  const unappliedDS = new DeleteSet()
  const numClients = decoding.readVarUint(decoder)
  for (let i = 0; i < numClients; i++) {
    const client = decoding.readVarUint(decoder)
    const numberOfDeletes = decoding.readVarUint(decoder)
    const structs = store.clients.get(client) || []
    const state = getState(store, client)

    for (let i = 0; i < numberOfDeletes; i++) {
      const clock = decoding.readVarUint(decoder)
      const len = decoding.readVarUint(decoder)

      if (clock < state) {
        // We have at least some of these structs
        if (state < clock + len) {
          // Range extends beyond what we have — buffer the excess
          addToDeleteSet(unappliedDS, createID(client, state), clock + len - state)
        }

        let index = findIndexSS(structs, clock)
        let struct = structs[index]

        // Split at start boundary if needed
        if (!struct.deleted && struct.id.clock < clock) {
          structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock))
          index++
        }

        while (index < structs.length) {
          struct = structs[index++]
          if (struct.id.clock < clock + len) {
            if (!struct.deleted) {
              // ... delete it
            }
          } else {
            break
          }
        }
      } else {
        // We don't have these structs at all — buffer the whole range
        addToDeleteSet(unappliedDS, createID(client, clock), len)
      }
    }
  }
  // unappliedDS will be retried later...
}
```

The causal delivery mechanism for deletions — mirrors `pendingStack` for structs.

Three cases for each incoming deletion range `[clock, clock+len)`:

| Case | Condition | Action |
|---|---|---|
| We have all of it | `clock + len <= state` | Apply immediately — walk structs in range and delete |
| We have part of it | `clock < state < clock + len` | Apply what we have, buffer the rest in `unappliedDS` |
| We have none of it | `clock >= state` | Buffer entire range in `unappliedDS` |

The split at the start boundary: if the first struct in the range starts before `clock`, split it so the deletion applies exactly from `clock` (not from the struct's start). Same `getItemCleanStart` pattern from StructStore.

`unappliedDS` is retried later — the same causal delivery retry pattern as `pendingStack`.

---

## Serialization — `writeDeleteSet` / `readDeleteSet`

```javascript
export const writeDeleteSet = (encoder, ds) => {
  encoding.writeVarUint(encoder, ds.clients.size)      // number of clients
  ds.clients.forEach((dsitems, client) => {
    encoding.writeVarUint(encoder, client)              // clientId
    encoding.writeVarUint(encoder, dsitems.length)     // number of ranges
    for (let i = 0; i < dsitems.length; i++) {
      encoding.writeVarUint(encoder, dsitems[i].clock) // range start
      encoding.writeVarUint(encoder, dsitems[i].len)   // range length
    }
  })
}
```

Extremely compact. Each deletion range = 2 varints (clock + len). No per-item overhead, no type tags. For a user who deleted 1000 characters in one selection: the entire deletion is 2 varints ≈ 2–10 bytes total.

Compare to sending 1000 individual delete operations over the wire — each would need a full op header. Range encoding is the reason YJS's sync messages stay small even after heavy editing.

---

## Theory Mapping

| 2P-Set concept | DeleteSet equivalent |
|---|---|
| `R` set — tombstone store | `DeleteSet.clients: Map<clientId, Array<DeleteItem>>` |
| `e ∈ R` — is element deleted? | `isDeleted(ds, id)` |
| `merge(R_A, R_B) = R_A ∪ R_B` | `mergeDeleteSets([ds_A, ds_B])` |
| Individual tombstone per element | Range `{clock, len}` covering many elements |
| Persistent R set | Ephemeral — reconstructed from `item.deleted` flags |

---

## Key Takeaways

1. **DeleteSet is ephemeral.** The real source of truth is `item.deleted` in StructStore. DeleteSet is computed when needed — not maintained continuously. This is a fundamental difference from our 2P-Set.

2. **Range compression is the major optimization.** Consecutive deletions collapse to one `{clock, len}` entry. Select-all-delete in a 100,000 character document = one `DeleteItem`. Our 2P-Set would need 100,000 entries.

3. **`sortAndMergeDeleteSet` is a two-pointer in-place compaction.** No extra allocation. `i` reads, `j` writes, adjacent ranges are merged by extending `len`. Clean algorithm worth remembering.

4. **`findIndexDS` returns null, `findIndexSS` throws.** Membership testing (DeleteSet) vs guaranteed lookup (StructStore). The error contract differs because the use cases differ.

5. **`readAndApplyDeleteSet` has the same causal delivery pattern as `pendingStack`.** Deletions that target structs not yet received are buffered in `unappliedDS` and retried. Deletions are always applied after structs — you can't delete what you haven't received.

6. **Serialization is just varints.** `writeDeleteSet` encodes each range as 2 variable-length integers. This is why YJS sync messages are compact — deletions compress exceptionally well at the wire level.
