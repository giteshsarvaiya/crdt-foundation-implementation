// OR-Set (Observed-Remove Set) — a state-based CRDT (CvRDT)
//
// Fixes the core limitation of 2P-Set: once removed, always removed.
// In OR-Set, you CAN re-add an element after removing it.
//
// --- THE CORE IDEA ---
//
// Instead of storing just elements, we store (element, unique-tag) pairs.
// Every add() attaches a fresh unique tag to the element.
// remove() only removes the tags it has currently OBSERVED — tags added
// concurrently (that this replica hasn't seen yet) survive the merge.
//
// This is why it's called "Observed-Remove" — you only remove what you've seen.
//
// --- WALKTHROUGH ---
//
// Scenario: Replica A and B start from the same state.
//
//   A adds "x"  →  entries: { x: {t1} }          (tag t1 is unique to A)
//   B adds "x"  →  entries: { x: {t2} }           (tag t2 is unique to B, concurrent)
//   B removes "x" → tombstones: { x: {t2} }       (B only sees t2, not t1)
//
//   Merge:
//     entries    = { x: {t1, t2} }                 (union of both)
//     tombstones = { x: {t2} }                     (union of both)
//
//   lookup("x"): does x have any tag in entries NOT in tombstones?
//     t1 → not tombstoned → YES → x is in the set ✓
//
//   2P-Set would say: x was removed, it's gone forever.
//   OR-Set says:      B's remove only killed what B saw. A's concurrent add survives.
//
// --- RE-ADD (what 2P-Set cannot do) ---
//
//   A: add("x") → tag t1 → remove("x") → tombstone t1 → add("x") → tag t3
//   entries:    { x: {t1, t3} }
//   tombstones: { x: {t1} }
//   lookup("x"): t3 is alive → x IS in the set ✓
//
//   The new add got a new tag. The old tag is dead, the new one is alive.
//   2P-Set cannot do this — its remove set blocks the element forever.

export class ORSet {
  // entries: every (element → Set of tags) that has ever been added.
  // An element's presence in entries does NOT mean it's currently in the set —
  // it might be fully tombstoned. You must check lookup().
  private entries: Map<string, Set<string>>;

  // tombstones: every (element → Set of tags) that has ever been removed.
  // A tag here means: "this specific add of this element was removed."
  // Tags NOT in tombstones are still alive.
  private tombstones: Map<string, Set<string>>;

  // replicaId: unique identifier for this replica.
  // Used to generate tags that are globally unique across all replicas.
  private replicaId: number;

  // counter: increments every time this replica calls add().
  // Combined with replicaId, guarantees no two adds ever share a tag.
  private counter: number;

  constructor(replicaId: number) {
    this.entries = new Map();
    this.tombstones = new Map();
    this.replicaId = replicaId;
    this.counter = 0;
  }

  // Generates a unique tag for each add operation.
  // Format: "replicaId-counter" e.g. "0-0", "0-1", "1-0"
  // replicaId ensures no two replicas generate the same tag.
  // counter ensures no two adds on the same replica generate the same tag.
  // Together: every single add() in the entire system gets a unique tag.
  private generateTag(): string {
    return `${this.replicaId}-${this.counter++}`;
  }

  // Add an element to the set.
  // Generates a fresh unique tag and associates it with this element.
  // Even if the element was previously removed, this new tag is fresh —
  // it has never been tombstoned, so it makes the element "alive" again.
  add(element: string): void {
    const tag = this.generateTag();

    // Initialise the tag set for this element if it doesn't exist yet.
    if (!this.entries.has(element)) {
      this.entries.set(element, new Set());
    }

    // Store the (element → tag) association.
    // This tag represents THIS specific add operation.
    this.entries.get(element)!.add(tag);
  }

