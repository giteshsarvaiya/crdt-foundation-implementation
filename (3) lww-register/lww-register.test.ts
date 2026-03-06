import { describe, it, expect } from "vitest";
import { LWWRegister } from "./implementation";

// Tests are grouped into four categories:
//
//  1. Basic operations  — does read/write behave correctly in isolation?
//  2. Tiebreaker        — what happens when two replicas have the same timestamp?
//  3. Convergence       — when replicas diverge and merge, does the higher timestamp win?
//  4. Merge laws        — are the three mathematical guarantees satisfied?

// =============================================================================
// Category 1 — Basic operations
// constructor signature: new LWWRegister(value, replicaId, timestamp?)
// =============================================================================

describe("LWWRegister - basic operations", () => {
  it("read returns the initial value", () => {
    const r = new LWWRegister("hello", 0, 0);
    expect(r.read()).toBe("hello");
  });

  it("write updates the value when timestamp is newer", () => {
    const r = new LWWRegister("hello", 0, 1);
    r.write("world", 2); // t=2 > t=1, so this write wins
    expect(r.read()).toBe("world");
  });

  it("write is ignored when timestamp is older", () => {
    const r = new LWWRegister("hello", 0, 10);
    r.write("world", 5); // t=5 < t=10, so this write is discarded
    expect(r.read()).toBe("hello");
  });

  it("write is ignored when timestamp is equal", () => {
    const r = new LWWRegister("hello", 0, 5);
    r.write("world", 5);
    expect(r.read()).toBe("hello");
  });

  it("works with number values", () => {
    const r = new LWWRegister(42, 0, 1);
    r.write(99, 2);
    expect(r.read()).toBe(99);
  });
});

// =============================================================================
// Category 2 — Tiebreaker
//
// The problem: wall clocks on different machines can tick at the same millisecond.
// If two replicas write at t=5, a naive "keep existing" rule breaks commutativity:
//
//   A merges B → A thinks it is "existing" → keeps "alice"
//   B merges A → B thinks it is "existing" → keeps "bob"
//   merge(A,B) ≠ merge(B,A) → replicas diverge permanently
//
// The fix: when timestamps tie, the higher replicaId wins.
// Both replicas see the same two IDs and always pick the same winner.
// =============================================================================

describe("LWWRegister - tiebreaker (same timestamp, different replicaIds)", () => {
  it("without a tiebreaker, same-timestamp merge would diverge", () => {
    // This test documents WHY the tiebreaker exists.
    // Imagine our old implementation had no replicaId — "keep existing" on tie.
    //
    //   A = ("alice", t=5) — A thinks it is "existing", keeps "alice"
    //   B = ("bob",   t=5) — B thinks it is "existing", keeps "bob"
    //
    //   merge(A,B) would = "alice"
    //   merge(B,A) would = "bob"
    //   → permanently diverged, commutativity broken
    //
    // With replicaId as tiebreaker, both replicas look at the same IDs
    // and always pick the same winner — convergence restored.

    const a = new LWWRegister("alice", 0, 5); // replicaId=0
    const b = new LWWRegister("bob",   1, 5); // replicaId=1, same timestamp t=5

    const m1 = a.merge(b); // A's perspective
    const m2 = b.merge(a); // B's perspective

    // replicaId 1 > 0, so "bob" wins on both sides
    expect(m1.read()).toBe("bob");
    expect(m2.read()).toBe("bob");
    expect(m1.read()).toBe(m2.read()); // ✓ converged
  });

  it("higher replicaId wins on timestamp tie, regardless of merge order", () => {
    const a = new LWWRegister("value-from-A", 0, 10); // replicaId=0
    const b = new LWWRegister("value-from-B", 3, 10); // replicaId=3, same t=10

    expect(a.merge(b).read()).toBe("value-from-B"); // replicaId 3 > 0
    expect(b.merge(a).read()).toBe("value-from-B"); // same result from both sides
  });

  it("timestamp still takes priority over replicaId", () => {
    // Even if A has a higher replicaId, B's newer timestamp wins outright.
    const a = new LWWRegister("value-from-A", 99, 5); // replicaId=99 but t=5
    const b = new LWWRegister("value-from-B",  0, 10); // replicaId=0 but t=10

    expect(a.merge(b).read()).toBe("value-from-B"); // t=10 beats t=5
    expect(b.merge(a).read()).toBe("value-from-B"); // same from both sides
  });
});

// =============================================================================
// Category 3 — Convergence
// The defining behavior of LWW-Register: when two replicas write concurrently,
// the one with the higher timestamp wins after merge — on both replicas.
// =============================================================================

describe("LWWRegister - convergence", () => {
  it("higher timestamp wins regardless of merge order", () => {
    const base = new LWWRegister("initial", 0, 0);

    const a = base.clone();
    a.write("from-A", 10); // replica A writes at t=10

    const b = base.clone();
    b.write("from-B", 20); // replica B writes at t=20 (later)

    const m1 = a.merge(b); // A's perspective: sees B's newer write
    const m2 = b.merge(a); // B's perspective: already has the newer write

    expect(m1.read()).toBe("from-B"); // t=20 wins
    expect(m2.read()).toBe("from-B"); // t=20 wins
    expect(m1.read()).toBe(m2.read()); // both agree
  });

  it("the losing write is silently discarded — this is the LWW tradeoff", () => {
    // This test documents the known limitation of LWW-Register.
    // Replica A's write at t=10 is completely gone after merge.
    // There is no way to recover it. This is intentional — and the reason
    // OR-Set was invented for sets (to avoid this kind of data loss).
    const a = new LWWRegister("important-data", 0, 10);
    const b = new LWWRegister("other-data",     1, 20);

    const merged = a.merge(b);
    expect(merged.read()).toBe("other-data");
    // "important-data" is gone — LWW discards the loser unconditionally
  });
});

// =============================================================================
// Category 4 — Merge laws
// These three properties make merge a valid LUB (Least Upper Bound),
// which is what guarantees Strong Eventual Consistency.
// =============================================================================

describe("LWWRegister - merge laws", () => {
  it("merge is idempotent: merge(A, A) = A", () => {
    // Receiving the same state twice must not change anything.
    const a = new LWWRegister("hello", 0, 5);
    expect(a.merge(a).read()).toBe(a.read());
  });

  it("merge is commutative: merge(A, B) = merge(B, A)", () => {
    // The order replicas receive each other's state must not matter.
    const a = new LWWRegister("from-A", 0, 10);
    const b = new LWWRegister("from-B", 1, 20);

    expect(a.merge(b).read()).toBe(b.merge(a).read());
  });

  it("merge is commutative even on timestamp tie (tiebreaker holds)", () => {
    // The critical commutativity check — this would fail without replicaId.
    const a = new LWWRegister("from-A", 0, 5);
    const b = new LWWRegister("from-B", 1, 5); // same timestamp

    expect(a.merge(b).read()).toBe(b.merge(a).read());
  });

  it("merge is associative: merge(A, merge(B,C)) = merge(merge(A,B), C)", () => {
    // Whether A merges B first or C first must not affect the outcome.
    const a = new LWWRegister("from-A", 0, 5);
    const b = new LWWRegister("from-B", 1, 15);
    const c = new LWWRegister("from-C", 2, 25); // highest timestamp

    const left  = a.merge(b.merge(c));
    const right = a.merge(b).merge(c);

    expect(left.read()).toBe(right.read()); // both should be "from-C"
  });
});
