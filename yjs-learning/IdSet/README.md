# IdSet.js — Annotated

`src/utils/IdSet.js` is the replacement for `DeleteSet.js`. It is far more capable — a general-purpose range set with set-difference, intersection, slicing, and lazy sort. It is now used for both deletions AND insertions (the Transaction has both a `deleteSet` and an `insertSet`, both are `IdSet`).

→ [Improvements and open questions](./improvements.md)

---

## Table of Contents

- [What Changed from DeleteSet](#what-changed-from-deleteset)
- [The Data Structures](#the-data-structures)
  - [`IdRange`](#idrange)
  - [`IdRanges` — the Lazy-Sort Wrapper](#idranges--the-lazy-sort-wrapper)
  - [`IdSet`](#idset)
- [Key Operations](#key-operations)
  - [`getIds()` — lazy sort and merge](#getids--lazy-sort-and-merge)
  - [`_deleteRangeFromIdSet` — range deletion](#_deleterangefromidset--range-deletion)
  - [`_diffSet` — set difference](#_diffset--set-difference)
  - [`_intersectSets` — set intersection](#_intersectsets--set-intersection)
  - [`slice()` — partial membership](#slice--partial-membership)
- [Serialization Changes](#serialization-changes)
- [Theory Mapping](#theory-mapping)
- [Key Takeaways](#key-takeaways)

---

## What Changed from DeleteSet

| Old (`DeleteSet.js`) | New (`IdSet.js`) |
|---|---|
| `DeleteItem { clock, len }` | `IdRange { clock, len }` + `copyWith()` method |
| `Array<DeleteItem>` per client | `IdRanges` wrapper class with lazy sort |
| `DeleteSet` | `IdSet` — much more capable |
| `sortAndMergeDeleteSet` — imperative | `IdRanges.getIds()` — lazy, cached |
| `mergeDeleteSets` | `mergeIdSets` |
| Only used for deletions | Used for deletions AND insertions |
| No set operations | `diffIdSet`, `intersectSets`, `slice()` |
| Sorted eagerly | Sorted lazily on first `getIds()` call |

The biggest conceptual change: **IdSet is now a general-purpose range set**, not a deletion-specific structure. The same class tracks what was inserted (`transaction.insertSet`) and what was deleted (`transaction.deleteSet`).

---

## The Data Structures

### `IdRange`

```javascript
class IdRange {
  constructor(clock, len) {
    this.clock = clock
    this.len = len
  }
  copyWith(clock, len) { return new IdRange(clock, len) }
  get attrs() { return [] }  // compatibility with IdMap
}
```

Same concept as `DeleteItem` — a range `[clock, clock+len)`. Added:
- `copyWith()` — create a modified copy without mutating the original. Used by `_deleteRangeFromIdSet` and `_diffSet` when trimming range boundaries.
- `attrs` getter — makes `IdRange` compatible with `IdMap` (which stores attributes per range). Returns empty array for plain ranges.

### `IdRanges` — the Lazy-Sort Wrapper

```javascript
class IdRanges {
  constructor(ids) {
    this.sorted = false
    this._lastIsUsed = false
    this._ids = ids
  }
}
```

Wraps `Array<IdRange>` with two optimizations:

**`_lastIsUsed` — mutation guard:**
```javascript
add(clock, length) {
  const last = this._ids[this._ids.length - 1]
  if (last != null && last.clock + last.len === clock) {
    if (this._lastIsUsed) {
      this._ids[this._ids.length - 1] = new IdRange(last.clock, last.len + length)
      this._lastIsUsed = false
    } else {
      this._ids[this._ids.length - 1].len += length  // in-place extend
    }
  } else {
    this._ids.push(new IdRange(clock, length))
  }
}
```

When you call `add()` and the new range is adjacent to the last one, extend it in-place (O(1), no allocation). But if `_lastIsUsed` is true (meaning the last range was exposed via `getIds()` and might be referenced externally), create a new `IdRange` object instead of mutating the shared one.

**Lazy sort — `getIds()`:**
```javascript
getIds() {
  const ids = this._ids
  this._lastIsUsed = true     // mark last as exposed
  if (!this.sorted) {
    this.sorted = true
    ids.sort((a, b) => a.clock - b.clock)
    // two-pointer in-place merge (same algorithm as old sortAndMergeDeleteSet)
    // handles OVERLAPPING ranges too (not just adjacent)
    ...
  }
  return ids
}
```

Sorting and merging happen only on first `getIds()` call, then cached via `this.sorted = true`. This is important because `add()` calls come in during transaction execution (potentially many), but sorting only needs to happen once at read time.

**Overlap handling:** the new merge algorithm handles overlapping ranges (not just adjacent):
```javascript
if (left.clock + left.len >= right.clock) {   // overlap OR adjacent
  const r = right.clock + right.len - left.clock
  if (left.len < r) {
    ids[j - 1] = new IdRange(left.clock, r)   // extend to cover both
  }
}
```

The old `sortAndMergeDeleteSet` only merged adjacent ranges. This version handles cases where ranges overlap (e.g. if two delete operations covered overlapping clock ranges).

### `IdSet`

```javascript
class IdSet {
  constructor() {
    this.clients = new Map()  // Map<clientId, IdRanges>
  }
  hasId(id) { ... }
  has(client, clock) { ... }
  add(client, clock, len) { ... }
  delete(client, clock, len) { ... }
  slice(client, clock, len) { ... }
  forEach(f) { ... }
  isEmpty() { ... }
}
```

Full set API. Not just "add and check" — you can remove specific ranges, take diffs, intersections.

---

## Key Operations

### `getIds()` — lazy sort and merge

Already covered above. Call this whenever you need a stable, sorted, merged view of the ranges. Never access `._ids` directly.

### `_deleteRangeFromIdSet` — range deletion

```javascript
export const _deleteRangeFromIdSet = (set, client, clock, len) => {
  const dr = set.clients.get(client)
  if (dr && len > 0) {
    const ids = dr.getIds()
    let index = findRangeStartInIdRanges(ids, clock)
    if (index != null) {
      for (let r = ids[index]; index < ids.length && r.clock < clock + len; r = ids[++index]) {
        if (r.clock < clock) {
          // range starts before delete zone — trim start
          ids[index] = r.copyWith(r.clock, clock - r.clock)
          if (clock + len < r.clock + r.len) {
            // delete zone is entirely within range — split
            ids.splice(index + 1, 0, r.copyWith(clock + len, r.clock + r.len - clock - len))
          }
        } else if (clock + len < r.clock + r.len) {
          // range ends after delete zone — trim end
          ids[index] = r.copyWith(clock + len, r.clock + r.len - clock - len)
        } else {
          // range entirely within delete zone — remove
          ids.splice(index--, 1)
        }
      }
    }
  }
}
```

Used by `IdSet.delete()`. Complex because removing a range from the middle of an existing range requires splitting it into two. Three cases:
1. Range starts before delete zone → trim the start
2. Range ends after delete zone → trim the end
3. Range entirely within delete zone → remove it entirely
4. Delete zone entirely within range → split into two ranges

### `_diffSet` — set difference

```javascript
export const _diffSet = (set, exclude) => {
  // Returns: all ranges in 'set' that are NOT in 'exclude'
  // Two-pointer walk over sorted ranges from both sets
  // Non-overlapping → keep
  // Overlapping → split/trim around the excluded region
}
```

New capability not in old DeleteSet. Used to compute "what do I need to send you" — the diff between my state and yours.

### `_intersectSets` — set intersection

```javascript
export const _intersectSets = (setA, setB) => {
  // Returns: only ranges that exist in BOTH sets
  // Two-pointer walk, collect overlapping regions
}
```

Also new. The overlap computation:
```javascript
const clock = math.max(aRange.clock, bRange.clock)  // start of overlap
const len = math.min(
  aRange.len - (clock - aRange.clock),              // how much of A is left
  bRange.len - (clock - bRange.clock)               // how much of B is left
)
```

### `slice()` — partial membership

```javascript
slice(client, clock, len) {
  // Returns Array<MaybeIdRange>
  // Each entry says: this sub-range exists (true) or doesn't (false) in the set
}
```

New capability. Given a range `[clock, clock+len)`, returns a description of which sub-ranges exist in the set and which don't. Used for partial sync — "I have clocks 5-10, which of those do you need?"

```
IdSet contains: [3,6) and [8,12)
slice(client, 4, 8):  → [4,6) exists, [6,8) missing, [8,12) exists
```

---

## Serialization Changes

```javascript
export const writeIdSet = (encoder, idSet) => {
  encoding.writeVarUint(encoder.restEncoder, idSet.clients.size)
  array.from(idSet.clients.entries())
    .sort((a, b) => b[0] - a[0])  // deterministic order: higher clientId first
    .forEach(([client, _idRanges]) => {
      const idRanges = _idRanges.getIds()
      encoder.resetIdSetCurVal()
      encoding.writeVarUint(encoder.restEncoder, client)
      ...
    })
}
```

Key change from old `writeDeleteSet`: **deterministic ordering**. Clients are written in descending clientId order. This ensures two replicas producing the same IdSet always produce identical binary output — important for content-addressed caching and update deduplication.

The `encoder.resetIdSetCurVal()` + `encoder.writeIdSetClock()` / `encoder.writeIdSetLen()` pattern suggests the V2 encoder uses delta-encoding within a client's ranges (clocks relative to previous entry), producing smaller binary output.

---

## Theory Mapping

| 2P-Set / DeleteSet concept | IdSet equivalent |
|---|---|
| `R` set | `IdSet` — but now used for inserts too |
| `e ∈ R` | `idSet.has(client, clock)` |
| `merge(R_A, R_B)` | `mergeIdSets([a, b])` |
| Range compression | `IdRanges.getIds()` with lazy merge |
| — | `diffIdSet` — new: what A has that B doesn't |
| — | `intersectSets` — new: what both have |
| — | `slice()` — new: partial membership |

---

## Key Takeaways

1. **IdSet replaced DeleteSet and is now used for both deletions and insertions.** `transaction.deleteSet` and `transaction.insertSet` are both IdSets. The name reflects the generalization.

2. **Lazy sort via `getIds()`.** Ranges accumulate during a transaction unsorted, sorted once at read time, cached. Don't access `._ids` directly.

3. **`_lastIsUsed` prevents mutation bugs.** When the last range is exposed externally, `add()` creates a new object instead of mutating the shared one.

4. **Overlap handling is new.** Old `sortAndMergeDeleteSet` only merged adjacent ranges. `IdRanges.getIds()` handles overlaps too.

5. **Set difference and intersection are new capabilities.** These enable more sophisticated sync protocols — compute exactly what a peer is missing, send only that.

6. **Deterministic serialization order.** Writing clients in descending clientId order ensures identical binary output for identical logical content.
