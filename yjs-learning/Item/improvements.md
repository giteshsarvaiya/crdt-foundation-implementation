# Item.ts — Improvements, Doubts & Open Questions

Spotted while reading `src/structs/Item.ts`. Contribution candidates and things worth investigating.

→ [Back to Item notes](./README.md)

---

## TODOs Left in the Source

### 1. `conflictingItems` — the author's own TODO

**Location:** `integrate()`, Phase 2 setup

```javascript
// TODO: use something like DeleteSet here (a tree implementation would be best)
// @todo use global set definitions
const conflictingItems = new Set()
const itemsBeforeOrigin = new Set()
```

Two TODOs stacked on each other in the same spot.

**What it means:**

Every time `integrate()` runs, two `Set` objects are allocated on the heap. In a document with heavy concurrent editing (many simultaneous users, many ops), this is called extremely frequently — once per incoming operation.

The author is noting that:
- A tree-backed structure (like the DeleteSet's interval tree) would be more efficient for checking membership
- These sets could potentially be shared/pooled globally instead of freshly allocated per call

**Potential contribution:** Profile whether `Set` allocation is actually a bottleneck in high-concurrency scenarios. If yes, explore a pool-based or reuse-based approach. The `@todo use global set definitions` hint suggests the author already had a specific approach in mind — worth checking the issue tracker.

---

## Doubts and Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | `getMissing` returns a `clientId` when a dependency is missing — where does the caller put the pending item? How is the pending queue managed? | open |
| 2 | In `gc()`, what determines whether `parentGCd` is true or false? Who decides the parent is fully GC'd? | open |
| 3 | `store.skips.hasId(this.origin)` — what is `skips`? When does an ID get added to skips vs the normal store? | open |
| 4 | `followRedone` has a `diff` variable for split items. If an item was split AND redone, the redone pointer was set before the split — does the diff correctly account for this? | open |
| 5 | `mergeWith` is called during transaction cleanup. Is there a scenario where two items that should be mergeable are NOT merged because the transaction cleanup runs in the wrong order? | open |
| 6 | The `marker` bit (BIT4) is described as a "fast-search marker." How does the binary search use this? Where is the search-marker system defined? | open |
| 7 | In `integrate()` Phase 4, when `this.right === null && parentSub !== null`, the new item deletes its left neighbor (LWW). What happens if `this.left` is also `null`? Is this the first write to a map key? | open |

---

## Spotted Optimizations

### 2. `lastId` allocation comment

```javascript
get lastId() {
  // allocating ids is pretty costly because of the amount of ids created, so we try to reuse whenever possible
  return this.length === 1 ? this.id : createID(this.id.client, this.id.clock + this.length - 1)
}
```

For single-character items (the common case after splitting), `lastId` returns the existing `id` object instead of allocating a new one. Small but shows the level of allocation pressure in YJS — worth keeping in mind when adding any code that calls `lastId` in a loop.

### 3. `write()` — info byte encodes field presence

```javascript
const info = (this.content.getRef() & binary.BITS5) |
  (origin === null ? 0 : binary.BIT8) |
  (rightOrigin === null ? 0 : binary.BIT7) |
  (parentSub === null ? 0 : binary.BIT6)
```

The serialization format skips writing `origin`, `rightOrigin`, and `parentSub` entirely when they're null — encoding their presence/absence as bits in a single info byte. This is why YJS's binary format is compact: fields that don't exist don't take space.

**Implication for contributions:** any new field added to Item must be reflected in this info byte scheme, which has limited bits available (5 bits for content type ref, 3 bits for field presence = 8 bits = 1 byte). Adding fields may require a format version bump.
