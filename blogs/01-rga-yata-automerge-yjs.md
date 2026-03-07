# RGA vs YATA vs Automerge vs Yjs — Untangled

> These four names get thrown around together constantly. By the end of this post, you'll know exactly what each one is, how they relate, and why they're always compared.

---

## The confusion in one sentence

People mix these up because **two are algorithms** and **two are libraries** — and each library is built on one of the algorithms. Once you see that, everything clicks.

```
RGA (algorithm)   →  used by  →  Automerge (library)
YATA (algorithm)  →  used by  →  Yjs (library)
```

That's the whole map. Now let's understand each piece.

---

## The problem they all solve

Imagine two people editing the same document simultaneously — offline, on different devices.

Alice types "Hello" at position 0.
Bob types "World" at position 0 at the same time.

When they sync, what should the document say? `HelloWorld`? `WorldHello`? `HWeolrllod` (interleaved chaos)?

This is the **concurrent insert problem**. RGA and YATA are two different answers to it.

---

## RGA — Replicated Growable Array

**Paper:** Roh et al., 2011

RGA is a CRDT algorithm for ordered sequences (lists, text). Here's the core idea:

- Every inserted character gets a **unique timestamp** (a Lamport clock value).
- Characters are stored as a **linked list**, not by index.
- When two characters are inserted at the same position concurrently, the one with the **higher timestamp goes to the left** (wins the position).
- Deleted characters are never removed — they become **tombstones** (marked deleted, but still in the list to preserve ordering).

### How RGA resolves a conflict

Alice inserts `A` at position 3, timestamp = 5.
Bob inserts `B` at position 3, timestamp = 3.

When they sync: Alice's `A` wins — it goes left of Bob's `B` because `5 > 3`.

Both replicas converge to the same order. Every time.

### The weakness of RGA

If Alice types `AA` and Bob types `BB` at the same position simultaneously, RGA might interleave them:

```
Result: A B A B   ← wrong, not what either person intended
```

This happens because RGA only looks at the **left neighbor** when deciding where to insert.

---

## YATA — Yet Another Transformation Approach

**Paper:** Nicolaescu et al., 2016 (used in Yjs)

YATA is also a sequence CRDT, and it fixes RGA's interleaving problem with one key addition:

- Each insert records **both its left neighbor AND its right neighbor** at the time of insertion.
- During conflict resolution, YATA uses the right neighbor (`rightOrigin`) to detect when a new insert would cut through a sequence that was typed as a unit.

### How YATA resolves the same conflict

Alice types `AA` — each character records `leftOrigin` and `rightOrigin`.
Bob types `BB` — same.

When they sync, YATA's `integrate()` logic detects that Alice's characters were inserted as a contiguous block, and Bob's were too. It keeps them grouped:

```
Result: AABB  or  BBAA   ← always grouped, never interleaved
```

Which group comes first depends on client ID tiebreaking, but crucially **no interleaving**.

### YATA vs RGA — the one-line difference

| | Looks at on insert |
|---|---|
| RGA | left neighbor only (`origin`) |
| YATA | left neighbor + right neighbor (`origin` + `rightOrigin`) |

That extra reference is what prevents interleaving.

---

## Automerge — The Library Built on RGA

Automerge is a JavaScript/Rust library that gives you a **collaborative document** (like a JSON object) where all fields, lists, and text are CRDTs under the hood.

- Lists and text use **RGA** for ordering.
- Maps use **Last-Write-Wins** for key conflicts.
- The API hides all the CRDT complexity — you just mutate objects normally.

### What Automerge gives you

```js
const doc = Automerge.init()
const doc2 = Automerge.change(doc, d => {
  d.text = new Automerge.Text()
  d.text.insertAt(0, 'H', 'e', 'l', 'l', 'o')
})

// Merge with another replica — convergence guaranteed
const merged = Automerge.merge(doc2, otherDoc)
```

You get convergence without thinking about timestamps or linked lists.

**Automerge v2** (rewritten in Rust) dramatically improved performance. The original JS version was notoriously slow for large documents.

---

## Yjs — The Library Built on YATA

Yjs is also a collaborative document library, but uses **YATA** internally (via its `Item.integrate()` method).

- Shared types: `Y.Text`, `Y.Map`, `Y.Array`, `Y.XmlFragment`
- Sync providers: `y-websocket`, `y-webrtc`, `y-indexeddb`
- Editor bindings: CodeMirror, ProseMirror, Monaco, TipTap, Quill

### What Yjs gives you

```js
const ydoc = new Y.Doc()
const ytext = ydoc.getText('my-text')

ytext.insert(0, 'Hello')

// On another peer:
ytext.insert(0, 'World')

// After sync — both converge to the same string, no interleaving
```

---

## Side-by-side comparison

| | RGA | YATA | Automerge | Yjs |
|---|---|---|---|---|
| **What is it?** | Algorithm | Algorithm | Library | Library |
| **Data structure** | Linked list + timestamps | Linked list + left+right origins | Full document model | Shared types |
| **Conflict resolution** | Higher timestamp wins | Origin-based, prevents interleaving | RGA for sequences | YATA for sequences |
| **Interleaving** | Can happen | Prevented | Can happen (uses RGA) | Prevented (uses YATA) |
| **Performance** | Baseline | Faster (less scanning) | v1: slow, v2: fast | Generally faster |
| **Ecosystem** | Research | Research / Yjs | JS + Rust | JS, strong provider ecosystem |
| **Deletions** | Tombstones | Tombstones | Tombstones | Tombstones (compressed in DeleteSet) |

---

## Which one should you use?

**For a new project:** Yjs if you want a mature ecosystem with many editor bindings. Automerge v2 if you want Rust-grade performance or a Rust backend.

**For learning:** Study RGA first — it's simpler and the ideas map directly to YATA. Then read YATA to see exactly what the one extra field adds.

**For interleaving-sensitive applications** (collaborative code editing, structured documents): Prefer Yjs/YATA. Interleaved characters in code are a much bigger problem than in prose.

---

## The mental model to keep

```
┌─────────────────────────────────────────────────────┐
│                    The Family Tree                  │
│                                                     │
│   CRDT Sequence Problem                             │
│          │                                          │
│    ┌─────┴──────┐                                   │
│    │            │                                   │
│   RGA          YATA                                 │
│  (2011)       (2016)                                │
│    │            │                                   │
│ Automerge     Yjs                                   │
│ (library)   (library)                               │
└─────────────────────────────────────────────────────┘
```

Two algorithms. Two libraries. Each library wraps one algorithm.
The algorithms differ by one field on each insert. That field prevents interleaving.

Now you know.

---

*Part of the [crdt-foundation](../README.md) study project.*
