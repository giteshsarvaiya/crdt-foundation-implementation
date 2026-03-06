import { describe, it, expect } from "vitest";
import { GCounter } from "./implementation";

// Tests are grouped into four categories:
//
//  1. Basic operations  — does the counter behave correctly in isolation?
//  2. Convergence       — do replicas reach the same state after merging?
//  3. Merge laws        — do the three mathematical guarantees hold?
//  4. Dynamic replicas  — can new replicas join without coordination?
//     (This was a drawback of the fixed-array version. The Map version fixes it.)

// =============================================================================
// Category 1 — Basic operations
// =============================================================================

describe("GCounter - basic operations", () => {
  it("starts at zero", () => {
    const c = new GCounter(0);
    expect(c.value()).toBe(0);
  });

  it("increments this replica's own entry", () => {
    // Replica 0 increments twice — only its own entry grows.
    const c = new GCounter(0);
    c.increment();
    c.increment();
    expect(c.value()).toBe(2);
  });

  it("two replicas track independent counts", () => {
    const a = new GCounter(0);
    a.increment();
    a.increment(); // a contributes 2

    const b = new GCounter(1);
    b.increment();  // b contributes 1

    // After merge: value = 2 + 1 = 3
    expect(a.merge(b).value()).toBe(3);
  });
});

// =============================================================================
// Category 2 — Convergence
// Two replicas diverge, then merge. Order of merge must not matter.
// =============================================================================

describe("GCounter - convergence", () => {
  it("two replicas merging in any order produce the same value", () => {
    const a = new GCounter(0);
    a.increment();
    a.increment(); // a: {0→2}

    const b = new GCounter(1);
    b.increment(); // b: {1→1}

    const m1 = a.merge(b); // a absorbs b → {0→2, 1→1}
    const m2 = b.merge(a); // b absorbs a → {0→2, 1→1}

    expect(m1.value()).toBe(m2.value());
    expect(m1.value()).toBe(3);
  });

  it("replica that starts from another's state then diverges: both views merge correctly", () => {
    // B starts from A's state (like syncing from a peer), then both increment independently
    const a = new GCounter(0);
    a.increment(); // a: {0→1}

    const b = a.clone(1); // b starts from a's state, but is replica 1
    b.increment(); // b: {0→1, 1→1}
    a.increment(); // a: {0→2}      (concurrent with b's increment)

    // Both views should merge to {0→2, 1→1} = 3
    expect(a.merge(b).value()).toBe(3);
    expect(b.merge(a).value()).toBe(3);
  });
});

// =============================================================================
// Category 3 — Merge laws
// These three properties make merge a valid LUB (Least Upper Bound).
// =============================================================================

describe("GCounter - merge laws", () => {
  it("idempotent: merge(A, A) = A", () => {
    // Receiving the same state twice must not change anything.
    const a = new GCounter(0);
    a.increment();
    expect(a.merge(a).value()).toBe(a.value());
  });

  it("commutative: merge(A, B) = merge(B, A)", () => {
    // Order of arrival over the network must not affect the result.
    const a = new GCounter(0);
    a.increment();

    const b = new GCounter(1);
    b.increment();

    expect(a.merge(b).value()).toBe(b.merge(a).value());
  });

  it("associative: merge(A, merge(B,C)) = merge(merge(A,B), C)", () => {
    // Which replica merges with which first must not matter.
    const a = new GCounter(0);
    a.increment();

    const b = new GCounter(1);
    b.increment();

    const c = new GCounter(2);
    c.increment();

    const left  = a.merge(b.merge(c));
    const right = a.merge(b).merge(c);

    expect(left.value()).toBe(right.value());
  });
});

// =============================================================================
// Category 4 — Dynamic replicas
// New replicas can join at any time without coordination or resizing.
// This was the key drawback of the fixed-array version — now fixed.
// This is how YJS's state vector works: Map<clientId, clock>.
// =============================================================================

describe("GCounter - dynamic replicas (Map-based)", () => {
  it("a new replica joining later merges correctly with existing replicas", () => {
    // Replicas 0 and 1 have been running for a while
    const a = new GCounter(0);
    a.increment();
    a.increment(); // a: {0→2}

    const b = new GCounter(1);
    b.increment(); // b: {1→1}

    // Replica 2 joins later — it doesn't need to know about the old replica count
    const c = new GCounter(2);
    c.increment();
    c.increment();
    c.increment(); // c: {2→3}

    // All three merge correctly without any pre-coordination
    const merged = a.merge(b).merge(c);
    expect(merged.value()).toBe(6); // 2 + 1 + 3
  });

  it("a replica with no increments yet contributes 0 — no entry in Map", () => {
    // Absent key = 0. A brand-new replica doesn't bloat the Map.
    const a = new GCounter(0);
    a.increment(); // a: {0→1}

    const b = new GCounter(1); // b hasn't incremented yet — empty Map

    const merged = a.merge(b);
    expect(merged.value()).toBe(1); // only a's contribution
  });

  it("compare() works across replicas with different key sets", () => {
    // a has seen replica 0's contributions. b has seen both 0 and 1.
    const a = new GCounter(0);
    a.increment(); // a: {0→1}

    const b = a.clone(1);
    b.increment(); // b: {0→1, 1→1} — b has seen more

    // a <= b: a has only seen {0→1}, b has seen {0→1} and more
    expect(a.compare(b)).toBe(true);
    // b <= a: false — b has {1→1} which a doesn't have
    expect(b.compare(a)).toBe(false);
  });

  it("simulates YJS state vector exchange: find what ops a peer is missing", () => {
    // This is exactly what happens when two YJS peers connect:
    //   1. Exchange state vectors (G-Counters)
    //   2. For each clientId, find which replica has seen more
    //   3. The one that's behind is missing those ops — retransmit them
    const peerA = new GCounter(0);
    peerA.increment();
    peerA.increment(); // peerA: {0→2}

    const peerB = new GCounter(1);
    peerB.increment();
    // peerB has also seen one of peerA's ops:
    const peerBWithA = peerB.merge(peerA.clone()); // peerB: {0→2, 1→1}
    // But peerA hasn't seen peerB's op yet

    // peerA.compare(peerBWithA): is peerA <= peerBWithA?
    // peerA has {0→2}. peerBWithA has {0→2, 1→1}.
    // All of peerA's keys are <= peerBWithA's — yes, peerA is behind (missing {1→1})
    expect(peerA.compare(peerBWithA)).toBe(true);

    // peerBWithA.compare(peerA): is peerBWithA <= peerA?
    // peerBWithA has {1→1} which peerA doesn't — no, peerA is missing things
    expect(peerBWithA.compare(peerA)).toBe(false);
  });
});
