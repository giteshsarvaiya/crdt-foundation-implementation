# Doc.js — Improvements, Doubts & Open Questions

→ [Back to Doc notes](./README.md)

---

## Doubts and Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | `whenSynced` recreates itself when `sync` fires with `false`. But if a provider never fires `sync` at all, `whenSynced` never resolves. Is there a timeout or fallback? | open |
| 2 | `clientID` conflict detection regenerates the ID when a remote update contains our clientID. But old Items already stored under the old clientID stay there permanently. Does this mean the StructStore can have two client arrays for the "same" client after a collision? | open |
| 3 | `doc.get(key, name)` creates a `YType(name)` if the key doesn't exist. What happens if two replicas call `doc.get('content', 'Y.Text')` and `doc.get('content', 'Y.Map')` with different type names? Does the type name affect CRDT semantics, or is it just metadata? | open |
| 4 | `destroy()` creates a new Doc to replace the destroyed subdoc's content reference. Why does a destroyed subdoc need a replacement Doc at all? | open |
| 5 | `isSuggestionDoc` disables formatting cleanup. But what happens when a suggestion doc is merged into a regular doc — how are the retained formatting Items resolved? | open |
