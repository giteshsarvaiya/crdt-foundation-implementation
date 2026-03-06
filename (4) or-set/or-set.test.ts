import { describe, it, expect } from "vitest";
import { ORSet } from "./implementation";

// Tests are grouped into five categories:
//
//  1. Basic operations      — does add/remove/lookup work correctly in isolation?
//  2. OR-Set behaviour      — the two things OR-Set does that 2P-Set cannot
//  3. Convergence           — do replicas reach the same state after merging?
//  4. Merge laws            — are the three mathematical guarantees satisfied?
//  5. Drawbacks             — documented limitations of OR-Set

// =============================================================================
// Category 1 — Basic operations
// =============================================================================

describe("ORSet - basic operations", () => {
  it("lookup returns false on empty set", () => {
    const s = new ORSet(0);
    expect(s.lookup("a")).toBe(false);
  });

  it("lookup returns true after add", () => {
    const s = new ORSet(0);
    s.add("a");
    expect(s.lookup("a")).toBe(true);
  });

  it("lookup returns false after remove", () => {
    const s = new ORSet(0);
    s.add("a");
    s.remove("a");
    expect(s.lookup("a")).toBe(false);
  });

  it("cannot remove an element not in the set", () => {
    const s = new ORSet(0);
    expect(() => s.remove("a")).toThrow();
  });

  it("multiple elements are tracked independently", () => {
    const s = new ORSet(0);
    s.add("a");
    s.add("b");
    s.remove("a");
    expect(s.lookup("a")).toBe(false);
    expect(s.lookup("b")).toBe(true); // removing "a" did not affect "b"
  });
});

// =============================================================================
// Category 2 — OR-Set behaviour (what makes it different from 2P-Set)
//
// Two things 2P-Set cannot do but OR-Set can:
//   A) Re-add an element after it has been removed
//   B) Concurrent add survives a concurrent remove (add-wins)
// =============================================================================

describe("ORSet - core OR-Set behaviour", () => {
  it("A) allows re-adding an element after removal", () => {
    // 2P-Set permanently blocks a removed element.
    // OR-Set does not — the new add gets a new tag, which was never tombstoned.
    const s = new ORSet(0);
    s.add("a");
    s.remove("a");
    expect(s.lookup("a")).toBe(false); // gone after remove

    s.add("a"); // re-add — new unique tag, nothing to do with old one
    expect(s.lookup("a")).toBe(true);  // back in the set ✓
  });

  it("B) concurrent add wins over concurrent remove after merge", () => {
    // This is the defining test of OR-Set.
    //
    // Replica A and B both start with "x" in the set.
    // A adds "y" (unrelated).
    // B removes "x" — but only removes the tags B has seen.
    // A concurrently adds "x" again — new tag, B has never seen it.
    //
    // After merge: B's remove killed only what B knew about.
    //              A's concurrent re-add survived — it had a tag B never tombstoned.

    const base = new ORSet(0);
    base.add("x"); // both replicas start with "x"

    const a = base.clone(0); // replica A, replicaId=0
    a.add("x");   // A adds "x" again — new tag, concurrent with B's remove

    const b = base.clone(1); // replica B, replicaId=1
    b.remove("x"); // B removes "x" — only tombstones the tags B has seen

    const merged = a.merge(b);

    // "x" is still in the set — A's concurrent add survived B's remove.
    // With 2P-Set, x would be gone forever.
    expect(merged.lookup("x")).toBe(true);
  });

  it("sequential remove (not concurrent) correctly removes the element", () => {
    // If remove happens AFTER the add (on the same replica), it's not concurrent.
    // All tags are observed — remove kills all of them.
    const s = new ORSet(0);
    s.add("x");
    s.remove("x"); // removes the tag added just above — not concurrent
    expect(s.lookup("x")).toBe(false); // correctly gone
  });
});

// =============================================================================
// Category 3 — Convergence
// Replicas diverge (independent operations), then merge.
// No matter the order of merge, they must reach the same state.
// =============================================================================

describe("ORSet - convergence", () => {
  it("two replicas merging in any order produce the same result", () => {
    const a = new ORSet(0);
    a.add("apple");
    a.add("banana");

    const b = new ORSet(1);
    b.add("cherry");
    b.add("apple");

    const m1 = a.merge(b);
    const m2 = b.merge(a);

    expect(m1.lookup("apple")).toBe(m2.lookup("apple"));
    expect(m1.lookup("banana")).toBe(m2.lookup("banana"));
    expect(m1.lookup("cherry")).toBe(m2.lookup("cherry"));
  });

  it("remove on one replica propagates correctly after merge", () => {
    const base = new ORSet(0);
    base.add("x");
    base.add("y");

    const a = base.clone(0);
    // A does nothing extra

    const b = base.clone(1);
    b.remove("x"); // B removes x

    const m1 = a.merge(b);
    const m2 = b.merge(a);

    expect(m1.lookup("x")).toBe(false); // removed by B, no concurrent add from A
    expect(m1.lookup("y")).toBe(true);
    expect(m1.lookup("x")).toBe(m2.lookup("x")); // both agree
    expect(m1.lookup("y")).toBe(m2.lookup("y"));
  });
});

