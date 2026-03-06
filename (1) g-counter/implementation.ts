// G-Counter (Grow-only Counter) — a state-based CRDT (CvRDT)
//
// Core idea: each replica owns exactly one entry in a shared Map.
// A replica can only increment its own entry — never touch another's.
// This simple rule is what makes concurrent increments safe to merge.
//
// Why Map<replicaId, count> instead of a fixed array?
//   The original paper spec uses a fixed-size array indexed by replicaId.
//   Production systems — including YJS — use a Map instead:
//     - New replicas join lazily: no entry = 0, no coordination needed
//     - This is exactly how YJS's state vector works: Map<clientId, clock>
//   The concepts are identical. The Map form is what you'll see in YJS.
//
// Example with 3 replicas:
//   Replica 0 increments twice: Map { 0→2 }
//   Replica 1 increments once:  Map { 1→1 }   (concurrent, no coordination)
//   Merge (max per key):        Map { 0→2, 1→1 }
//   Value (sum):                3

export class GCounter {
  // The payload: Map<replicaId, count>.
  // Absent keys are treated as 0.
  // A replica writes ONLY to its own key — never another replica's.
  private payload: Map<number, number>;

  // Which replica this instance represents.
  // increment() always writes to this key — no argument needed.
  private replicaId: number;

  constructor(replicaId: number) {
    this.replicaId = replicaId;
    this.payload = new Map();
    // No entry needed at construction — absent key = 0.
    // New replicas can join at any time without resizing or coordination.
  }

  // Update operation — increments this replica's own entry.
  // No replicaId argument needed: each GCounter instance owns exactly one replica.
  // This matches how YJS works: each client increments only its own clock.
  increment(): void {
    this.payload.set(this.replicaId, (this.payload.get(this.replicaId) ?? 0) + 1);
  }

  // Query operation — runs entirely locally, no network needed.
  // The logical value is the sum of all entries because each entry
  // independently tracks one replica's contribution.
  value(): number {
    let sum = 0;
    for (const v of this.payload.values()) sum += v;
    return sum;
  }

  // Merge is the heart of every CvRDT.
  // Take the union of all keys from both Maps, and for each key take the max.
  //
  // Why max? Each entry can only increase (increment only).
  // So the higher value is always "more true" — it reflects more increments.
  // Taking max never discards information from either replica.
  //
  // New keys in `other` that don't exist locally are included at their full value
  // (equivalent to max(0, other_value) = other_value).
  // This is how YJS merges state vectors: it takes the max clock per clientId.
  //
  // This merge is the Least Upper Bound (LUB) of the semilattice, which
  // mathematically guarantees convergence. It satisfies:
  //   Commutative:  merge(A, B) = merge(B, A)
  //   Associative:  merge(A, merge(B,C)) = merge(merge(A,B), C)
  //   Idempotent:   merge(A, A) = A
  merge(other: GCounter): GCounter {
    const result = new GCounter(this.replicaId);

    // Collect every replicaId seen across both Maps
    const allKeys = new Set([...this.payload.keys(), ...other.payload.keys()]);

    for (const key of allKeys) {
      const myVal    = this.payload.get(key)  ?? 0;
      const otherVal = other.payload.get(key) ?? 0;
      result.payload.set(key, Math.max(myVal, otherVal));
    }

    return result;
  }

  // Semilattice ordering: "has this counter seen at least as much as other?"
  // this <= other means: for every key in this, other's value for that key is >= ours.
  // Absent keys in other are treated as 0 — so if we have a key other doesn't, we're ahead.
  // Used by YJS's sync protocol: compare state vectors to find what ops a peer is missing.
  compare(other: GCounter): boolean {
    for (const [key, val] of this.payload) {
      if (val > (other.payload.get(key) ?? 0)) return false;
    }
    return true;
  }

  // Creates an independent copy of this counter, optionally with a new replicaId.
  // Used in tests to simulate two replicas starting from the same state
  // before diverging with independent operations.
  clone(newReplicaId: number = this.replicaId): GCounter {
    const copy = new GCounter(newReplicaId);
    copy.payload = new Map(this.payload);
    return copy;
  }
}
