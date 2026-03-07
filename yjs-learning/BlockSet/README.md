# BlockSet.js — Annotated

`src/utils/BlockSet.js` is the network-layer container for structs. Where `IdSet` tracks *ranges* of clock IDs, `BlockSet` holds the actual `Item` and `GC` objects that those IDs represent — as received from the wire or pending integration.

→ [Improvements and open questions](./improvements.md)

---

## Table of Contents

- [What BlockSet Is For](#what-blockset-is-for)
- [The Data Structures](#the-data-structures)
  - [`BlockRange`](#blockrange)
  - [`BlockSet`](#blockset)
- [Serialization](#serialization)
  - [`readBlockSet` — decoding a network update](#readblockset--decoding-a-network-update)
  - [`writeBlockSet` — encoding for the wire](#writeblockset--encoding-for-the-wire)
- [Key Operations](#key-operations)
  - [`toIdSet()` — convert to range index](#toidset--convert-to-range-index)
  - [`exclude()` — remove known ranges](#exclude--remove-known-ranges)
  - [`insertInto()` — merge two BlockSets](#insertinto--merge-two-blocksets)
- [Where BlockSet Fits in the Sync Flow](#where-blockset-fits-in-the-sync-flow)
- [Key Takeaways](#key-takeaways)

---

## What BlockSet Is For

When a YJS provider receives a binary update from the network, the update is decoded into a `BlockSet`. A `BlockSet` is a `Map<clientId, BlockRange>` — for each client, an array of the actual `Item` and `GC` objects decoded from the wire, in clock order, potentially with `Skip` placeholders for gaps.

Before integrating the structs into the `StructStore`, YJS needs to:
1. Figure out what it already has (via `IdSet`)
2. Remove what it already knows about (`exclude()`)
3. Merge updates received from multiple sources (`insertInto()`)
4. Then integrate what's left

`BlockSet` handles steps 2 and 3. It is ephemeral — it lives only during the update-application phase.

---

## The Data Structures

### `BlockRange`

```javascript
class BlockRange {
  constructor(refs) {
    this.i = 0        // read cursor — current position during integration
    this.refs = refs  // Array<Item | GC | Skip>
  }
}
```

A thin wrapper around `Array<Item|GC|Skip>` with a read cursor `i`. The cursor advances as structs are integrated into `StructStore`. This avoids splicing the array during sequential reads.

### `BlockSet`

```javascript
export class BlockSet {
  constructor() {
    this.clients = map.create()  // Map<clientId, BlockRange>
  }
}
```

One `BlockRange` per client. The `BlockRange.refs` array is sorted by clock and may contain `Skip` structs in the gaps (where content is known-missing or already-applied).

---

## Serialization

### `readBlockSet` — decoding a network update

```javascript
export const readBlockSet = (decoder) => {
  const clientRefs = new BlockSet()
  const numOfStateUpdates = decoding.readVarUint(decoder.restDecoder)

  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfBlocks = decoding.readVarUint(decoder.restDecoder)
    const refs = new Array(numberOfBlocks)
    const client = decoder.readClient()
    let clock = decoding.readVarUint(decoder.restDecoder)

    clientRefs.clients.set(client, new BlockRange(refs))

    for (let i = 0; i < numberOfBlocks; i++) {
      const info = decoder.readInfo()
      switch (binary.BITS5 & info) {
        case 0:   // GC block
        case 10:  // Skip block
        default:  // Item with content
      }
    }
  }
  return clientRefs
}
```

The format is:
1. `numOfStateUpdates` — how many clients are in this update
2. For each client: `numberOfBlocks`, `clientId`, `startClock`, then the blocks
3. Each block starts with an `info` byte. The low 5 bits identify the type:
   - `0` → `GC` (garbage-collected range, just clock + length)
   - `10` → `Skip` (gap placeholder, nothing to apply)
   - anything else → `Item` with content (the full YATA item)

**`Skip` blocks:** The comment says `@todo we could reduce the amount of checks by adding Skip block to clientRefs so we know that something is missing.` Skip blocks are decoded but currently don't contribute to pending-struct tracking — the TODO suggests they should.

**Item decoding:** The `info` byte's upper bits encode which optional fields are present:
- `BIT8` → `origin` (left ID) is stored
- `BIT7` → `rightOrigin` (right ID) is stored
- `BIT6` → `parentSub` (Y.Map key) is stored
- `BIT7|BIT8` both 0 → `parent` is a top-level Y type (read from `y.share` by string key)

### `writeBlockSet` — encoding for the wire

```javascript
export const writeBlockSet = (encoder, blocks) => {
  encoding.writeVarUint(encoder.restEncoder, blocks.clients.size)
  array.from(blocks.clients.entries())
    .sort((a, b) => b[0] - a[0])   // higher clientId first
    .forEach(([client, blockrange]) => {
      writeStructs(encoder, blockrange.refs, client, [new IdRange(0, number.MAX_SAFE_INTEGER)])
    })
}
```

Clients are written in **descending clientId order**. The comment is explicit: _"This heavily improves the conflict algorithm."_

Why? YATA's `integrate()` conflict resolution loop scans left to find conflicting items. When items are integrated in descending clientId order, a higher-ID item that should win is already in the list when the lower-ID item tries to find its position. This means `integrate()` can resolve the conflict in a single pass rather than needing to re-examine items.

This is the same determinism reason IdSet uses descending order — both are designed so that identical logical state always produces identical binary.

---

## Key Operations

### `toIdSet()` — convert to range index

```javascript
toIdSet() {
  const inserts = createIdSet()
  this.clients.forEach((ranges, clientid) => {
    let lastClock = 0
    let lastLen = 0
    ranges.refs.forEach(block => {
      if (block instanceof Skip) return   // Skips don't count as content
      if (lastClock + lastLen === block.id.clock) {
        lastLen += block.length            // extend adjacent range
      } else {
        lastLen > 0 && inserts.add(clientid, lastClock, lastLen)
        lastClock = block.id.clock
        lastLen = block.length
      }
    })
    inserts.add(clientid, lastClock, lastLen)
  })
  return inserts
}
```

Converts the actual struct objects into a compact `IdSet` of ranges. Skips are excluded — they represent gaps, not content. Adjacent blocks are coalesced into a single `IdRange` using the same accumulator pattern as `IdRanges.getIds()`.

Used to: compute what this update contains (so you can diff against what the peer already has).

### `exclude()` — remove known ranges

```javascript
exclude(exclude /* IdSet */) {
  const clientids = this.clients.size < exclude.clients.size
    ? this.clients.keys()
    : exclude.clients.keys()

  for (const client of clientids) {
    const range = exclude.clients.get(client)
    const structs = this.clients.get(client)?.refs
    if (range == null || structs == null) return

    const idranges = range.getIds()
    for (let i = 0; i < idranges.length; i++) {
      const range = idranges[i]

      // skip if range is entirely outside this block's extent
      if (range.clock >= lastStruct.id.clock + lastStruct.length) continue
      if (range.clock + range.len <= firstStruct.id.clock) continue

      // find struct boundaries using binary search
      const startIndex = findIndexCleanStart(null, structs, range.clock)
      const endIndex   = findIndexCleanStart(null, structs, range.clock + range.len)

      if (startIndex < endIndex) {
        structs[startIndex] = new Skip(new ID(client, range.clock), range.len)
        if (endIndex - startIndex > 1) {
          structs.splice(startIndex + 1, endIndex - startIndex - 1)
        }
      }
    }
  }
}
```

Given an `IdSet` of ranges you already have, replace the corresponding structs in this `BlockSet` with `Skip` placeholders. This avoids re-integrating content the peer already applied.

Key detail: `findIndexCleanStart` may split a struct at the clock boundary (hence "clean start") — if the excluded range starts in the middle of a merged block, the block is split first so the Skip boundary is exact.

The client iteration picks the **smaller set** to iterate over (saves work when one side has many more clients than the other).

### `insertInto()` — merge two BlockSets

```javascript
insertInto(inserts /* BlockSet */) {
  inserts.clients.forEach((newranges, clientid) => {
    const ranges = this.clients.get(clientid)
    if (ranges == null) {
      this.clients.set(clientid, newranges)  // new client — just add it
      return
    }
    // determine which set has earlier clocks (left) and which has later (right)
    const localIsLeft = ranges.refs[0].id.clock < newranges.refs[0].id.clock
    const leftRanges  = (localIsLeft ? ranges   : newranges).refs
    const rightRanges = (localIsLeft ? newranges : ranges  ).refs
    ...
  })
}
```

Merges `inserts` into `this`. Two cases:

**Case 1 — non-overlapping (gapSize >= 0):**
```javascript
if (gapSize > 0) {
  leftRanges.push(new Skip(new ID(clientid, ...), gapSize))
}
leftRanges.push(...rightRanges)
ranges.refs = leftRanges
```
Left ends before right begins. If there's a gap, insert a `Skip` to fill it. Then append right onto left. O(n) for the spread but no dedup needed.

**Case 2 — overlapping (gapSize < 0):**

The ranges overlap, meaning both `this` and `inserts` have structs covering the same clock region. This happens when the same update was received from multiple peers.

```javascript
let nextExpectedClock = leftRanges[0].id.clock
const result = []

const applyLeft = () => {
  // skip: Skips and already-consumed ops (clock + length <= nextExpectedClock)
  // trim: partial ops that start before nextExpectedClock
  // add:  ops exactly at nextExpectedClock
}
const applyRight = () => { /* same logic for right */ }

for (; li < leftRanges.length && ri < rightRanges.length;) {
  applyLeft()
  applyRight()
  // if next op from either side is in the future, insert a Skip gap
  const gapSize = minNextClock - nextExpectedClock
  if (gapSize > 0) addToResult(new Skip(..., gapSize))
}
// drain remaining left, then right
```

The two-pointer loop walks both arrays simultaneously. `nextExpectedClock` tracks the frontier. Each `applyLeft`/`applyRight` call:
1. Skips past Skips and duplicates (already consumed)
2. Trims a block that partially overlaps the frontier (`sliceStruct`)
3. Adds blocks that exactly start at the frontier

If both sides have a gap at the same position, a `Skip` is inserted. The result is a deduplicated, gap-annotated merged array.

---

## Where BlockSet Fits in the Sync Flow

```
Network (binary update)
  ↓ readBlockSet(decoder)
BlockSet (raw structs per client)
  ↓ exclude(knownIdSet)          ← remove what this peer already has
BlockSet (with Skips for gaps)
  ↓ insertInto(pendingBlockSet)  ← merge with other pending updates
BlockSet (deduplicated, merged)
  ↓ integrate each struct        ← integrate() per Item, StructStore.addStruct per GC
StructStore (persistent)
  ↓ transact() / cleanupTransactions()
'update' event → providers → network
```

`BlockSet` is the staging area between the wire and `StructStore`. It never persists — once structs are integrated, `BlockSet` is discarded.

---

## Key Takeaways

1. **`BlockSet` is the network-layer counterpart to `StructStore`.** StructStore holds the persistent integrated state. BlockSet holds structs in transit — decoded but not yet integrated.

2. **`Skip` is the gap marker.** When content is known-missing or already-applied, the corresponding slots become `Skip` structs. This keeps the array dense while marking holes.

3. **`writeBlockSet` writes higher clientIds first.** This isn't just for determinism — it directly improves YATA conflict resolution by ensuring items are integrated in the order that minimizes re-scanning.

4. **`exclude()` uses `findIndexCleanStart`.** This means it may split existing structs at the boundary of the excluded range. The clean-start invariant is preserved: every range in `refs` starts at an exact clock boundary.

5. **`insertInto()` has two paths.** Non-overlapping ranges → fast concat with optional Skip. Overlapping → two-pointer dedup that advances `nextExpectedClock` and discards duplicates from either side.

6. **`toIdSet()` skips Skips.** The IdSet produced by `toIdSet()` only reflects actual content, not gaps. This is what gets compared against peer state vectors during sync.