  // Query: is this element currently in the set?
  // An element is "in" the set if it has at least one tag in entries
  // that has NOT been tombstoned.
  lookup(element: string): boolean {
    const tags = this.entries.get(element);

    // No entries at all for this element — definitely not in the set.
    if (!tags || tags.size === 0) return false;

    const dead = this.tombstones.get(element) ?? new Set<string>();

    // Check each tag: if even ONE tag is still alive (not tombstoned), the element is in the set.
    for (const tag of tags) {
      if (!dead.has(tag)) return true;
    }

    // Every tag has been tombstoned — element is not in the set.
    return false;
  }

  // Remove an element from the set.
  // Precondition: the element must currently be in the set (lookup returns true).
  //
  // Key behaviour: we tombstone ONLY the tags we currently see in entries.
  // Tags added concurrently by other replicas (not yet received) will survive
  // when those replicas eventually merge in — they'll be in entries but not tombstones.
  // This is exactly what makes OR-Set "observed-remove".
  remove(element: string): void {
    if (!this.lookup(element)) {
      throw new Error(`Cannot remove "${element}": not currently in set`);
    }

    const tags = this.entries.get(element)!;

    if (!this.tombstones.has(element)) {
      this.tombstones.set(element, new Set());
    }

    // Copy every currently-known tag for this element into tombstones.
    // We are saying: "I have observed these specific adds and I want them gone."
    for (const tag of tags) {
      this.tombstones.get(element)!.add(tag);
    }
  }

  // Merge two replicas by taking:
  //   - union of their entries     (all adds from both replicas)
  //   - union of their tombstones  (all removes from both replicas)
  //
  // Union is the LUB for sets — same principle as G-Set and 2P-Set.
  // After merge, lookup() will correctly reflect add-wins semantics:
  // if replica A added concurrently with replica B's remove, A's tag survives.
  merge(other: ORSet): ORSet {
    const result = new ORSet(this.replicaId);

    // Union of entries: collect all tags ever added by either replica.
    const allElements = new Set([
      ...this.entries.keys(),
      ...other.entries.keys(),
    ]);

    for (const element of allElements) {
      const myTags    = this.entries.get(element)  ?? new Set<string>();
      const otherTags = other.entries.get(element) ?? new Set<string>();
      result.entries.set(element, new Set([...myTags, ...otherTags]));
    }

    // Union of tombstones: collect all tags ever removed by either replica.
    const allDead = new Set([
      ...this.tombstones.keys(),
      ...other.tombstones.keys(),
    ]);

    for (const element of allDead) {
      const myDead    = this.tombstones.get(element)  ?? new Set<string>();
      const otherDead = other.tombstones.get(element) ?? new Set<string>();
      result.tombstones.set(element, new Set([...myDead, ...otherDead]));
    }

    return result;
  }

  // Semilattice ordering: this <= other
  // Means: every (element, tag) pair in this.entries exists in other.entries
  // AND every tombstone in this.tombstones exists in other.tombstones.
  // i.e. other has seen everything this has seen, and possibly more.
  compare(other: ORSet): boolean {
    for (const [element, tags] of this.entries) {
      const otherTags = other.entries.get(element);
      if (!otherTags) return false;
      for (const tag of tags) {
        if (!otherTags.has(tag)) return false;
      }
    }
    for (const [element, tags] of this.tombstones) {
      const otherTags = other.tombstones.get(element);
      if (!otherTags) return false;
      for (const tag of tags) {
        if (!otherTags.has(tag)) return false;
      }
    }
    return true;
  }

  // Creates an independent copy of this replica's state.
  // newReplicaId: give the clone a different ID so its add() calls
  // generate different tags from the original — simulating a real separate replica.
  clone(newReplicaId: number = this.replicaId): ORSet {
    const copy = new ORSet(newReplicaId);
    for (const [element, tags] of this.entries) {
      copy.entries.set(element, new Set(tags));
    }
    for (const [element, tags] of this.tombstones) {
      copy.tombstones.set(element, new Set(tags));
    }
    copy.counter = this.counter;
    return copy;
  }
}
