# AbstractType.js — Annotated

`src/types/AbstractType.js` is the shared base class for Y.Text, Y.Map, and Y.Array. It holds two storage structures (`_start` + `_map`), the event system, and all list/map operations. Y.Text, Y.Array, and Y.Map all delegate to the functions here — they differ only in which API they expose.

→ [Improvements and open questions](./improvements.md)

---

## Table of Contents

- [The Fields](#the-fields)
- [The Two Storage Modes](#the-two-storage-modes)
- [List Operations — `_start` linked list](#list-operations--start-linked-list)
  - [Walking the list](#walking-the-list)
  - [`typeListGet` — O(n) random access](#typelistget--on-random-access)
  - [`typeListInsertGenericsAfter` — where YATA's origins are captured](#typelistinsertgenericsafter--where-yatas-origins-are-captured)
  - [Content packing — the batching optimization](#content-packing--the-batching-optimization)
  - [`typeListInsertGenerics` — split on insert](#typelistinsertgenerics--split-on-insert)
  - [`typeListDelete` — split on delete](#typelistdelete--split-on-delete)
- [Map Operations — `_map`](#map-operations--map)
  - [`typeMapSet` — where LWW lives](#typemapset--where-lww-lives)
  - [`typeMapGet` — always reads the winner](#typemapget--always-reads-the-winner)
  - [`typeMapGetSnapshot` — time travel via `left` chain](#typemapgetsnapshot--time-travel-via-left-chain)
- [The Event System](#the-event-system)
  - [`observe` vs `observeDeep`](#observe-vs-observedeep)
  - [Event bubbling — `callTypeObservers`](#event-bubbling--calltypeobservers)
- [Key Takeaways](#key-takeaways)

---

## The Fields

```javascript
class AbstractType {
  constructor() {
    this._item   = null   // Item that contains this type (null if root)
    this._map    = new Map()   // Map<string, Item> — for Y.Map keys
    this._start  = null   // head of the Item linked list — for Y.Text / Y.Array
    this.doc     = null   // the Doc this type belongs to
    this._length = 0      // cached visible length (maintained by integrate/delete)
    this._eH     = createEventHandler()   // direct observer handlers
    this._dEH    = createEventHandler()   // deep observer handlers
  }
}
```

| Field | Purpose |
|---|---|
| `_item` | If this type is nested (e.g. a Y.Map inside a Y.Array), `_item` is the Item that wraps it. Null at root. Used for event bubbling — walk `_item.parent` to reach the parent type. |
| `_map` | Key → Item store. For Y.Map: holds the current (winning) Item per key. For Y.Text: holds format marks. |
| `_start` | Head of the doubly-linked Item list. For Y.Text and Y.Array. Walk `_start → .right → .right` to read the sequence. |
| `_length` | Cached visible length. Not recomputed on every read — maintained incrementally in `Item.integrate()` and `Item.delete()`. |
| `_eH` | Handlers registered via `.observe()`. Fire on direct changes to this type. |
| `_dEH` | Handlers registered via `.observeDeep()`. Fire on changes anywhere in the subtree. |

---

## The Two Storage Modes

Every `AbstractType` has both `_start` and `_map`. Which one is used depends on the type:

```
Y.Array / Y.Text:
  _start → Item → Item → Item → ...   (sequence)
  _map                                 (unused, or format marks for Y.Text)

Y.Map:
  _start                               (unused)
  _map = { "key1": Item, "key2": Item, ... }  (latest value per key)
```

The same `Item` class works for both. For sequence items: `item.parentSub = null`. For map items: `item.parentSub = "the key"`. This single flag determines which storage structure an Item lives in.

---

## List Operations — `_start` linked list

### Walking the list

All list operations share the same pattern: walk `_start`, skip deleted items, process countable ones.

```javascript
export const typeListToArray = type => {
  const cs = []
  let n = type._start
  while (n !== null) {
    if (n.countable && !n.deleted) {      // skip tombstones, skip format marks
      const c = n.content.getContent()
      for (let i = 0; i < c.length; i++) {
        cs.push(c[i])
      }
    }
    n = n.right
  }
  return cs
}
```

Two filters:
- `!n.deleted` — skip tombstones (they stay in the list as position anchors but are invisible to users)
- `n.countable` — skip non-countable items like format marks (Y.Text uses non-countable Items for bold/italic metadata — they exist in the list but don't count toward length or index)

The same walk with `isVisible(n, snapshot)` instead of `!n.deleted` gives snapshot support — you can read the document as it was at any past point.

### `typeListGet` — O(n) random access

```javascript
export const typeListGet = (type, index) => {
  for (let n = type._start; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) {
        return n.content.getContent()[index]  // found inside this item
      }
      index -= n.length   // subtract this item's length and keep scanning
    }
  }
}
```

Linear scan from the start. `index` counts down as we pass visible items. When it hits zero, we're at the right item.

This is O(n). There is no constant-time random access. The `_searchMarker` system in Y.Array (not in this file) places markers at regular intervals to turn this into O(n/markerCount) — closer to O(√n) in practice.

### `typeListInsertGenericsAfter` — where YATA's origins are captured

This is the **atSource phase** of the YATA algorithm in practice. When you call `yarray.insert(index, content)`, it eventually calls here.

```javascript
export const typeListInsertGenericsAfter = (transaction, parent, referenceItem, content) => {
  let left = referenceItem
  const right = referenceItem === null ? parent._start : referenceItem.right

  // ... (content packing, see below)

  left = new Item(
    createID(ownClientId, getState(store, ownClientId)),  // fresh {client, clock} ID
    left,                     // current left neighbor
    left && left.lastId,      // origin  = left neighbor's last clock (frozen at insert time)
    right,                    // current right neighbor
    right && right.id,        // rightOrigin = right neighbor's first clock (frozen at insert time)
    parent,
    null,                     // parentSub = null → this is a list item, not a map item
    content
  )
  left.integrate(transaction, 0)
}
```

`origin = left.lastId` and `rightOrigin = right.id` are **frozen at the moment of insert**. These are the two anchor references YATA uses during `integrate()` to find the correct position when concurrent inserts have arrived.

This is the atSource phase from the paper: capture what we observe right now, put it in the op, broadcast it. Downstream (at other replicas), `integrate()` uses those frozen origins to find the correct position in whatever state the replica is in at that point.

### Content packing — the batching optimization

```javascript
let jsonContent = []

const packJsonContent = () => {
  if (jsonContent.length > 0) {
    left = new Item(..., new ContentAny(jsonContent))
    left.integrate(transaction, 0)
    jsonContent = []
  }
}

content.forEach(c => {
  switch (c.constructor) {
    case Number: case Object: case Boolean: case Array: case String:
      jsonContent.push(c)    // batch JSON-compatible values
      break
    default:
      packJsonContent()      // flush batch before handling special types
      // handle Uint8Array, AbstractType separately — each gets its own Item
  }
})
packJsonContent()   // flush any remaining batch
```

JSON-compatible values (numbers, strings, objects, arrays, booleans) are batched into a single `ContentAny` item. Only when a non-JSON type appears (binary, nested YType) does the batch flush and that type get its own Item.

**Why:** creating one `Item` for `["h","e","l","l","o"]` is far cheaper than five separate Items with five separate `{client, clock}` IDs. This is how YJS avoids Item explosion when inserting strings.

**The implication:** when you insert a string of 1000 characters in one call, you get ONE Item (not 1000). When multiple users type simultaneously, each keystroke is its own Item (because each comes from a separate `ytext.insert()` call). The merging happens later via `mergeWith()` if the inserts are consecutive from the same client.

### `typeListInsertGenerics` — split on insert

```javascript
export const typeListInsertGenerics = (transaction, parent, index, content) => {
  if (index === 0) {
    return typeListInsertGenericsAfter(transaction, parent, null, content)
  }
  let n = parent._start
  for (; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index <= n.length) {
        if (index < n.length) {
          // inserting in the middle of a merged item — split it first
          getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index))
        }
        break
      }
      index -= n.length
    }
  }
  return typeListInsertGenericsAfter(transaction, parent, n, content)
}
```

Finds the correct position by counting visible items. When the target index falls inside a merged Item (`index < n.length`), `getItemCleanStart` splits it — exactly what we saw in StructStore. Then insert after the now-clean boundary.

### `typeListDelete` — split on delete

```javascript
export const typeListDelete = (transaction, parent, index, length) => {
  if (length === 0) return
  let n = parent._start
  // find the first item to delete (skip 'index' visible items)
  for (; n !== null && index > 0; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) {
        // start boundary is inside a merged item — split
        getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index))
      }
      index -= n.length
    }
  }
  // delete items until 'length' visible items have been deleted
  while (length > 0 && n !== null) {
    if (!n.deleted) {
      if (length < n.length) {
        // end boundary is inside a merged item — split
        getItemCleanStart(transaction, createID(n.id.client, n.id.clock + length))
      }
      n.delete(transaction)
      length -= n.length
    }
    n = n.right
  }
}
```

Two-phase: find the start, then walk and delete. Both boundaries trigger `getItemCleanStart` splits when they fall inside merged items — ensuring deletions apply to exact character boundaries.

The split-on-access pattern from StructStore appears again here: merged items are transparent to callers. They behave like individual items at the API level.

---

## Map Operations — `_map`

### `typeMapSet` — where LWW lives

```javascript
export const typeMapSet = (transaction, parent, key, value) => {
  const left = parent._map.get(key) || null   // current value for this key (may be null)
  const doc = transaction.doc
  const ownClientId = doc.clientID
  // ... build content from value ...
  new Item(
    createID(ownClientId, getState(doc.store, ownClientId)),
    left,               // left = previous value for this key
    left && left.lastId,
    null,               // right = null
    null,               // rightOrigin = null
    parent,
    key,                // parentSub = the key → this is a map item
    content
  ).integrate(transaction, 0)
}
```

The new Item is created with `right = null` and `rightOrigin = null`. In `Item.integrate()`, when `right === null && parentSub !== null`, the new item becomes `_map.get(key)` and deletes its left neighbor.

**This is LWW.** It falls out of the YATA ordering, not a separate mechanism.

**What about concurrent writes?** If two replicas write the same key simultaneously, both create Items with `rightOrigin = null`. When replica B's write arrives at replica A:
- Both items have the same `origin` (the previous map value)
- Both have `rightOrigin = null`
- YATA Case 1: same origin → compare `rightOrigin` → both null → `compareIDs` returns true → client ID breaks the tie
- Higher client ID → goes to the right → becomes `right = null` → wins

Higher client ID always wins concurrent map writes. Deterministic across all replicas.

### `typeMapGet` — always reads the winner

```javascript
export const typeMapGet = (parent, key) => {
  const val = parent._map.get(key)
  return val !== undefined && !val.deleted
    ? val.content.getContent()[val.length - 1]
    : undefined
}
```

`_map` always holds the **current winner** — the rightmost, non-deleted Item for each key. Simple O(1) lookup. If it's deleted, return `undefined`.

### `typeMapGetSnapshot` — time travel via `left` chain

```javascript
export const typeMapGetSnapshot = (parent, key, snapshot) => {
  let v = parent._map.get(key) || null
  while (v !== null && (!snapshot.sv.has(v.id.client) || v.id.clock >= (snapshot.sv.get(v.id.client) || 0))) {
    v = v.left   // walk backwards in time
  }
  return v !== null && isVisible(v, snapshot) ? v.content.getContent()[v.length - 1] : undefined
}
```

`_map` stores the **entire history** of writes to a key — all previous values form a chain via `left` pointers. Walking left takes you back through time.

The while condition: "does this item post-date the snapshot?" A snapshot carries a state vector `sv` (a G-Counter). If `v.id.clock >= sv.get(v.id.client)`, this item didn't exist yet at snapshot time. Walk left until you find one that did.

This is how `Y.UndoManager` and document versioning work — snapshot the state vector, read any key at that past state by walking the `left` chain.

**This means Y.Map never truly deletes history.** Every write creates a new Item. Old Items remain as the `left` chain behind the current winner. GC can eventually clean them up, but only once no snapshot references them.

---

## The Event System

### `observe` vs `observeDeep`

```javascript
observe(f) {
  addEventHandlerListener(this._eH, f)   // fires on direct changes to THIS type
}

observeDeep(f) {
  addEventHandlerListener(this._dEH, f)  // fires on changes to THIS type OR any child
}
```

`_eH` (event handler) = direct observer. Only fires when this type itself changes.

`_dEH` (deep event handler) = subtree observer. Fires when anything in the subtree changes. Used for watching a Y.Map that contains nested Y.Arrays — you get notified of deep changes without manually observing every child.

### Event bubbling — `callTypeObservers`

```javascript
export const callTypeObservers = (type, transaction, event) => {
  const changedType = type
  const changedParentTypes = transaction.changedParentTypes

  while (true) {
    map.setIfUndefined(changedParentTypes, type, () => []).push(event)
    if (type._item === null) break          // reached root
    type = type._item.parent               // walk up to parent type
  }
  callEventHandlerListeners(changedType._eH, event, transaction)
}
```

When a change fires, the event is:
1. Recorded in `transaction.changedParentTypes` for every ancestor type (for `observeDeep`)
2. Direct observers (`_eH`) on the changed type are called immediately

The `changedParentTypes` map is flushed at the end of the transaction — all deep observers fire once, after all operations in the transaction are complete. This batches multiple changes in one transaction into one deep event, not one event per operation.

The parent walk uses `type._item.parent` — each nested type's `_item` is the Item that contains it, and `_item.parent` is the AbstractType that contains that Item. This is how a Y.Map nested inside a Y.Array knows its parent.

---

## Key Takeaways

1. **`_start` is Y.Array/Y.Text, `_map` is Y.Map.** The same class, two modes, controlled by `item.parentSub`. One codebase serves all three types.

2. **LWW for Y.Map falls out of YATA.** `typeMapSet` creates items with `right = null`. YATA's ordering puts higher-clock items to the right. The rightmost wins. No separate LWW logic needed.

3. **Y.Map stores full history via `left` chains.** `_map` holds the current winner. Old values sit behind it as a `left` chain. Snapshot queries walk that chain backward in time.

4. **Random access is O(n).** `typeListGet` scans from `_start`. The `_searchMarker` system (in Y.Array) improves this but doesn't change the worst case.

5. **Content packing reduces Item count.** Consecutive JSON values in one `insert()` call → one `ContentAny` item. Only type boundaries (binary, nested YType) force a new Item.

6. **`typeListInsertGenericsAfter` is the atSource phase.** This is where `origin` and `rightOrigin` are captured — the two YATA anchors that `integrate()` uses downstream.

7. **Events batch inside transactions.** Direct observers fire per-change. Deep observers (`_dEH`) fire once per transaction via `changedParentTypes` flush — no event storms from bulk operations.
