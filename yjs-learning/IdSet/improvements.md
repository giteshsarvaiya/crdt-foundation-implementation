# IdSet.js — Improvements, Doubts & Open Questions

→ [Back to IdSet notes](./README.md)

---

## Doubts and Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | `_lastIsUsed` prevents mutation of exposed ranges. But `getIds()` sets `_lastIsUsed = true` every call. If `add()` is called after `getIds()`, it always allocates a new IdRange. Is there a case where this causes unexpected allocations in a hot path? | open |
| 2 | `_diffSet` has a `@todo rename to excludeIdSet` comment. What's blocking the rename — breaking API compatibility? | open |
| 3 | `slice()` returns `Array<MaybeIdRange>`. Who uses this? It's a relatively complex API — where in the sync protocol is partial membership queried? | open |
| 4 | `findRangeStartInIdRanges` vs `findIndexInIdRanges`: the former finds the first range that contains or comes AFTER clock, the latter finds only ranges that contain clock. `_deleteRangeFromIdSet` uses `findRangeStartInIdRanges`. Is there a risk of off-by-one if the deletion starts in a gap between ranges? | open |

---

## Spotted Issues

### 1. `@todo rename to excludeIdSet | excludeIdMap`

```javascript
/**
 * @todo rename to excludeIdSet | excludeIdMap
 */
export const _diffSet = (set, exclude) => { ... }
```

The author wants to rename `_diffSet` but hasn't. The underscore prefix suggests it's considered internal. The rename would make the intent clearer. Minor contribution — requires checking all call sites.
