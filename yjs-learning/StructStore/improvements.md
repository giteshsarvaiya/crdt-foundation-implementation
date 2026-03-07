# StructStore.js — Improvements, Doubts & Open Questions

→ [Back to StructStore notes](./README.md)

---

## Refactor Changes (current main branch)

The original annotation covers the v1 architecture. The refactored `StructStore.js` has these notable changes:

| Change | Original | Refactored |
|--------|----------|------------|
| Skip struct support | `addStruct` throws on any gap | `addStruct` now accepts `Skip` structs to fill gaps explicitly |
| `skips` field | Not present | `StructStore` has a `skips: IdSet` field — tracks ranges occupied by Skip placeholders |
| Pending system | Three separate pending structures (`pendingClientsStructRefs`, `pendingStack`, etc.) | Simplified to `pendingStructs: BlockSet \| null` and `pendingDs: IdSet \| null` |
| Typo | `integretyCheck` | `integrityCheck` (fixed) |

**What this means:** The refactor integrates `BlockSet` and `IdSet` into the store itself. When a struct arrives out of order, instead of juggling three pending maps, the store just holds a `pendingStructs` `BlockSet` (the raw structs) and a `pendingDs` `IdSet` (pending deletes). Much simpler to reason about.

---

## TODOs Left in the Source

### 1. Pivot optimization — uncertain benefit

**Location:** `findIndexSS`

```javascript
// @todo does it even make sense to pivot the search?
// If a good split misses, it might actually increase the time to find the correct item.
// Currently, the only advantage is that search with pivoting might find the item on the first try.
```

The proportional first-guess optimization is unverified. The author left this TODO acknowledging it might not actually help — if clock values aren't uniformly distributed, the pivot could be far off and add an extra iteration vs plain binary search.

**Potential contribution:** benchmark `findIndexSS` with real document workloads (burst edits, uniform edits, multi-user concurrent) to determine whether the pivot reliably helps or should be removed.

---

## Bugs / Issues

### 2. Typo in `integretyCheck` — **fixed in refactor**

```javascript
export const integretyCheck = store => { ... }  // original
export const integrityCheck = store => { ... }  // refactored (typo fixed)
```

"integrety" → "integrity". Fixed in the current main branch. The rename was not breaking because it's an internal utility. Serves as confirmation that small typo fixes in public exports are accepted contributions.

---

## Doubts and Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | `pendingClientsStructRefs` uses an `i` index to avoid array shifting. Who resets or cleans up this map after all pending refs for a client are processed? Is there a memory leak if a client goes permanently offline mid-update? | open |
| 2 | `pendingStack` is described as having "maximum length of structReaders.size" — how is this bound enforced? What happens if a struct's dependency never arrives (offline peer)? Does the stack grow unboundedly? | open |
| 3 | `addStruct` throws if there's a gap. But `pendingClientsStructRefs` buffers out-of-order arrivals. Who is responsible for ensuring structs are fed to `addStruct` in order — is it `tryResumePendingStructRefs` (not in this file)? | open |
| 4 | `iterateStructs` code was cut off in the paste — what does the full loop body do? Does it handle the case where a struct spans the end boundary `clockEnd`? | open |
| 5 | `replaceStruct` does an in-place array replacement. If two concurrent GC operations target overlapping ranges, could they race and corrupt the array? | open |
| 6 | `getItemCleanStart` and `getItemCleanEnd` both call `structs.splice()` — O(n) operation. For very long documents with many splits, could this become a performance bottleneck? | open |
