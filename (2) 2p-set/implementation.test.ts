import { describe, it, expect } from "vitest";
import { TwoPhaseSet } from "./implementation";
// Category 1 — Basic operations
describe("TwoPhaseSet - basic operations", () => {
  it("lookup returns false on empty set", () => {
    const s = new TwoPhaseSet();
    expect(s.lookup("a")).toBe(false);
  });

  it("lookup returns true after add", () => {
    const s = new TwoPhaseSet();
    s.add("a");
    expect(s.lookup("a")).toBe(true);
  });

  it("lookup returns false after remove", () => {
    const s = new TwoPhaseSet();
    s.add("a");
    s.remove("a");
    expect(s.lookup("a")).toBe(false);
  });

  it("cannot remove an element not in the set", () => {
    const s = new TwoPhaseSet();
    expect(() => s.remove("a")).toThrow();
  });

  it("remove wins — re-adding a removed element has no effect", () => {
    const s = new TwoPhaseSet();
    s.add("a");
    s.remove("a");
    s.add("a"); // try to bring it back
    expect(s.lookup("a")).toBe(false); // still gone
  });
});

// Category 2 — Convergence (the interesting one)

describe("TwoPhaseSet - convergence", () => {
  it("concurrent add and remove: remove wins after merge", () => {
    // This is the defining behavior of 2P-Set.
    // Replica A adds "x". Replica B removes "x" concurrently.
    // After merge — remove wins.
    const base = new TwoPhaseSet();
    base.add("x"); // both replicas start with "x" in the set

    const a = base.clone();
    a.add("y"); // replica A adds something else

    const b = base.clone();
    b.remove("x"); // replica B removes "x" concurrently

    const merged = a.merge(b);
    expect(merged.lookup("x")).toBe(false); // remove won
    expect(merged.lookup("y")).toBe(true); // add from A survived
  });

  it("merging in both orders gives same result", () => {
    const base = new TwoPhaseSet();
    base.add("a");

    const a = base.clone();
    a.add("b");

    const b = base.clone();
    b.remove("a");

    const m1 = a.merge(b);
    const m2 = b.merge(a);

    expect(m1.lookup("a")).toBe(m2.lookup("a"));
    expect(m1.lookup("b")).toBe(m2.lookup("b"));
  });
});

// Category 3 — Merge laws

describe("TwoPhaseSet - merge laws", () => {
  it("merge is idempotent", () => {
    const s = new TwoPhaseSet();
    s.add("a");
    const m = s.merge(s);
    expect(m.lookup("a")).toBe(s.lookup("a"));
  });

  it("merge is commutative", () => {
    const a = new TwoPhaseSet();
    a.add("x");

    const b = new TwoPhaseSet();
    b.add("y");

    expect(a.merge(b).lookup("x")).toBe(b.merge(a).lookup("x"));
    expect(a.merge(b).lookup("y")).toBe(b.merge(a).lookup("y"));
  });

  it("merge is associative", () => {
    const a = new TwoPhaseSet();
    a.add("x");

    const b = new TwoPhaseSet();
    b.add("y");

    const c = new TwoPhaseSet();
    c.add("z");

    const left = a.merge(b.merge(c));
    const right = a.merge(b).merge(c);

    expect(left.lookup("x")).toBe(right.lookup("x"));
    expect(left.lookup("y")).toBe(right.lookup("y"));
    expect(left.lookup("z")).toBe(right.lookup("z"));
  });
});
