# YJS — Questions & Answers

Running log of questions that came up during source reading and study.
Add new questions at the bottom. Mark open ones clearly.

→ [Back to index](./README.md)

---

## Q1 — How does everything connect into one thing?

**Q:** I understand Item, StructStore, DeleteSet, AbstractType individually — but how do they all connect? What actually happens when I use Y.Text?

**A:** The full flow for a single keystroke:

```
User types 'a'
      ↓
Editor binding calls ytext.insert(cursor, 'a')
      ↓
YJS opens a Transaction
      ↓
typeListInsertGenericsAfter()        [AbstractType.js]
  → creates Item {client, clock}     the OR-Set unique tag
  → captures origin + rightOrigin    YATA's two anchors, frozen at insert time
  → item.integrate()                 [Item.js] YATA runs, finds correct position
  → item added to StructStore        [StructStore.js]
      ↓
Transaction commits
  → observers fire → editor UI updates
  → update encoded into binary blob
      ↓
doc.on('update', binaryBlob) fires
      ↓
Provider picks it up
  ├── y-indexeddb → saves to browser IndexedDB
  └── y-websocket → sends to relay server → server broadcasts to peers
                                                    ↓
                                         Peer receives blob
                                         Y.applyUpdate(doc, blob)
                                           → decode Items
                                           → getMissing() — causal delivery check
                                           → integrate() — YATA runs again
                                           → observers fire → peer UI updates
```

The server does not understand CRDTs. It is a dumb relay. All CRDT logic runs on the client.

---

## Q2 — Client side or server side?

**Q:** Should Y.Text and the document state live on the client or the server?

**A:** Client side. Always.

```
Client (browser)                    Server (y-websocket)
─────────────────                   ────────────────────
StructStore — all Items             update log — binary blobs only
DeleteSet — tombstones              no Items, no CRDT knowledge
YATA — integrate()                  relay updates to all peers
Y.Text / Y.Map / Y.Array            store snapshot for late joiners
IndexedDB — local persistence
```

The server (y-websocket) stores a log of binary update blobs so that a client joining late can replay history. It never parses Items or runs YATA. You can skip the server entirely with y-webrtc (peer-to-peer).

---

## Q3 — How do providers connect to the document?

**Q:** How do y-websocket and y-indexeddb actually plug into YJS?

**A:** Providers are thin wrappers over two doc events:

```javascript
const doc = new Y.Doc()

// Provider internally does:
doc.on('update', (update, origin) => {
  // save or send the binary blob
})

// And when they receive data from the network/disk:
Y.applyUpdate(doc, incomingBlob)
```

That's it. A provider is just: emit updates when the doc changes, apply updates when data arrives. The binary blob contains new Items + DeleteSet entries encoded as varints — the same format we saw in `writeDeleteSet`.

---

## Q4 — Do we need to read more source files?

**Q:** Are the 4 files we read (Item, StructStore, DeleteSet, AbstractType) enough, or is there more?

**A:** Two more files close the remaining gap:

| File | What it explains |
|---|---|
| `src/utils/Doc.js` | Root object. How transactions are opened/committed. How `doc.on('update')` fires. How `clientID` is assigned. How `getText()` creates/retrieves types. |
| `src/utils/Transaction.js` | What happens at transaction commit — observer order, how the update binary blob is built, how DeleteSet is finalized. |

These explain the runtime wiring. Everything else (Y.Text, Y.Array, Y.Map concrete classes, providers) can be understood from the API docs + the foundation we've built.

---

## Q5 — Should I read more source before building?

**Q:** Should I keep reading source or start building?

**A:** Read Doc.js and Transaction.js first (they close the "how it wires together" gap), then build. Don't read the provider source — understand them from the API. The remaining source (Y.Text, Y.Array, encoding details) is better understood by hitting a problem while building than by reading upfront.

---

*Add new questions below as they come up.*
