// Op-based OR-Set (Spec 15 — the actual paper spec)
//
// Our state-based OR-Set (folder 4) sent full state and merged by union.
// THIS is the paper's actual Spec 15 — op-based. Operations are broadcast, not state.
//
// The key structural difference:
//
//   State-based OR-Set:
//     entries    = Map<element, Set<tag>>   ← live tags
//     tombstones = Map<element, Set<tag>>   ← dead tags (grow forever)
//     lookup()   = any tag in entries but not in tombstones
//     merge()    = union both entries, union both tombstones
//
//   Op-based OR-Set (this file):
//     entries    = Map<element, Set<tag>>   ← live tags ONLY
//     NO tombstones — remove physically deletes the observed tags
//     lookup()   = any tag exists in entries
//     apply(op)  = add or delete specific tags
//
// Why no tombstones? Because op-based relies on CAUSAL DELIVERY:
//   The remove op captures {element, observedTags} at source.
//   Any concurrent add has a NEW tag that was never in observedTags — it arrives separately
//   as an add op, and is never deleted by the remove. No tombstone needed to protect it.
//
// This is the direct structural ancestor of how YJS inserts and deletes work.

// The two operation types that travel over the network
export type AddOp    = { type: 'add';    element: string; tag: string };
export type RemoveOp = { type: 'remove'; element: string; tags: ReadonlySet<string> };
export type ORSetOp  = AddOp | RemoveOp;

export class OpORSet {
  // The entire payload — just live tags. No tombstones.
  private entries: Map<string, Set<string>>;

  private replicaId: number;
  private counter: number;

  constructor(replicaId: number) {
    this.entries = new Map();
    this.replicaId = replicaId;
    this.counter = 0;
  }

  // ── Phase 1: atSource — add ───────────────────────────────────────────────
  //
  // Generate a globally unique tag for this specific add operation.
  // Apply at source. Return the op for broadcast.
  //
  // The tag is the identity of THIS add. It's what the network broadcasts.
  // Any future remove that hasn't seen this tag will not affect it.
  add(element: string): AddOp {
    const tag = `${this.replicaId}-${this.counter++}`;
    const op: AddOp = { type: 'add', element, tag };
    this.apply(op); // source applies immediately
    return op;      // broadcast to all replicas
  }

  // ── Phase 1: atSource — remove ────────────────────────────────────────────
  //
  // Capture the set of tags currently observed for this element AT SOURCE.
  // These are the ONLY tags this remove will ever kill — it cannot reach into
  // the future and remove tags it hasn't seen yet.
  //
  // A concurrent add on another replica generates a NEW tag not in this set.
  // That add's tag survives because it was never targeted by this remove.
  // That's observed-remove semantics, and it falls out naturally here too.
  remove(element: string): RemoveOp {
    const observedTags = new Set(this.entries.get(element) ?? []);
    const op: RemoveOp = { type: 'remove', element, tags: observedTags };
    this.apply(op); // source applies immediately
    return op;      // broadcast to all replicas
  }

  // ── Phase 2: downstream ───────────────────────────────────────────────────
  //
  // Apply any operation at any replica.
  //
  // add:    insert the tag into entries for this element
  // remove: delete the specific observed tags from entries for this element
  //         — tags from concurrent adds that weren't in observedTags are untouched
  //
  // Why operations commute:
  //   apply(addOp, removeOp) == apply(removeOp, addOp)
  //   If removeOp targets {tag-A}, and addOp adds {tag-B}:
  //     Order 1: add tag-B → delete tag-A → entries has {tag-B}
  //     Order 2: delete tag-A (not present, no-op) → add tag-B → entries has {tag-B}
  //   Same result. ✓
  apply(op: ORSetOp): void {
    if (op.type === 'add') {
      if (!this.entries.has(op.element)) {
        this.entries.set(op.element, new Set());
      }
      this.entries.get(op.element)!.add(op.tag);

    } else {
      // Remove: physically delete the specific tags that were observed at source.
      // Tags not in op.tags (concurrent adds) are untouched.
      const live = this.entries.get(op.element);
      if (live) {
        for (const tag of op.tags) {
          live.delete(tag);
        }
      }
    }
  }

  // Query — is this element currently in the set?
  // Simple: does it have any live tags?
  lookup(element: string): boolean {
    const tags = this.entries.get(element);
    return tags !== undefined && tags.size > 0;
  }

  // Expose the number of live tags for a given element — useful in tests
  // to demonstrate that storage doesn't grow with removes (no tombstones)
  liveTagCount(element: string): number {
    return this.entries.get(element)?.size ?? 0;
  }
}
