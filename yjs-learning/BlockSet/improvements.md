# BlockSet.js — Improvements, Doubts & Open Questions

→ [Back to BlockSet notes](./README.md)

---

## Doubts and Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | `readBlockSet` decodes `Skip` blocks but the comment says `@todo we could reduce checks by adding Skip to clientRefs so we know something is missing`. What checks would this save? Would Skip-tracking feed into the pending system (`pendingStructs`) for causal delivery? | open |
| 2 | `exclude()` iterates over whichever set is smaller (`this.clients` or `exclude.clients`). But if a client appears in `exclude` but not in `this`, the loop does nothing — `structs == null`. Is this early return correct? What if the exclude covers a range that a later-arriving update will bring? | open |
| 3 | `insertInto()` uses `sliceStruct` to trim a partial op at the frontier. `sliceStruct` presumably splits the Item and updates clock/length. Does this produce a new `Item` object or mutate in place? If a split Item shares a reference with the old BlockSet, could there be aliasing? | open |
| 4 | The two-pointer loop in `insertInto()` uses `minNextClock` from whichever side has the smaller next clock. But if both `lblock` and `rblock` are `undefined` at the loop boundary, `minNextClock` would be `min(0, 0) = 0` which is behind the frontier. Is there an off-by-one in the Skip-gap insertion here? | open |
| 5 | `writeBlockSet` passes `[new IdRange(0, number.MAX_SAFE_INTEGER)]` as the mask to `writeStructs`. This means "write everything". Is there a path where you'd want to write only a subset of structs? Or is the mask always full because `exclude()` has already removed what's not needed? | open |

---

## Spotted Issues

### 1. `@todo` — Skip blocks not tracked in clientRefs

```javascript
case 10: { // Skip Block (nothing to apply)
  // @todo we could reduce the amount of checks by adding Skip block to clientRefs
  //       so we know that something is missing.
  const len = decoding.readVarUint(decoder.restDecoder)
  refs[i] = new Skip(createID(client, clock), len)
  clock += len
  break
}
```

The author acknowledges that Skip blocks should ideally be tracked to inform the pending/causal-delivery system. Currently Skips are decoded into `refs` but not propagated to any pending state. This means YJS may not know it's waiting for content that was explicitly skipped. **Potential contribution** — trace where pending struct detection happens and wire Skip ranges into it.

### 2. Inconsistent set-size heuristic in `exclude()`

```javascript
const clientids = this.clients.size < exclude.clients.size
  ? this.clients.keys()
  : exclude.clients.keys()
```

This picks the smaller set to iterate, but the logic inside the loop does `this.clients.get(client)` — so if iterating over `exclude.clients.keys()`, a client in `exclude` that isn't in `this` causes an early `return`. A `continue` would be more correct (the `return` exits the entire `for` loop, not just the current iteration). This looks like a bug — if the first client in `exclude` isn't in `this`, the loop exits before checking the remaining clients.
