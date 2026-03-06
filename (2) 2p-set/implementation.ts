// 2P-Set (Two-Phase Set) — a state-based CRDT (CvRDT)
//
// Internally holds two grow-only sets:
//   - One for added elements (grow-only)
//   - One for removed elements (grow-only)
// // When merging, we take the union of both sets.
// let A = elements ever added
// let R = elements ever removed (tombstones)
//
// An element is "in" the set if: e ∈ A ∧ e ∉ R
//
// The "two phases" are: add phase -> remove phase.
// Once an element enters the remove phase, it can never go back.

export class TwoPhaseSet {
  // A: the add set - every element ever added

  private A: Set<string>;

  // R: the remove set (tombstone set) - every element ever removed
  // Once here, an element is gone forever. R can only grow, never shrink.

  private R: Set<string>;

  constructor() {
    this.A = new Set();
    this.R = new Set();
  }

  // Add an element to the set.
  // No precondition - you can always add.
  // Note: if the element is already in R (previously removed), adding it again changes nothing - R still wins

  add(element: string): void {
    this.A.add(element);
  }

  // Query: is this element currently in the set ?
  // True only if it was added AND never removed.
  // This is the core rule of 2P-Set.

  lookup(element: string): boolean {
    return this.A.has(element) && !this.R.has(element);
  }

  // Remove an element from the set.
  // Precondition: the element must currently be in the set.
  // You cannnont remove something that was never added,
  // or something already removed.

  remove(element: string): void {
    if (!this.lookup(element)) {
      throw new Error(`Cannot remove "${element}": not currently in set`);
    }
    // Add to the tombstone set - this is permanent.
    // The element stays in A forever, but R now blocks it from lookup.
    this.R.add(element);
  }

  // Merge two replicas by taking the union of both A sets.
  // and the union of both R sets.
  //
  // Union is the LUB for sets (same as G-Set).
  // Applying it to both A and R independently keeps the invariant:
  // if either replica removed something, the merged result respects that.
  //
  // This means: if replica 1 adds "x" and replica 2 removed "x" concurrently, after merge - "x" is gone.
  // Remove always wins in 2P-Set.

  merge(other: TwoPhaseSet): TwoPhaseSet {
    const result = new TwoPhaseSet();
    for (const e of this.A) result.A.add(e);
    for (const e of other.A) result.A.add(e);
    for (const e of this.R) result.R.add(e);
    for (const e of other.R) result.R.add(e);
    return result;
  }

  // Semilattice ordering: this <= other
  // Means: other has seen everything this has seem (and possible more).
  // Both A and R must be subsets of other's A and R respectively.

  compare(other: TwoPhaseSet): boolean {
    for (const e of this.A) {
      if (!other.A.has(e)) return false;
    }
    for (const e of this.R) {
      if (!other.R.has(e)) return false;
    }
    return true;
  }

  // Deep copy - used is tests to simulate replicas diverging from the same state.

  clone(): TwoPhaseSet {
    const copy = new TwoPhaseSet();
    copy.A = new Set(this.A);
    copy.R = new Set(this.R);
    return copy;
  }
}
