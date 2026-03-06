// G-Counter (Grow-only Counter) — a state-based CRDT (CvRDT)
//
// Core idea: each replica owns exactly one slot in a shared array.
// A replica can only increment its own slot — never touch another's.
// This simple rule is what makes concurrent increments safe to merge.
//
// Example with 3 replicas:
//   Initial:             [0, 0, 0]
//   Replica 0 increments: [2, 0, 0]
//   Replica 1 increments: [0, 1, 0]  (concurrent, no coordination)
//   Merge (max per slot): [2, 1, 0]
//   Value (sum):           3
export class GCounter {
  // The payload is a vector — one integer slot per replica.
  // Index = replicaId. Each replica writes ONLY to its own index.
  // Reading is unrestricted — any replica can sum the full vector.
  private payload: number[];

  constructor(numReplicas: number) {
    // Every replica starts knowing nothing — all slots at zero.
    this.payload = new Array(numReplicas).fill(0);
  }

  // Update operation — called locally by a replica on itself.
  // replicaId must match the replica calling this; incrementing
  // someone else's slot would break the convergence guarantee.
  increment(replicaId: number): void {
    this.payload[replicaId]++;
  }

  // Query operation — runs entirely locally, no network needed.
  // The logical value of the counter is the sum of all slots
  // because each slot independently tracks one replica's contribution.
  value(): number {
    return this.payload.reduce((sum, v) => sum + v, 0);
  }

  // Merge is the heart of every CvRDT.
  // We take the element-wise max across both vectors.
  //
  // Why max? A slot can only go up (increments only).
  // So the higher value is always "more true" — it reflects more increments.
  // Taking max never discards information from either replica.
  //
  // This merge is the Least Upper Bound (LUB) of the semilattice,
  // which mathematically guarantees convergence. It satisfies:
  //   - Commutative:  merge(A, B) = merge(B, A)       → order of arrival doesn't matter
  //   - Associative:  merge(A, merge(B,C)) = merge(merge(A,B), C) → batching doesn't matter
  //   - Idempotent:   merge(A, A) = A                 → duplicate messages are harmless
  merge(other: GCounter): GCounter {
    const result = new GCounter(this.payload.length);
    for (let i = 0; i < this.payload.length; i++) {
      result.payload[i] = Math.max(this.payload[i], other.payload[i]);
    }
    return result;
  }

  // Semilattice ordering: "has this counter seen at least as much as other?"
  // A <= B means every slot of A is <= the corresponding slot of B.
  // In other words: B has seen everything A has seen, and possibly more.
  // Used to check if one replica's state is "ahead of" another's.
  compare(other: GCounter): boolean {
    return this.payload.every((v, i) => v <= other.payload[i]);
  }

  // Creates an independent copy of this counter.
  // Used in tests to simulate two replicas that start from the same state,
  // then diverge by doing independent operations before merging.
  clone(): GCounter {
    const copy = new GCounter(this.payload.length);
    copy.payload = [...this.payload];
    return copy;
  }
}
