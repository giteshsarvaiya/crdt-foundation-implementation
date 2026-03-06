# 2P-Set (Two-Phase Set)

**Type:** State-based (CvRDT) | **Paper spec:** 8–10 (Set family)

→ [Back to main README](../README.md)

---

## What it is

A set that supports both add and remove, using two internal G-Sets: `A` (added) and `R` (removed/tombstones). An element is "in" the set if it's in `A` but not in `R`. Once an element enters `R`, it can never come back — remove wins permanently.

```
add("a")    → A={a}, R={}    → "a" is IN the set
remove("a") → A={a}, R={a}   → "a" is NOT in the set
add("a")    → A={a}, R={a}   → still NOT in the set  ← remove wins forever
```

Merge = union of both `A` sets + union of both `R` sets.

## What it teaches

- **Tombstoning** — deletions are marked, not erased. The removed element stays in `A` forever, but `R` blocks it from `lookup()`. This is how most CRDTs handle deletion — you cannot truly erase distributed data without coordination.
- **Preconditions on updates** — `remove()` can only run if the element is currently in the set. This is the first CRDT where an operation isn't always enabled.
- **Remove-wins semantics** — when a concurrent add and remove happen, remove always wins. This is a deliberate design choice, not a bug.

## Files

| File | Purpose |
|---|---|
| `implementation.ts` | TwoPhaseSet class |
| `implementation.test.ts` | Tests: operations, convergence, merge laws |

---

## Drawbacks

### 1. Once removed, always removed — cannot re-add

The most significant limitation. If a user is removed from a group, they can never be re-added. If a task is deleted, it cannot be restored. `R` only grows — it never shrinks.

**Solution:** OR-Set (what we implemented next). Instead of blocking the element itself, OR-Set uses unique tags per add. A new add gets a new tag that has never been tombstoned, so it survives.

### 2. Tombstone set grows forever

Every `remove()` adds to `R` permanently. Elements that were added and removed years ago still sit in `R`, consuming memory and storage.

**Solution:** There is no clean solution within the CRDT model. To garbage-collect a tombstone, you need to know every replica has received it — which requires coordination (a protocol called "stable causal garbage collection"). This is what YJS handles separately with its snapshot and GC mechanism.

### 3. Remove-wins is hardcoded — cannot choose add-wins

When two replicas concurrently add and remove the same element, remove always wins. There is no configuration to flip this.

**Solution:** If you need add-wins semantics, use OR-Set instead. OR-Set's concurrent add survives a concurrent remove. The choice between 2P-Set and OR-Set is a domain decision: what should win when two users disagree concurrently?

### 4. Elements must be unique values

2P-Set assumes each element appears at most once in `A`. If you add the same element twice (e.g. the string `"task-1"` twice), the second add is a no-op — sets don't have duplicates. This means two logically different "task-1"s cannot coexist.

**Solution:** Wrap elements in unique IDs before storing. E.g. store `{id: uuid(), value: "task-1"}` instead of `"task-1"`. OR-Set does this automatically with its tag system.

---

## Bridge to YJS

YJS's **delete set** is a tombstone set — exactly like `R` in 2P-Set. When you delete a character in a YJS document, its `Item` is not removed from the linked list. Instead it's marked as deleted. The delete set tracks which `Item` IDs have been tombstoned. On merge, delete sets are unioned — same as `R` in 2P-Set.