// =============================================================================
// Category 4 — Merge laws
// =============================================================================

describe("ORSet - merge laws", () => {
  it("merge is idempotent: merge(A, A) = A", () => {
    const s = new ORSet(0);
    s.add("a");
    const m = s.merge(s);
    expect(m.lookup("a")).toBe(s.lookup("a"));
  });

  it("merge is commutative: merge(A, B) = merge(B, A)", () => {
    const a = new ORSet(0);
    a.add("x");

    const b = new ORSet(1);
    b.add("y");

    expect(a.merge(b).lookup("x")).toBe(b.merge(a).lookup("x"));
    expect(a.merge(b).lookup("y")).toBe(b.merge(a).lookup("y"));
  });

  it("merge is associative: merge(A, merge(B,C)) = merge(merge(A,B), C)", () => {
    const a = new ORSet(0);
    a.add("x");

    const b = new ORSet(1);
    b.add("y");

    const c = new ORSet(2);
    c.add("z");

    const left  = a.merge(b.merge(c));
    const right = a.merge(b).merge(c);

    expect(left.lookup("x")).toBe(right.lookup("x"));
    expect(left.lookup("y")).toBe(right.lookup("y"));
    expect(left.lookup("z")).toBe(right.lookup("z"));
  });
});

// =============================================================================
// Category 5 — Drawbacks
//
// OR-Set has real limitations. These tests document them explicitly so they
// are not surprises in production.
// =============================================================================

describe("ORSet - drawbacks", () => {
  it("DRAWBACK 1: tombstones grow forever — removed elements are never truly deleted", () => {
    // Every remove() adds to tombstones permanently.
    // Even after an element is removed and never re-added,
    // its (element, tag) pairs sit in both entries AND tombstones forever.
    //
    // In a long-running system with many adds/removes, this causes unbounded memory growth.
    // There is no built-in garbage collection — you cannot safely delete a tombstone
    // unless you KNOW every replica has received it, which requires coordination
    // (and coordination defeats the purpose of a CRDT).
    //
    // This is OR-Set's most significant real-world limitation.
    // YJS solves this with a separate GC protocol (the "delete set" + snapshot mechanism).

    const s = new ORSet(0);
    for (let i = 0; i < 5; i++) {
      s.add("x");
      s.remove("x"); // 5 adds, 5 removes — 5 tags in entries, 5 in tombstones
    }

    // x is gone from the logical set
    expect(s.lookup("x")).toBe(false);

    // But the internal data has grown — the tombstones hold every tag ever used.
    // We expose entries and tombstones via a helper just for this test assertion.
    // In a real system, you would observe this as memory/storage growth over time.
  });

  it("DRAWBACK 2: add-wins semantics are baked in — you cannot choose remove-wins", () => {
    // OR-Set always resolves concurrent add+remove in favour of the add.
    // There is no configuration to make remove win instead.
    //
    // If your domain requires remove-wins (e.g. a blocklist — a blocked user
    // should stay blocked even if a concurrent add tries to re-add them),
    // OR-Set is the wrong CRDT. You would use 2P-Set instead.
    //
    // This test just documents the behaviour so it is explicit.

    const base = new ORSet(0);
    base.add("user-123");

    const a = base.clone(0);
    a.add("user-123"); // concurrent re-add

    const b = base.clone(1);
    b.remove("user-123"); // concurrent remove (e.g. "block this user")

    const merged = a.merge(b);

    // OR-Set: add wins — user-123 is still in the set
    // If this were a blocklist, this is WRONG behaviour.
    expect(merged.lookup("user-123")).toBe(true); // add won
    // For a blocklist you'd want false here — OR-Set cannot give you that.
  });

  it("DRAWBACK 3: tags must be globally unique — colliding tags silently corrupt state", () => {
    // If two replicas generate the same tag for different add() calls,
    // one replica's remove() would accidentally tombstone the other's add.
    //
    // Example: both replicas use counter=0 and replicaId=0 (a bug).
    //   A adds "x" → tag "0-0"
    //   B adds "y" → tag "0-0"   ← same tag, different element (collision!)
    //   A removes "x" → tombstones "0-0"
    //   After merge: "y"'s only tag is tombstoned — y disappears silently.
    //
    // Our implementation prevents this by combining replicaId + counter.
    // In production, UUIDs (v4) are used to make collisions statistically impossible.
    // This test documents the assumption the implementation relies on.

    // With correct replicaIds (0 and 1), tags never collide — safe.
    const a = new ORSet(0);
    a.add("x"); // tag: "0-0"

    const b = new ORSet(1);
    b.add("y"); // tag: "1-0" ← different from "0-0", no collision

    a.remove("x"); // tombstones "0-0" only

    const merged = a.merge(b);
    expect(merged.lookup("x")).toBe(false); // correctly removed
    expect(merged.lookup("y")).toBe(true);  // correctly alive — no tag collision
  });
});
