# Transaction.js — Improvements, Doubts & Open Questions

→ [Back to Transaction notes](./README.md)

---

## Doubts and Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | `cleanupTransactions` is recursive. If observers keep creating new transactions indefinitely, is there a stack overflow risk? Is there a depth limit? | open |
| 2 | `callAll(fs, [])` calls all observer functions even if one throws. The error is swallowed? Or re-thrown after all are called? | open |
| 3 | `beforeState` and `afterState` are deprecated but still exist as getters. What replaced them for providers that need to know what changed? Is `insertSet` + `deleteSet` the replacement? | open |
| 4 | `cleanupYTextAfterTransaction` runs in a new transaction. That new transaction also goes through `cleanupTransactions`. If that cleanup transaction also modifies formatting, does it recursively trigger more cleanup? Is there a termination guarantee? | open |
| 5 | The update blob is encoded inside `cleanupTransactions` after GC. Does this mean the blob never contains content that was GC'd in the same transaction? Or can GC and content encoding race? | open |

---

## Spotted Issues

### 1. TODO about mergeStructs ordering

```javascript
// @todo: it makes more sense to transform mergeStructs to a DS, sort it,
//        and merge from right to left
//        but at the moment DS does not handle duplicates
for (let i = mergeStructs.length - 1; i >= 0; i--) {
```

The author acknowledges the current `_mergeStructs` handling is suboptimal. It iterates in reverse (good) but doesn't first convert to a sorted unique set (which would be more efficient). Since `IdSet` now exists, this TODO may be actionable. **Potential contribution.**
