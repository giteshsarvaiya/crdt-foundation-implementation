# Item.ts — Annotated

`src/structs/Item.ts` is the heart of YJS. Every character you type, every object you insert, every deletion — all of it is an `Item`. This file contains the YATA algorithm (`integrate()`), the GC system, undo/redo wiring, and the binary serialization format.

→ [Improvements and open questions](./improvements.md)

---

## Table of Contents

- [What an Item is](#what-an-item-is)
- [The Fields](#the-fields)
- [The `info` Bitmask](#the-info-bitmask)
- [The YATA Algorithm — `integrate()`](#the-yata-algorithm--integrate)
  - [Phase 0 — Offset handling](#phase-0--offset-handling)
  - [Phase 1 — Find the correct position](#phase-1--find-the-correct-position)
  - [Phase 2 — The conflict resolution loop](#phase-2--the-conflict-resolution-loop)
  - [Phase 3 — Splice into the linked list](#phase-3--splice-into-the-linked-list)
  - [Phase 4 — Y.Map LWW](#phase-4--ymap-lww)
- [Supporting Functions](#supporting-functions)
  - [`splitItem`](#splititem)
  - [`mergeWith`](#mergewith)
  - [`getMissing` — Causal Delivery](#getmissing--causal-delivery)
  - [`delete`](#delete)
  - [`gc`](#gc)
  - [`followRedone` — Undo/Redo](#followredone--undoredo)

---

## What an Item is

In our CRDT implementations:
- **OR-Set** stores elements as `(value, unique-tag)` pairs
- **Op-OR-Set** broadcasts `{tag, value}` operations and applies them downstream

An `Item` is exactly that — but for a sequence (text, array). It is:

```
{client, clock}     ← the unique tag (OR-Set)
content             ← the atom (character, object, XML node, etc.)
left / right        ← linked list pointers (RGA linked list)
origin / rightOrigin ← the two neighbors at insert time (YATA's addition over RGA)
deleted             ← tombstone flag (stays in list as position anchor)
```

Every character you type in a YJS-backed editor becomes one Item (or gets merged into a nearby Item for efficiency — see `mergeWith`).

---

## The Fields

```javascript
constructor(id, left, origin, right, rightOrigin, parent, parentSub, content)
```

| Field | Type | What it is |
|---|---|---|
| `id` | `{client, clock}` | The unique tag. `client` = replica ID, `clock` = Lamport clock. This IS the OR-Set tag. |
| `origin` | `ID \| null` | ID of the item that was to the LEFT at the moment this was inserted. YATA's leftOrigin. |
| `left` | `Item \| null` | Current left neighbor in the linked list. May differ from origin after other items are integrated. |
| `right` | `Item \| null` | Current right neighbor. |
| `rightOrigin` | `ID \| null` | ID of the item that was to the RIGHT at insert time. YATA's addition over RGA — used to detect interleaving. |
| `parent` | `YType \| ID \| string \| null` | The shared type this item belongs to (Y.Text, Y.Array, Y.Map, etc.). |
| `parentSub` | `string \| null` | For Y.Map: the key name. For Y.Text / Y.Array: null. This is how one linked list per map key works. |
| `redone` | `ID \| null` | Points to the Item that "redid" this one. Undo/redo wiring. |
| `content` | `AbstractContent` | The actual data — text, binary, JSON, another YType, etc. |
| `info` | `number` (byte) | Bitmask packing 4 booleans into one byte. See below. |

**The origin / left distinction is critical:**

`origin` is **frozen at insert time** — it's the ID of the left neighbor as seen by the inserting replica. It never changes.

`left` is **updated during integration** — as other concurrent items are inserted and the algorithm finds the correct position, `left` gets adjusted to point to the actual current left neighbor.

This is the same pattern as our Op-OR-Set: the op captures what was observed at source, then downstream applies it relative to current state.

---

## The `info` Bitmask

Instead of 4 separate boolean fields, YJS packs them into one byte:

```
bit1 (BIT1) → keep      — do not garbage collect this Item
bit2 (BIT2) → countable — included in length calculations (e.g. text length)
bit3 (BIT3) → deleted   — tombstone flag
bit4 (BIT4) → marker    — fast-search marker for binary search optimization
```

```javascript
get deleted() { return (this.info & binary.BIT3) > 0 }
set deleted(doDelete) { if (this.deleted !== doDelete) this.info ^= binary.BIT3 }
markDeleted() { this.info |= binary.BIT3 }
```

Why? YJS creates enormous numbers of Items (one per character in a collaborative document). Every byte of memory per Item multiplies by millions of items. Packing 4 booleans into 1 byte saves 3 bytes per Item — significant at scale.

---

## The YATA Algorithm — `integrate()`

This is the entire CRDT algorithm in one method. When a new Item arrives (either locally or from a remote replica), `integrate()` is called to insert it into the linked list at the correct position.

```javascript
integrate(transaction, offset) { ... }
```

### Phase 0 — Offset Handling

```javascript
if (offset > 0) {
  this.id.clock += offset
  this.left = getItemCleanEnd(transaction, store, createID(this.id.client, this.id.clock - 1))
  this.origin = this.left.lastId
  this.content = this.content.splice(offset)
  this.length -= offset
}
```

YJS merges consecutive characters from the same client into one Item for efficiency. If you type "hello", instead of 5 Items you might get one Item with content `"hello"` and length 5.

When another replica inserts in the middle of that merged Item (say, between 'h' and 'e'), the Item must be **split** first. The `offset` parameter says how far into the Item this new insert should go. This block adjusts `id`, `origin`, and `content` to refer to the correct split point.

If `offset = 0` (the common case — inserting at a clean boundary), this block is skipped entirely.

### Phase 1 — Find the correct position

```javascript
if ((!this.left && (!this.right || this.right.left !== null)) ||
    (this.left && this.left.right !== this.right)) {
  let left = this.left
  let o

  if (left !== null) {
    o = left.right
  } else if (this.parentSub !== null) {
    o = parent._map.get(this.parentSub) || null
    while (o !== null && o.left !== null) { o = o.left }
  } else {
    o = parent._start
  }
```

The condition checks: "is the position I think I should be in still valid?" If `this.left.right !== this.right`, other items have been inserted between my expected left and right neighbors since I was created. The linked list has changed. We need to find the correct insertion point.

`o` is set to the **first item that might conflict with us** — the first candidate we need to compare against. We start scanning from there.

Three cases for where to start scanning:
- `left !== null` → start from `left.right` (right after our last-known left neighbor)
- `parentSub !== null` → Y.Map mode: find the leftmost item for this key
- else → start from the beginning of the sequence (`parent._start`)

### Phase 2 — The Conflict Resolution Loop

This is YATA. It finds the correct position among all concurrent insertions at the same logical location.

```javascript
const conflictingItems = new Set()
const itemsBeforeOrigin = new Set()

while (o !== null && o !== this.right) {
  itemsBeforeOrigin.add(o)
  conflictingItems.add(o)

  if (compareIDs(this.origin, o.origin)) {
    // CASE 1: same left origin
    if (o.id.client < this.id.client) {
      left = o               // o goes before us — update left, clear conflicts
      conflictingItems.clear()
    } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {
      // same left AND right origin — direct tie. We go before o.
      break
    }
    // else: o might belong before something we haven't seen yet. Keep scanning.

  } else if (o.origin !== null && itemsBeforeOrigin.has(getItem(store, o.origin))) {
    // CASE 2: o's origin is between our origin and current position
    if (!conflictingItems.has(getItem(store, o.origin))) {
      left = o               // o started from outside our conflict zone — it goes before us
      conflictingItems.clear()
    }
    // else: o is inside our conflict zone — keep going

  } else {
    break  // o is clearly to our right — stop
  }

  o = o.right
}
```

**The two sets:**
- `itemsBeforeOrigin` — every item we've scanned so far
- `conflictingItems` — items that are competing with us for this position (subset of above)

Every time we determine an item `o` clearly goes before us, we set `left = o` and **clear `conflictingItems`** — because items that conflict with `o` are no longer conflicting with us.

**Case 1 — same left origin** (both `this` and `o` were inserted after the same item):

This is the core YATA tiebreaker. Two concurrent inserts at the same position.

- If `o.id.client < this.id.client` → lower client ID goes first (to the left). `o` wins, `left = o`.
- If also same `rightOrigin` → this is a direct conflict with no ambiguity. We go before `o`. Break.
- Otherwise → `o` might be part of a group that will be resolved further right. Keep scanning.

**Case 2 — o's origin is somewhere between our origin and current position:**

`o` was inserted after something that's between our left anchor and the current scan position. This is the interleaving scenario YATA prevents.

- If `o`'s origin is **outside our conflict zone** (not in `conflictingItems`) → `o` belongs to a different "group" that started before our conflict. It goes before us. `left = o`.
- If `o`'s origin is **inside our conflict zone** → `o` is interleaved within our group. Keep going.

**The else: break** — `o` has an origin that's entirely to the right of our scan zone. `o` clearly belongs after us. Stop scanning.

**YATA vs RGA:**

RGA's loop only handles Case 1 (same left origin, compare timestamps). It has no Case 2.

Case 2 is what prevents interleaving. Without it: if A types "AA" and B types "BB" at the same position, RGA might interleave them as "BABA". With Case 2: "BB" and "AA" stay grouped because the second character of each sequence is "inside the conflict zone" of the first, not a new independent conflict.

### Phase 3 — Splice into the linked list

```javascript
if (this.left !== null) {
  const right = this.left.right
  this.right = right
  this.left.right = this
} else {
  let r
  if (this.parentSub !== null) {
    r = parent._map.get(this.parentSub) || null
    while (r !== null && r.left !== null) { r = r.left }
  } else {
    r = parent._start
    parent._start = this
  }
  this.right = r
}

if (this.right !== null) {
  this.right.left = this
}
```

Standard doubly-linked list insertion. Once the correct `left` is known from Phase 2, splice `this` between `left` and `left.right`. Update all four pointers.

### Phase 4 — Y.Map LWW

```javascript
} else if (this.parentSub !== null) {
  // set as current parent value if right === null and this is parentSub
  parent._map.set(this.parentSub, this)
  if (this.left !== null) {
    this.left.delete(transaction)  // LWW: new item wins, delete the old value
  }
}
```

When `this.right === null` AND `parentSub !== null` — this is a Y.Map insert, and this item is the **rightmost** (most recent) value for a key. That means it wins.

The old value (`this.left`) gets deleted immediately. This is Last-Write-Wins for map keys: the item with the highest Lamport clock ends up as `right = null` (rightmost), and it deletes everything to its left for the same key.

This is exactly our LWW-Register's tiebreaker logic — higher clock wins, and the loser is discarded — but implemented inside the linked list.

---

## Supporting Functions

### `splitItem`

```javascript
export const splitItem = (transaction, leftItem, diff) => { ... }
```

Splits one Item into two at position `diff`. Used when a concurrent insert targets the middle of a merged Item.

Example: Item "hello" (length 5, clock 0–4). Someone inserts after clock 2. Split into "hel" (clock 0–2) and "lo" (clock 3–4), then insert between them.

Key detail: the right half inherits all the left half's metadata (`deleted`, `keep`, `redone`) and gets pushed into `transaction._mergeStructs` so it can be re-merged later if adjacent items are compatible.

### `mergeWith`

```javascript
mergeWith(right) {
  if (
    this.constructor === right.constructor &&
    compareIDs(right.origin, this.lastId) &&    // right's origin IS this item's last ID
    this.right === right &&                      // they are actually adjacent
    compareIDs(this.rightOrigin, right.rightOrigin) &&
    this.id.client === right.id.client &&        // same client
    this.id.clock + this.length === right.id.clock && // consecutive clocks
    this.deleted === right.deleted &&
    this.redone === null && right.redone === null &&
    this.content.constructor === right.content.constructor &&
    this.content.mergeWith(right.content)
  ) { ... return true }
  return false
}
```

The inverse of `splitItem`. Two adjacent Items from the same client with consecutive clocks get merged into one. This is a pure memory/performance optimization — no semantic change.

All conditions must hold. The strictest is `this.id.client === right.id.client` — you can only merge your own consecutive operations. You can never merge items from two different replicas.

### `getMissing` — Causal Delivery

```javascript
getMissing(transaction, store) {
  if (this.origin && (this.origin.clock >= getState(store, this.origin.client) || store.skips.hasId(this.origin))) {
    return this.origin.client  // waiting for left neighbor
  }
  if (this.rightOrigin && (this.rightOrigin.clock >= getState(store, this.rightOrigin.client) || store.skips.hasId(this.rightOrigin))) {
    return this.rightOrigin.client  // waiting for right neighbor
  }
  if (this.parent && this.parent.constructor === ID && ...) {
    return this.parent.client  // waiting for parent container
  }
  // all dependencies present — resolve references and return null
  ...
  return null
}
```

This is the **causal delivery mechanism** from the paper. Before an Item can be integrated, all Items it references must already exist in the store:
- `origin` (left neighbor at insert time) must exist
- `rightOrigin` (right neighbor at insert time) must exist
- `parent` (the containing type) must exist

If anything is missing, `getMissing` returns the client ID we're waiting for. The transaction holds this Item in a pending queue until that client's ops arrive. This is exactly the downstream precondition from our Op-OR-Set: "add must be delivered before remove."

### `delete`

```javascript
delete(transaction) {
  if (!this.deleted) {
    const parent = this.parent
    if (this.countable && this.parentSub === null) {
      parent._length -= this.length   // adjust sequence length
    }
    this.markDeleted()                // set bit3 in info
    addToIdSet(transaction.deleteSet, this.id.client, this.id.clock, this.length)
    addChangedTypeToTransaction(transaction, parent, this.parentSub)
    this.content.delete(transaction)  // content cleans up its own resources
  }
}
```

Marking an item deleted:
1. Adjusts the parent's logical length (so `ytext.length` reflects deletions)
2. Sets the deleted bit in `info`
3. Adds the ID range to the transaction's DeleteSet (the tombstone store)
4. Notifies the transaction that this type changed (for observers/events)
5. Calls `content.delete()` — content handles freeing its own resources (e.g. nested YTypes)

The Item **stays in the linked list** as a position anchor. Only the content is eventually freed by GC.

### `gc`

```javascript
gc(tr, parentGCd) {
  if (!this.deleted) throw error.unexpectedCase()  // can only GC deleted items
  this.content.gc(tr)
  if (parentGCd) {
    replaceStruct(tr, this, new GC(this.id, this.length))  // replace with lightweight GC stub
  } else {
    this.content = new ContentDeleted(this.length)  // keep struct, discard content
  }
}
```

Two-level GC:
- If the **parent** was also GC'd → replace the entire Item struct with a `GC` object. A `GC` is just `{id, length}` — the minimum needed to maintain clock continuity. The position is gone.
- If only this item is being GC'd → keep the Item struct (for position anchoring), replace content with `ContentDeleted` (just a length, no data).

This maps directly to Section 4 of the paper: GC can only happen once an item is stable (all concurrent ops have been delivered). YJS manages this through the state vector exchange — when a peer knows everyone has seen an op, it can GC it.

### `followRedone` — Undo/Redo

```javascript
export const followRedone = (store, id) => {
  let nextID = id
  let diff = 0
  let item
  do {
    if (diff > 0) nextID = createID(nextID.client, nextID.clock + diff)
    item = getItem(store, nextID)
    diff = nextID.clock - item.id.clock
    nextID = item.redone
  } while (nextID !== null && item instanceof Item)
  return { item, diff }
}
```

When an item is "redone" (re-applied after being undone), the original item gets a `redone` pointer to the new item. If the item was split (`diff > 0`), the pointer needs to be offset accordingly.

`followRedone` chases this chain to find the **current live version** of any Item — used by the undo manager to figure out where a previously-undone item now lives in the document.

---

## Key Takeaways

1. **`{client, clock}` = OR-Set unique tag.** Every item has one, globally unique, never reused.

2. **`origin` + `rightOrigin` = YATA.** Two anchors instead of RGA's one. Case 2 in `integrate()` uses both to prevent interleaving.

3. **`deleted` flag ≠ removal from list.** Tombstones stay as position anchors. Content is freed by GC eventually. This is why concurrent inserts around deleted items still work correctly.

4. **`mergeWith` / `splitItem` are pure optimizations.** They don't change semantics — just memory layout. Consecutive chars from the same client get merged; merged items get split when needed.

5. **`getMissing` is causal delivery.** Items can't integrate until their origins exist. This is the downstream precondition from the paper, implemented as a pending-item queue.

6. **Y.Map LWW is inside `integrate()`.** When `right === null && parentSub !== null`, the new item wins and deletes the old value. LWW falls out of the linked list ordering, not a separate mechanism.

7. **The `info` bitmask is a memory optimization.** One byte for four booleans — important when you have millions of Items.
