# AbstractType.js — Improvements, Doubts & Open Questions

→ [Back to AbstractType notes](./README.md)

---

## Spotted Issues / Optimizations

### 1. `typeListGet` is O(n) — no binary search

```javascript
export const typeListGet = (type, index) => {
  for (let n = type._start; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) { return n.content.getContent()[index] }
      index -= n.length
    }
  }
}
```

Linear scan every time. For a 100,000-character document, `yarray.get(50000)` scans 50,000 items in the worst case. The `_searchMarker` system in Y.Array places markers every ~500 visible items and uses the closest one as a starting point — reducing this to O(n/500) in practice. But it's not in this base class, and types that don't implement `_searchMarker` (custom types extending AbstractType) get the full O(n) cost.

**Potential contribution:** document the `_searchMarker` pattern more explicitly in the base class, or add a hook so custom types can plug in their own index optimizations.

---

### 2. Typo in JSDoc comments

```javascript
/**
 * Executes a provided function on once on overy element of this YArray.
 */
```

"on once on overy" — appears twice in the file (once in `typeListForEach`, once in `typeListForEachSnapshot`). Should be "once on every". Minor docs contribution.

---

### 3. Y.Map history grows unboundedly until GC

Every `typeMapSet` creates a new Item and the old value becomes the `left` chain. For a key that's written frequently (e.g. a cursor position updated every 100ms), this chain can grow very long. GC can clean it up, but only once no snapshot references the old values.

If an application holds long-lived snapshots (e.g. for undo history), map key history may never be GC'd. Worth documenting explicitly as a potential memory concern for high-frequency map updates.

---

## Doubts and Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | `callTypeObservers` records events in `changedParentTypes` but calls `_eH` (direct observers) immediately. Deep observers (`_dEH`) are fired later when the transaction commits. Who flushes `changedParentTypes` and calls `_dEH`? Is it in the Transaction commit path? | open |
| 2 | `_integrate(y, item)` just sets `doc` and `_item`. The actual work is done by `Item.integrate()` calling `content.integrate()`. Why is `_integrate` on AbstractType so minimal — what was it doing before that it no longer does? | open |
| 3 | `typeListInsertGenerics` splits an item when inserting at a non-boundary index. The split calls `getItemCleanStart` which modifies the StructStore array. If two concurrent inserts both trigger splits of the same item, can they conflict? How is this handled? | open |
| 4 | `typeMapGetSnapshot` walks `v.left` until it finds an item that existed at snapshot time. If many writes happened to the same key, this is O(writes). Is there a case where this becomes a bottleneck (e.g. a cursor-position key updated thousands of times)? | open |
| 5 | The content packing in `typeListInsertGenericsAfter` batches JSON values but each non-JSON type flushes the batch. If you insert `[str, Uint8Array, str, Uint8Array, ...]` alternating, you get many small Items. Is there a smarter batching strategy? | open |
| 6 | `typeListDelete` throws `'array length exceeded'` if `length > 0` after the loop ends. When can this happen — is it a user error (deleting past end) or can it occur from a sync race? | open |
