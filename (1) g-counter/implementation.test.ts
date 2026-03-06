import { describe, it, expect } from "vitest";
import { GCounter } from "./implementation";

// Tests are grouped into three categories:
//
//  1. Basic operations — does the counter behave correctly in isolation?
//  2. Convergence     — do replicas reach the same state after merging?
//  3. Merge laws      — do the three mathematical guarantees hold?
//
// Passing all three means GCounter is a valid CvRDT.

// =============================================================================
// Category 1 — Basic operations
// Does increment and value actually work as expected on a single counter?
// =============================================================================

describe("GCounter - basic operations", () => {
  it("starts at zero", () => {
    // A fresh counter with 3 replica slots should report value 0.
    // Verifies that the initial state (all zeros) is correctly set up.
    const c = new GCounter(3);
    expect(c.value()).toBe(0);
  });

  it("increments the correct replica's slot", () => {
    // Replica 0 increments twice, replica 1 once, replica 2 never.
    // payload becomes [2, 1, 0] → value = sum = 3.
    const c = new GCounter(3);
    c.increment(0);
    c.increment(0);
    c.increment(1);
    expect(c.value()).toBe(3); // 2 + 1 + 0
  });
});

// =============================================================================
// Category 2 — Convergence
// Two replicas diverge (do operations independently), then merge.
// No matter the order of merge, they must reach the same final value.
// This is the core promise of a CRDT.
// =============================================================================

describe("GCounter - convergence", () => {
  it("two replicas merging in any order produce the same value", () => {
    // Both replicas start from the same base state (all zeros).
    const base = new GCounter(3);

    // Replica A and B diverge — neither knows what the other did.
    const a = base.clone();
    a.increment(0); // replica 0 increments twice
    a.increment(0); // payload: [2, 0, 0]

    const b = base.clone();
    b.increment(1); // replica 1 increments once
    // payload: [0, 1, 0]

    // Merge in both orders — both must produce the same result.
    const m1 = a.merge(b); // A's perspective absorbs B → [2, 1, 0]
    const m2 = b.merge(a); // B's perspective absorbs A → [2, 1, 0]

    expect(m1.value()).toBe(m2.value()); // commutativity of merge
    expect(m1.value()).toBe(3);          // 2 + 1 + 0
  });
});

// =============================================================================
// Category 3 — Merge laws
// These three properties are what make merge a valid LUB (Least Upper Bound).
// Together they guarantee that no matter how/when replicas sync, they converge.
// =============================================================================

describe("GCounter - merge laws", () => {
  it("merge is idempotent: merge(A, A) = A", () => {
    // Receiving the same state twice must not change anything.
    // This protects against duplicate messages on the network.
    const a = new GCounter(3);
    a.increment(0);
    expect(a.merge(a).value()).toBe(a.value());
  });

  it("merge is commutative: merge(A, B) = merge(B, A)", () => {
    // The order states arrive over the network must not affect the result.
    // If A's state arrives before B's or vice versa, the outcome is identical.
    const a = new GCounter(3);
    a.increment(0);

    const b = new GCounter(3);
    b.increment(1);

    expect(a.merge(b).value()).toBe(b.merge(a).value());
  });

  it("merge is associative: merge(A, merge(B,C)) = merge(merge(A,B), C)", () => {
    // It doesn't matter which replica merges with which first.
    // Whether A merges B then C, or B merges C then A merges that — same result.
    // This protects against different merge orderings across the network.
    const a = new GCounter(3);
    a.increment(0);

    const b = new GCounter(3);
    b.increment(1);

    const c = new GCounter(3);
    c.increment(2);

    const left  = a.merge(b.merge(c)); // A merges (B already merged with C)
    const right = a.merge(b).merge(c); // (A already merged with B) merges C

    expect(left.value()).toBe(right.value());
  });
});
