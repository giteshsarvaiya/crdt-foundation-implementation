# Doc.js — Annotated

`src/utils/Doc.js` is the root object. Everything else — StructStore, shared types, transactions, providers — hangs off a Doc. It is the entry point for every YJS application.

→ [Improvements and open questions](./improvements.md)

---

## Table of Contents

- [What Doc is](#what-doc-is)
- [The Fields](#the-fields)
- [clientID — the Replica ID](#clientid--the-replica-id)
- [The Promise API — `whenLoaded` / `whenSynced`](#the-promise-api--whenloaded--whensynced)
- [`get(key, name)` — the Unified Type Accessor](#getkey-name--the-unified-type-accessor)
- [Subdocuments](#subdocuments)
- [`transact(f, origin)`](#transactf-origin)
- [The Event Lifecycle](#the-event-lifecycle)
- [`isSuggestionDoc` — Track Changes Mode](#issuggestiondoc--track-changes-mode)
- [Key Takeaways](#key-takeaways)

---

## What Doc is

```javascript
export class Doc extends ObservableV2 {
  constructor({ guid, collectionid, gc, gcFilter, meta, autoLoad, shouldLoad, isSuggestionDoc } = {}) { ... }
}
```

Doc extends `ObservableV2` — a typed event emitter. Every `doc.on('update', ...)`, `doc.on('sync', ...)`, `doc.emit(...)` goes through this. Providers listen to Doc events. Doc emits events when transactions complete.

The Doc is the bridge between the CRDT internals (StructStore, Items, YATA) and the outside world (providers, editor bindings, application code).

---

## The Fields

| Field | Type | What it is |
|---|---|---|
| `clientID` | `number` | Random uint32. The replica ID. Used as the `client` in every `{client, clock}` Item ID. |
| `guid` | `string` | Globally unique document identifier (UUID). Used by providers to identify this document across sessions. |
| `collectionid` | `string \| null` | Optional grouping hint for providers that support collections. |
| `gc` | `boolean` | Whether garbage collection is enabled. Default true. |
| `gcFilter` | `function(Item): boolean` | Called before GC'ing an Item. Return false to keep it. Useful for preserving undo history. |
| `store` | `StructStore` | The core storage — all Items, all client arrays, state vector. |
| `share` | `Map<string, YType>` | Named shared types. `doc.get('content')` looks up/creates here. |
| `_transaction` | `Transaction \| null` | The currently active transaction. Null when no transaction is running. |
| `_transactionCleanups` | `Array<Transaction>` | Queue of transactions awaiting cleanup. Multiple transactions can queue up during observer callbacks. |
| `subdocs` | `Set<Doc>` | Nested documents embedded in this one via `ContentDoc`. |
| `_item` | `Item \| null` | If this Doc is a subdocument, this is the Item that contains it. |
| `isLoaded` | `boolean` | True once a persistence provider has loaded data from disk. |
| `isSynced` | `boolean` | True once a connection provider has synced with a backend. |
| `isSuggestionDoc` | `boolean` | Track changes mode — see below. |
| `cleanupFormatting` | `boolean` | Whether to auto-clean redundant formatting Items. Set to `!isSuggestionDoc`. |

---

## clientID — the Replica ID

```javascript
this.clientID = generateNewClientId()  // random.uint32()
```

A random 32-bit unsigned integer. This is the `client` field in every `{client, clock}` ID across the entire document.

**Conflict detection:** if two replicas somehow get the same `clientID` (astronomically unlikely but possible), the transaction cleanup detects it:

```javascript
if (!transaction.local && transaction.insertSet.clients.has(doc.clientID)) {
  logging.print('[yjs] Changed the client-id because another client seems to be using it.')
  doc.clientID = generateNewClientId()
}
```

When a remote update contains Items with our own `clientID`, we know a collision occurred. YJS regenerates `clientID` immediately. All future Items get a new ID. The old Items remain under the old ID permanently.

---

## The Promise API — `whenLoaded` / `whenSynced`

```javascript
this.whenLoaded = promise.create(resolve => {
  this.on('load', () => {
    this.isLoaded = true
    resolve(this)
  })
})
```

`doc.whenLoaded` is a Promise that resolves when a provider fires `doc.emit('load', [doc])`. Providers are supposed to emit this after restoring state from IndexedDB or receiving an initial sync from the server.

```javascript
const provideSyncedPromise = () => promise.create(resolve => {
  const eventHandler = (isSynced) => {
    if (isSynced === undefined || isSynced === true) {
      this.off('sync', eventHandler)
      resolve()
    }
  }
  this.on('sync', eventHandler)
})

this.on('sync', isSynced => {
  if (isSynced === false && this.isSynced) {
    this.whenSynced = provideSyncedPromise()  // recreate promise on disconnect
  }
  this.isSynced = isSynced === undefined || isSynced === true
  if (this.isSynced && !this.isLoaded) {
    this.emit('load', [this])   // sync implies load
  }
})
```

`doc.whenSynced` is a Promise that resolves when a provider emits `sync` with `true`. Crucially: **it recreates itself on disconnect**. If the connection drops (`sync` fires with `false`), `whenSynced` becomes a new unresolved Promise. Application code waiting on `whenSynced` will wait again until reconnection.

**The sync → load implication:** if a provider syncs successfully, it also implies the document is loaded. `isSynced = true` automatically fires `load` if not already loaded. This lets providers that only implement `sync` (not `load`) still work with `whenLoaded`.

---

## `get(key, name)` — the Unified Type Accessor

```javascript
get(key = '', name = null) {
  return map.setIfUndefined(this.share, key, () => {
    const t = new YType(name)
    t._integrate(this, null)
    return t
  })
}
```

This is the refactored unified accessor. In older YJS you'd call `doc.getText()`, `doc.getArray()`, `doc.getMap()`. Now there's one method: `doc.get(key, typeName)`.

`map.setIfUndefined` = get if exists, create if not. Multiple calls with the same key return the same instance — `doc.get('content') === doc.get('content')` is always true. This is critical: two replicas that call `doc.get('content')` independently end up with shared types that will converge through YATA.

`YType(name)` — `name` is the type name (e.g. `'Y.Text'`, `'Y.Map'`). The `YType` class is the new unified type (replacing separate `Y.Text`, `Y.Map`, `Y.Array` classes in this refactor).

---

## Subdocuments

Doc supports nesting — a Doc can be embedded inside another Doc's shared type.

```javascript
this.subdocs = new Set()
this._item = null      // non-null when this Doc is a subdocument
```

When a subdocument is embedded, its Doc instance is stored as a `ContentDoc` inside an Item. The embedded Doc's `_item` points to that Item.

```javascript
load() {
  const item = this._item
  if (item !== null && !this.shouldLoad) {
    transact(item.parent.doc, transaction => {
      transaction.subdocsLoaded.add(this)
    }, null, true)
  }
  this.shouldLoad = true
}
```

`doc.load()` requests that providers load this subdocument. By default (`autoLoad = false`), subdocuments are lazy — they exist as references but their content isn't synced until explicitly loaded. Calling `load()` signals providers to start syncing this subdoc.

The `subdocs` event fires when subdocs are added, removed, or loaded:
```javascript
doc.on('subdocs', ({ loaded, added, removed }) => { ... })
```

---

## `transact(f, origin)`

```javascript
transact(f, origin = null) {
  return transact(this, f, origin)
}
```

Thin wrapper over the `transact` function in Transaction.js. Groups changes into one atomic operation — one observer call, one update blob, one network message.

```javascript
// Without transaction: 2 observer calls, 2 network messages
ymap.set('a', 1)
ymap.set('b', 2)

// With transaction: 1 observer call, 1 network message
doc.transact(() => {
  ymap.set('a', 1)
  ymap.set('b', 2)
})
```

`origin` tags the transaction. Providers use this to avoid re-applying their own updates:
```javascript
doc.on('update', (update, origin) => {
  if (origin !== wsProvider) {  // don't re-broadcast what we received
    wsProvider.send(update)
  }
})
```

---

## The Event Lifecycle

Doc emits these events in order during a transaction:

```
beforeAllTransactions   — fires once before the first transaction in a batch
beforeTransaction       — fires before each transaction
  [transaction runs]
beforeObserverCalls     — fires before observers are called
  [observers fire]
afterTransaction        — fires after observers
  [formatting cleanup, GC, merge]
afterTransactionCleanup — fires after GC/merge
  [update blob encoded]
'update' / 'updateV2'  — providers receive the binary blob HERE
  [subdoc events]
afterAllTransactions    — fires once after all transactions in the batch complete
```

Providers listen to `'update'`. That's where they get the binary blob to broadcast or persist.

---

## `isSuggestionDoc` — Track Changes Mode

```javascript
this.isSuggestionDoc = isSuggestionDoc
this.cleanupFormatting = !isSuggestionDoc
```

New in the refactor. When `isSuggestionDoc = true`:
- The document is in "suggestion mode" — changes are suggestions, not final edits
- Formatting cleanup is disabled (`cleanupFormatting = false`) — redundant format Items are kept as part of the suggestion record

This enables track-changes / suggesting-mode editing without a separate document type.

---

## Key Takeaways

1. **Doc owns everything.** StructStore lives on `doc.store`. All shared types live in `doc.share`. All transactions live on `doc._transaction`. Doc is the root.

2. **`clientID` = replica ID.** Random uint32, one per Doc instance. Every Item created by this replica carries this ID. Collision detection regenerates it automatically.

3. **`whenLoaded` / `whenSynced` are promises, not events.** Application code can `await doc.whenLoaded` instead of `doc.on('load', ...)`. `whenSynced` recreates itself on disconnect — clean handling of reconnection.

4. **`get(key)` is idempotent.** Same key always returns the same type instance. This is how two replicas converge — they both `get('content')` and the CRDT does the rest.

5. **Providers receive the update blob via `doc.on('update', ...)`**, which fires inside `cleanupTransactions` after GC and merging are done. The blob is already compressed and ready to send.

6. **`isSuggestionDoc` enables track changes** — a new mode where edits are suggestions, not commits.
