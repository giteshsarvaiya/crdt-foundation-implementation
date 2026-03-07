# StructStore.js — Annotated

`src/utils/StructStore.js` is how YJS stores and indexes every Item and GC struct ever created. It is the G-Counter from our implementations — the state vector that tracks what each replica has seen — plus the binary search index that makes lookups fast.

→ [Improvements and open questions](./improvements.md)

---

## Table of Contents

- [The Data Structure](#the-data-structure)
- [The G-Counter — `getStateVector` and `getState`](#the-g-counter--getstatevector-and-getstate)
- [Adding Structs — `addStruct`](#adding-structs--addstruct)
- [The Pending Systems — Causal Delivery](#the-pending-systems--causal-delivery)
- [Binary Search — `findIndexSS`](#binary-search--findindexss)
- [Clean Start and Clean End — Split on Access](#clean-start-and-clean-end--split-on-access)
- [`replaceStruct` — In-place GC](#replacestruct--in-place-gc)
- [`iterateStructs` — Range Walking](#iteratestructs--range-walking)
- [Key Takeaways](#key-takeaways)

---

## The Data Structure

```javascript
export class StructStore {
  constructor() {
    this.clients = new Map()                    // Map<clientId, Array<GC|Item>>
    this.pendingClientsStructRefs = new Map()   // Map<clientId, {i, refs}>
    this.pendingStack = []                      // Array<GC|Item>
    this.pendingDeleteReaders = []              // Array<Decoder>
  }
}
```

### `clients: Map<number, Array<GC|Item>>`

The core storage. One **sorted array** per client. Each array holds every struct (Item or GC) ever received from that client, in clock order.

```
clients = {
  clientId_A: [ Item(clock=0,len=5), Item(clock=5,len=1), GC(clock=6,len=3), Item(clock=9,len=1) ]
  clientId_B: [ Item(clock=0,len=1), Item(clock=1,len=2), Item(clock=3,len=4) ]
}
```

Two rules that always hold:
1. **No gaps** — `structs[i].clock + structs[i].length === structs[i+1].clock`. Every clock value is covered.
2. **Append only** — new structs are always pushed to the end. You never insert in the middle.

These two rules together make the array a **sorted, contiguous timeline** per client, which is what makes O(log n) binary search possible and state vector computation O(1) (just look at the last element).

---

## The G-Counter — `getStateVector` and `getState`

```javascript
export const getStateVector = store => {
  const sm = new Map()
  store.clients.forEach((structs, client) => {
    const struct = structs[structs.length - 1]   // last item from this client
    sm.set(client, struct.id.clock + struct.length) // next expected clock
  })
  return sm
}
```

This returns `Map<clientId, nextExpectedClock>`. It answers: "for each client I know about, what's the next clock I'm waiting for?"

This IS the G-Counter payload from our implementation:

| G-Counter | StructStore |
|---|---|
| `vector[replicaId]` | `getStateVector().get(clientId)` |
| "highest value seen" | `nextExpectedClock = lastStruct.clock + lastStruct.length` |
| `merge(A, B) = max per slot` | On sync: exchange state vectors, request missing ops |

The `nextExpectedClock` convention (not the last seen clock, but last+length) handles merged items. An Item with `clock=5, length=3` covers clocks 5, 6, 7. The next expected is 8. Simply storing `clock=7` would require knowing the length separately.

```javascript
export const getState = (store, client) => {
  const structs = store.clients.get(client)
  if (structs === undefined) return 0           // unknown client → expecting clock 0
  const lastStruct = structs[structs.length - 1]
  return lastStruct.id.clock + lastStruct.length
}
```

`getState` is the single-client version — `G-Counter.value(replicaId)`. Returns 0 for unknown clients, consistent with "I've seen nothing from you yet."

**How sync works using these:**

```
Peer A state vector: { alice: 10, bob: 5 }
Peer B state vector: { alice: 7,  bob: 8 }

A needs from B: bob ops 5..7  (B has them, A doesn't)
B needs from A: alice ops 7..9 (A has them, B doesn't)

Each peer sends only what the other is missing.
```

This is exactly our G-Counter's `compare()` — but instead of just saying "who's ahead", it computes the exact gap and fills it.

---

## Adding Structs — `addStruct`

```javascript
export const addStruct = (store, struct) => {
  let structs = store.clients.get(struct.id.client)
  if (structs === undefined) {
    structs = []
    store.clients.set(struct.id.client, structs)   // first struct from this client
  } else {
    const lastStruct = structs[structs.length - 1]
    if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
      throw error.unexpectedCase()                 // gap detected — should never happen
    }
  }
  structs.push(struct)
}
```

Simple append. The gap check enforces the no-gaps rule. If a struct arrives out of order, this throws — meaning the caller must ensure structs are added in dependency order.

**Who ensures ordering?** The pending system (below). Structs that arrive before their dependencies are buffered. Only once all dependencies are present is `addStruct` called.

---

## The Pending Systems — Causal Delivery

The `StructStore` constructor has three pending buffers. Together they implement causal delivery — the same guarantee our Op-OR-Set required.

```javascript
this.pendingClientsStructRefs = new Map()  // Map<clientId, {i, refs}>
this.pendingStack = []
this.pendingDeleteReaders = []
```

### `pendingClientsStructRefs`

When a network update arrives, it contains batches of structs grouped by client. These are decoded but not yet integrated. They sit here, indexed by client, with `i` tracking how far through the batch we've processed.

```javascript
// Comment from source:
// "We could shift the array of refs instead, but shift is incredibly
//  slow in Chrome for arrays with more than 100k elements"
```

Instead of removing processed items from the front (O(n) shift), `i` is an index that advances forward. The array is never mutated — only `i` moves. This is a common optimization for large queues in JS.

### `pendingStack`

When a struct's dependencies (origin, rightOrigin, parent) aren't in the store yet, it goes onto `pendingStack`. After each new struct is successfully added, the stack is retried — maybe the new arrival unblocked something.

This is `getMissing()` from Item.js in action. If `getMissing` returns a client ID (dependency missing), the struct waits here until that client's ops arrive.

### `pendingDeleteReaders`

DeleteSet updates that arrived before the items they reference. Same pattern — buffer until dependencies present.

**The full causal delivery flow:**
```
Update arrives
  → decode structs into pendingClientsStructRefs
  → for each struct:
      → call getMissing()
      → if missing: push to pendingStack, wait
      → if not missing: addStruct(), integrate()
      → after each success: retry pendingStack
  → apply pendingDeleteReaders last (items must exist before deletions)
```

---

## Binary Search — `findIndexSS`

```javascript
export const findIndexSS = (structs, clock) => {
  let left = 0
  let right = structs.length - 1
  let mid = structs[right]
  let midclock = mid.id.clock
  if (midclock === clock) return right             // exact hit on last item — fast path

  // Pivot: guess the index proportionally based on clock value
  let midindex = math.floor((clock / (midclock + mid.length - 1)) * right)

  while (left <= right) {
    mid = structs[midindex]
    midclock = mid.id.clock
    if (midclock <= clock) {
      if (clock < midclock + mid.length) {
        return midindex                            // clock is WITHIN this struct's range
      }
      left = midindex + 1
    } else {
      right = midindex - 1
    }
    midindex = math.floor((left + right) / 2)    // standard binary search midpoint
  }

  throw error.unexpectedCase()                   // should never reach here if store is consistent
}
```

Two things worth noting:

**1. Range-aware comparison:**

Standard binary search compares exact values. Here, a struct covers a range `[clock, clock+length)`. The check `midclock <= clock < midclock + mid.length` catches the case where `clock` lands inside a merged item (e.g. clock=7 inside an item with clock=5, length=4).

**2. Pivot optimization:**

Instead of always starting at the middle index, the first guess is proportional:

```
midindex = floor((targetClock / maxClock) * maxIndex)
```

If clock values are roughly uniformly distributed across the array (a reasonable assumption for a collaborative document), this initial guess is likely close to the right answer — often finding it in 1 iteration instead of log(n).

After the first guess, it falls back to standard binary search. The pivot only helps the first probe.

**The TODO in the source:**
```javascript
// @todo does it even make sense to pivot the search?
// If a good split misses, it might actually increase the time to find the correct item.
// Currently, the only advantage is that search with pivoting might find the item on the first try.
```

The author is uncertain whether the pivot is actually beneficial. If clock values aren't uniformly distributed (e.g. burst edits from one client), the pivot guess could be far off and add an extra iteration. Worth profiling.

---

## Clean Start and Clean End — Split on Access

These two functions handle the case where you need to access a specific clock boundary that falls inside a merged item.

### `getItemCleanStart`

```javascript
export const findIndexCleanStart = (transaction, structs, clock) => {
  const index = findIndexSS(structs, clock)
  const struct = structs[index]
  if (struct.id.clock < clock && struct instanceof Item) {
    // clock lands INSIDE this item — split it
    structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock))
    return index + 1   // return the right half (starts exactly at clock)
  }
  return index
}
```

If the binary search finds an item that starts before `clock` (clock lands in the middle of a merged item), split it. The left half keeps its original index. The right half is inserted at `index + 1` and returned.

**Example:**
```
Item: clock=5, length=5  (covers clocks 5,6,7,8,9)
Request: getItemCleanStart at clock=7

→ findIndexSS finds the item (clock=5 ≤ 7 < 10)
→ struct.id.clock (5) < 7 → split at diff = 7-5 = 2
→ Left half:  clock=5, length=2  (covers 5,6)
→ Right half: clock=7, length=3  (covers 7,8,9) ← returned
```

### `getItemCleanEnd`

Same idea but from the right side — ensures the returned item **ends** at exactly `id.clock`.

```javascript
export const getItemCleanEnd = (transaction, store, id) => {
  const structs = store.clients.get(id.client)
  const index = findIndexSS(structs, id.clock)
  const struct = structs[index]
  if (id.clock !== struct.id.clock + struct.length - 1 && struct.constructor !== GC) {
    // id.clock is not the last clock of this struct — split
    structs.splice(index + 1, 0, splitItem(transaction, struct, id.clock - struct.id.clock + 1))
  }
  return struct   // return the LEFT half (ends exactly at id.clock)
}
```

**Where these are used:**

In `Item.integrate()` when resolving `origin` and `rightOrigin`:
```javascript
this.left = getItemCleanEnd(transaction, store, this.origin)
this.right = getItemCleanStart(transaction, this.rightOrigin)
```

The YATA algorithm needs exact boundaries. `origin` points to the **last clock** of the left neighbor. `rightOrigin` points to the **first clock** of the right neighbor. If those boundaries fall inside merged items, split first.

---

## `replaceStruct` — In-place GC

```javascript
export const replaceStruct = (store, struct, newStruct) => {
  const structs = store.clients.get(struct.id.client)
  structs[findIndexSS(structs, struct.id.clock)] = newStruct
}
```

Used by `Item.gc()` when a deleted item's parent is also GC'd. The Item gets replaced in-place with a lightweight `GC` object `{id, length}` — same clock range, minimal memory.

The array position never changes — the binary search still works because the clock value is the same. Only the object at that index is swapped.

---

## `iterateStructs` — Range Walking

```javascript
export const iterateStructs = (transaction, structs, clockStart, len, f) => {
  if (len === 0) return
  const clockEnd = clockStart + len
  let index = findIndexCleanStart(transaction, structs, clockStart)
  let s
  // walks from clockStart to clockEnd, calling f on each struct
  ...
}
```

Walks all structs covering `[clockStart, clockStart+len)`, calling `f` on each. Used by the GC system and deletion application to process ranges of structs. Uses `findIndexCleanStart` to ensure the walk starts at a clean boundary.

---

## Key Takeaways

1. **`clients` is a G-Counter in disguise.** `Map<clientId, Array>` where the last element of each array gives the highest clock seen from that client. `getStateVector()` reads it directly.

2. **Append-only + no-gaps = O(log n) lookup.** The sorted, contiguous, append-only structure is what makes binary search safe. You pay strict ordering on insert, you get fast lookup everywhere else.

3. **Split on access, not on insert.** Merged items are never split when stored — only when accessed at a specific boundary. `getItemCleanStart` and `getItemCleanEnd` do this transparently. This keeps `addStruct` O(1) and defers the cost to read time.

4. **The pending systems are causal delivery.** `pendingStack` is the buffer for structs whose `getMissing()` returned non-null. The store only calls `integrate()` once all dependencies are present. This is the downstream precondition from the paper, implemented as a retry queue.

5. **`replaceStruct` is how GC works at the storage level.** Delete an item → mark it → eventually replace with a GC stub in the same array slot. The array structure is never reshuffled.

6. **The pivot in `findIndexSS` is an unverified optimization.** The author left a TODO questioning it. Worth profiling in a real workload.
