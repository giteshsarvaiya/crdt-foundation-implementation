# DeleteSet.js — Improvements, Doubts & Open Questions

→ [Back to DeleteSet notes](./README.md)

---

## Spotted Inconsistencies

### 1. `findIndexDS` has no pivot optimization, `findIndexSS` does

`findIndexSS` in StructStore uses a proportional first-guess pivot. `findIndexDS` here uses plain binary search. Both operate on sorted arrays with range-aware comparison. If the pivot is worth having in StructStore, it might be worth having here too — or the TODO in `findIndexSS` questioning the pivot suggests neither should have it.

**Potential contribution:** benchmark both with real workloads. Either add the pivot to `findIndexDS` for consistency, or remove it from `findIndexSS` with data showing it doesn't help.

---

## Doubts and Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | `readAndApplyDeleteSet` was cut off in our paste. What happens to `unappliedDS` after the function returns — where is it stored and when is it retried? Is it attached to the transaction or the store? | open |
| 2 | `createDeleteSetFromStructStore` is O(n) over all structs. For very large documents, when is this called? If called on every sync message, is it a bottleneck? | open |
| 3 | `sortAndMergeDeleteSet` only merges **adjacent** ranges (`left.clock + left.len === right.clock`). What about overlapping ranges? Can two DeleteItems overlap? Is overlap prevented at the `addToDeleteSet` call sites, or could a bug produce overlapping ranges that `sortAndMergeDeleteSet` doesn't handle? | open |
| 4 | `mergeDeleteSets` iterates `dss` twice (outer loop + inner append). For many DeleteSets, is this O(n * m) where n = clients and m = number of sets? Could it be done in one pass? | open |
| 5 | The `unappliedDS` in `readAndApplyDeleteSet` handles deletions targeting structs not yet received. But what if those structs NEVER arrive (peer permanently offline)? Does `unappliedDS` get cleaned up or does it stay in memory indefinitely? | open |
| 6 | `isDeleted` takes a full `DeleteSet` object. But during normal document operation, deletions are tracked per-transaction and the persistent record is `item.deleted`. Is there a scenario where `isDeleted` returns false but the item is actually deleted (because the DeleteSet being checked is stale)? | open |
