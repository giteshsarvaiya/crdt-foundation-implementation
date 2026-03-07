# Transaction.js — Annotated

`src/utils/Transaction.js` is the commit pipeline. Every change in YJS — local or remote — goes through a Transaction. This file answers: what actually happens between "user types a key" and "provider sends a network message."

→ [Improvements and open questions](./improvements.md)

---

## Table of Contents

- [What a Transaction is](#what-a-transaction-is)
- [The Fields](#the-fields)
- [`transact()` — the Core Function](#transact--the-core-function)
- [`cleanupTransactions()` — the Commit Pipeline](#cleanuptransactions--the-commit-pipeline)
  - [Step 1 — Observer calls](#step-1--observer-calls)
  - [Step 2 — Formatting cleanup](#step-2--formatting-cleanup)
  - [Step 3 — GC and merge](#step-3--gc-and-merge)
  - [Step 4 — Encode and emit update](#step-4--encode-and-emit-update)
  - [Step 5 — Subdoc events](#step-5--subdoc-events)
  - [Step 6 — Recurse or finish](#step-6--recurse-or-finish)
- [Transaction Nesting](#transaction-nesting)
- [Formatting Cleanup](#formatting-cleanup)
- [`tryGc` and `tryMerge`](#trygc-and-trymerge)
- [Key Takeaways](#key-takeaways)

---

## What a Transaction is

A Transaction is a **batch of changes** treated as one atomic unit. All changes inside one transaction produce one observer call and one network update message.

The CRDT guarantees (YATA convergence) still hold per-Item — the transaction is just a batching and delivery mechanism, not a consistency primitive.

---

## The Fields

```javascript
class Transaction {
  constructor(doc, origin, local) {
    this.doc = doc
    this.deleteSet  = createIdSet()   // what was deleted in this transaction
    this.cleanUps   = createIdSet()   // subset of deleteSet: formatting Items removed
    this.insertSet  = createIdSet()   // what was inserted in this transaction
    this._beforeState = null          // lazy: state vector before transaction
    this._afterState  = null          // lazy: state vector after transaction
    this.changed    = new Map()       // Map<YType, Set<string|null>> — which types changed
    this.changedParentTypes = new Map() // Map<YType, Array<YEvent>> — for observeDeep
    this._mergeStructs = []           // Items that need merge attempts after commit
    this.origin = origin              // who started this transaction (provider tag)
    this.local  = local               // true if originated from this replica
    this.subdocsAdded   = new Set()
    this.subdocsRemoved = new Set()
    this.subdocsLoaded  = new Set()
    this._needFormattingCleanup = false
    this._done = false
  }
}
```

**`deleteSet` vs `cleanUps`:** `deleteSet` contains all Items deleted during the transaction (user deletions + any GC that happened). `cleanUps` is a subset — only the formatting Items that were automatically removed (redundant bold/italic marks). Useful for distinguishing intentional user deletions from internal housekeeping.

**`insertSet` + `deleteSet` are IdSets** — the same range-compressed structure that replaced DeleteSet. They track what this transaction touched, used at commit time for encoding the update blob and for observer notifications.

**`_beforeState` / `_afterState` are lazy and deprecated.** They were exposed on the Transaction API but are now computed on demand and marked deprecated. The state vector is derived from StructStore + insertSet ranges.

**`origin`:** whoever creates the transaction passes an origin tag. Providers use this to identify their own updates when they receive them back:
```javascript
doc.on('update', (update, origin) => {
  if (origin !== this) {   // not my own update — forward to peers
    broadcast(update)
  }
})
```

---

## `transact()` — the Core Function

```javascript
export const transact = (doc, f, origin = null, local = true) => {
  const transactionCleanups = doc._transactionCleanups
  let initialCall = false
  let result = null

  if (doc._transaction === null) {
    initialCall = true
    doc._transaction = new Transaction(doc, origin, local)
    transactionCleanups.push(doc._transaction)
    if (transactionCleanups.length === 1) {
      doc.emit('beforeAllTransactions', [doc])
    }
    doc.emit('beforeTransaction', [doc._transaction, doc])
  }

  try {
    result = f(doc._transaction)
  } finally {
    if (initialCall) {
      const finishCleanup = doc._transaction === transactionCleanups[0]
      doc._transaction = null
      if (finishCleanup) {
        cleanupTransactions(transactionCleanups, 0)
      }
    }
  }
  return result
}
```

**Transaction nesting:** if `doc._transaction` is already set, `transact()` reuses it — the inner call is a no-op wrapper. Only the outermost `transact()` creates a Transaction and triggers cleanup. This is how `doc.transact(() => { ymap.set('a', 1); ymap.set('b', 2) })` works: the `set` calls each invoke `transact()` internally, but they see an existing transaction and skip creation.

**The cleanup trigger:** `initialCall` is true only for the transaction that created the Transaction object. When that call's `f(transaction)` finishes, it sets `doc._transaction = null` and calls `cleanupTransactions`.

**`transactionCleanups` queue:** observers can create new transactions. Those new transactions don't run cleanup immediately — they get pushed to `_transactionCleanups` and processed sequentially by `cleanupTransactions`'s recursion (Step 6 below).

---

## `cleanupTransactions()` — the Commit Pipeline

This is the most important function in YJS. It runs after every transaction and drives the entire post-commit lifecycle.

```javascript
const cleanupTransactions = (transactionCleanups, i) => {
  if (i < transactionCleanups.length) {
    const transaction = transactionCleanups[i]
    transaction._done = true
    // ... the full pipeline
  }
}
```

### Step 1 — Observer calls

```javascript
doc.emit('beforeObserverCalls', [transaction, doc])

const fs = []
transaction.changed.forEach((subs, itemtype) =>
  fs.push(() => {
    if (itemtype._item === null || !itemtype._item.deleted) {
      itemtype._callObserver(transaction, subs)   // fires .observe() handlers
    }
  })
)
fs.push(() => {
  transaction.changedParentTypes.forEach((events, type) => {
    if (type._dEH.l.length > 0 && (type._item === null || !type._item.deleted)) {
      callEventHandlerListeners(type._dEH, deepEvent, transaction)  // fires .observeDeep()
    }
  })
})
fs.push(() => doc.emit('afterTransaction', [transaction, doc]))

callAll(fs, [])  // calls each function even if previous ones throw
```

`callAll` guarantees all observer functions are called even if one throws. This prevents one buggy observer from silencing all others.

Observer calls happen **before** GC and merge. This means observers see the full uncompressed state, including Items that are about to be garbage collected.

### Step 2 — Formatting cleanup

```javascript
if (transaction._needFormattingCleanup && doc.cleanupFormatting) {
  cleanupYTextAfterTransaction(transaction)
}
```

If any formatting Item was inserted or deleted, scan the affected Y.Text regions and remove redundant format marks. This runs **inside a new transaction** (which gets pushed to `transactionCleanups` and processed in the next iteration of `cleanupTransactions`).

### Step 3 — GC and merge

```javascript
if (doc.gc) {
  tryGcDeleteSet(transaction, ds, doc.gcFilter)  // replace deleted Items with GC stubs
}
tryMerge(ds, store)                              // merge adjacent deleted Items

// merge inserted structs
transaction.insertSet.clients.forEach((ids, client) => {
  const structs = store.clients.get(client)
  for (let i = structs.length - 1; i >= firstChangePos;) {
    i -= 1 + tryToMergeWithLefts(structs, i)
  }
})

// merge _mergeStructs (items that were split during this transaction)
for (let i = mergeStructs.length - 1; i >= 0; i--) {
  // try to merge each split item with its neighbors
}
```

**Why merge after GC?** GC replaces deleted Items with lightweight GC stubs. Adjacent GC stubs and adjacent Items from the same client can then be merged into single entries. This keeps StructStore arrays compact.

**`_mergeStructs`:** Items that were split during `integrate()` (because an insert landed in the middle of a merged item) are tracked here. After the transaction, we try to re-merge them with their neighbors if conditions allow.

### Step 4 — Encode and emit update

```javascript
if (doc._observers.has('update')) {
  const encoder = new UpdateEncoderV1()
  const hasContent = writeUpdateMessageFromTransaction(encoder, transaction)
  if (hasContent) {
    doc.emit('update', [encoder.toUint8Array(), transaction.origin, doc, transaction])
  }
}
if (doc._observers.has('updateV2')) {
  const encoder = new UpdateEncoderV2()
  const hasContent = writeUpdateMessageFromTransaction(encoder, transaction)
  if (hasContent) {
    doc.emit('updateV2', [encoder.toUint8Array(), transaction.origin, doc, transaction])
  }
}
```

**This is where providers get their data.** The update blob contains:
1. All inserted structs (from `transaction.insertSet`)
2. The deleteSet (all deletions)

Only emitted if there's actual content (`hasContent`). A transaction that only fires observers without changing anything doesn't produce a network message.

`updateV2` uses a more compact binary format (delta-encoded clocks). `update` uses V1 for backwards compatibility. Providers that support it subscribe to `updateV2` for smaller messages.

### Step 5 — Subdoc events

```javascript
if (subdocsAdded.size > 0 || subdocsRemoved.size > 0 || subdocsLoaded.size > 0) {
  subdocsAdded.forEach(subdoc => {
    subdoc.clientID = doc.clientID   // subdocs share parent's clientID
    doc.subdocs.add(subdoc)
  })
  subdocsRemoved.forEach(subdoc => doc.subdocs.delete(subdoc))
  doc.emit('subdocs', [{ loaded, added, removed }, doc, transaction])
  subdocsRemoved.forEach(subdoc => subdoc.destroy())
}
```

Subdocuments added or removed in this transaction are processed here. New subdocs inherit the parent's `clientID`. Removed subdocs are destroyed after the event fires.

### Step 6 — Recurse or finish

```javascript
if (transactionCleanups.length <= i + 1) {
  doc._transactionCleanups = []
  doc.emit('afterAllTransactions', [doc, transactionCleanups])
} else {
  cleanupTransactions(transactionCleanups, i + 1)  // process next queued transaction
}
```

If observers created new transactions (e.g. inside a `.observe()` handler), they were pushed to `_transactionCleanups`. `cleanupTransactions` processes them one by one, recursively. When all are done, `afterAllTransactions` fires.

---

## Transaction Nesting

```
doc.transact(() => {        ← creates Transaction A, initialCall=true
  ymap.set('a', 1)          ← internally calls transact(), sees A exists, reuses it
  ymap.set('b', 2)          ← same
})                          ← A's initialCall finishes → cleanupTransactions runs

  inside observer for A:
    doc.transact(() => {    ← creates Transaction B, pushed to _transactionCleanups
      ...
    })

cleanupTransactions(cleanups, 0)  → process A → observers → A creates B
cleanupTransactions(cleanups, 1)  → process B → B's observers → ...
cleanupTransactions(cleanups, n)  → done → afterAllTransactions
```

Each transaction in the queue gets its own full pipeline pass. Observers are never re-entrant — a transaction's observers run after the transaction commits, not during.

---

## Formatting Cleanup

Y.Text uses non-countable `ContentFormat` Items for bold, italic, etc. These can accumulate redundant entries — e.g. if bold is turned on, then the text is deleted, the bold-start and bold-end Items remain but serve no purpose.

```javascript
const cleanupFormattingGap = (transaction, start, curr, startAttributes, currAttributes) => {
  // Walk from 'start' to 'curr', find ContentFormat Items that are redundant
  // (either overwritten by a later format or already matched the pre-existing state)
  // Delete them
}
```

`_needFormattingCleanup` is set to true during `integrate()` when a formatting Item is inserted. This triggers `cleanupYTextAfterTransaction` at the end of the commit pipeline.

`isSuggestionDoc` disables all of this — suggestion docs keep all formatting Items as part of the suggestion record.

---

## `tryGc` and `tryMerge`

```javascript
const tryGcDeleteSet = (tr, ds, gcFilter) => {
  // For each deleted Item range in ds:
  //   if Item.deleted && !Item.keep && gcFilter(Item):
  //     Item.gc(tr, false)   → replaces content with ContentDeleted
}

const tryMerge = (ds, store) => {
  // For each deleted range, try to merge adjacent Items from right to left
  // Right-to-left ensures we don't miss merge targets as the array shrinks
}

const tryToMergeWithLefts = (structs, pos) => {
  // Walk left from pos, merging Items that satisfy mergeWith() conditions
  // Returns how many Items were merged (so the caller can adjust its index)
}
```

**Why right-to-left for merge?** When you merge `structs[i]` into `structs[i-1]` and remove `structs[i]`, the array shrinks at position `i`. If you were scanning left-to-right, you'd skip the now-adjacent pair. Right-to-left avoids this.

**`gcFilter`:** allows applications to keep specific Items from being GC'd. YJS's UndoManager uses this to preserve Items that are part of undo history.

---

## Key Takeaways

1. **`transact()` is a re-entrant gate.** Inner calls reuse the existing transaction. Only the outermost call triggers cleanup. This is why `ymap.set()` (which calls `transact()` internally) works both inside and outside a user-provided transaction.

2. **The commit pipeline order matters.** Observers → formatting cleanup → GC → merge → encode → emit 'update'. Providers receive the blob AFTER GC and merging, so the blob is already compressed.

3. **Observer calls happen before GC.** Observers see the full state, including Items that are about to be compacted. If an observer needs to inspect a deleted Item's content, it can — but that content may be gone by the next transaction.

4. **`transaction.origin` is how providers avoid echo.** Tag your transaction with the provider instance, check the tag in `doc.on('update')`, skip re-broadcasting your own updates.

5. **`cleanupTransactions` is recursive.** Transactions created by observers are queued and processed in sequence, not re-entrantly. `afterAllTransactions` fires only when the queue is empty.

6. **`insertSet` + `deleteSet` drive the update blob.** `writeUpdateMessageFromTransaction` reads both to produce the binary message. No content is read from StructStore directly — only what changed in this transaction.
