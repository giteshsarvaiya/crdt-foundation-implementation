# YJS — Source Study Index

Working through the YJS source to close the loop from CRDT theory to production code.
Notes, annotations, doubts, and contribution candidates tracked per file.

→ [Main README](../README.md) | → [Study Roadmap](../STUDY_ROADMAP.md) | → [Progress](../PROGRESS.md) | → [Q&A](./QA.md)

---

## Folder Structure

```
yjs-learning/
├── README.md                  ← this file — index and theory→code map
├── QA.md                      ← general questions and answers about YJS
├── Item/
│   ├── README.md              ← Item.js annotated line by line (YATA lives here)
│   └── improvements.md        ← bugs, suggestions, open questions
├── StructStore/
│   ├── README.md
│   └── improvements.md
├── DeleteSet/
│   ├── README.md              ← original DeleteSet (replaced in refactor)
│   └── improvements.md
├── AbstractType/
│   ├── README.md
│   └── improvements.md
├── Doc/
│   ├── README.md
│   └── improvements.md
├── Transaction/
│   ├── README.md
│   └── improvements.md
├── IdSet/
│   ├── README.md              ← DeleteSet replacement with diff/intersection/slice
│   └── improvements.md
└── BlockSet/
    ├── README.md              ← network-layer struct container
    └── improvements.md
```

---

## Reading Order

| # | Folder | Source file | Status |
|---|--------|-------------|--------|
| 1 | [Item/](./Item/README.md) | `src/structs/Item.js` | done |
| 2 | [StructStore/](./StructStore/README.md) | `src/utils/StructStore.js` | done |
| 3 | [DeleteSet/](./DeleteSet/README.md) | `src/utils/DeleteSet.js` (original, replaced) | done |
| 4 | [AbstractType/](./AbstractType/README.md) | `src/types/AbstractType.js` | done |
| 5 | [Doc/](./Doc/README.md) | `src/utils/Doc.js` | done |
| 6 | [Transaction/](./Transaction/README.md) | `src/utils/Transaction.js` | done |
| 7 | [IdSet/](./IdSet/README.md) | `src/utils/IdSet.js` (DeleteSet replacement) | done |
| 8 | [BlockSet/](./BlockSet/README.md) | `src/utils/BlockSet.js` (network layer) | done |

---

## Theory → YJS Mapping

| Our Implementation | YJS Equivalent | Where |
|---|---|---|
| G-Counter vector | State vector `Map<clientId, clock>` | `StructStore.ts` |
| 2P-Set tombstone set `R` | `DeleteSet` | `DeleteSet.ts` |
| LWW-Register timestamp + tiebreaker | Lamport clock + clientId on `Y.Map` key writes | `AbstractType.ts` |
| OR-Set unique tag `(element, tag)` | `Item` with `{client, clock}` ID | `Item.ts` |
| MV-Register concurrent value set | Why Y.Map uses LWW — surfacing conflicts is too noisy | — |
| Op-LWW `write() → op → apply()` | YJS insert: atSource → Update → `applyUpdate()` | `Item.ts` |
| Op-OR-Set add/remove ops | YJS insert/delete — no accumulating tombstone content | `Item.ts` |
| RGA linked list + timestamp ordering | YATA `integrate()` — same loop, adds `rightOrigin` check | `Item.ts` |

---

## Project — Collaborative Markdown Editor

*(To be started after source reading)*

**Stack:** YJS + y-webrtc + y-indexeddb + Tiptap or CodeMirror

| Feature | YJS concept | Status |
|---|---|---|
| Collaborative text editing | Y.Text + YATA insert | [ ] |
| Formatting / marks | Y.Map on text ranges | [ ] |
| Presence / cursors | Awareness protocol | [ ] |
| Offline sync | Provider + state vector exchange | [ ] |
| Persistence | y-indexeddb | [ ] |
| Two tabs as two replicas | y-webrtc | [ ] |

Build log goes in this file under a **Build Log** section as the project progresses.
