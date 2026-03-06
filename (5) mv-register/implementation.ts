// MV-Register (Multi-Value Register) — Spec 10
//
// Instead of LWW (silently picking one winner), MV-Register keeps ALL concurrent
// values. If two replicas write at the same logical time (concurrent), both values
// survive the merge. The application layer sees the conflict and decides what to do.
//
// The key data structure: every write is tagged with a VERSION VECTOR — an array
// recording how much each replica has contributed at the time of the write.
// This is the same idea as G-Counter, but now used to track causal history.

// A version vector: one integer slot per replica.
// slot[i] = how many operations replica i has contributed so far.
// Identical to G-Counter's payload structure.
type VersionVector = number[];

// Returns true if vv1 "happened-before" vv2.
// Formally: every slot of vv1 is <= vv2, AND at least one is strictly less.
// This means vv2 has seen everything vv1 saw, plus something more.
function happenedBefore(vv1: VersionVector, vv2: VersionVector): boolean {
  return vv1.every((v, i) => v <= vv2[i]) && vv1.some((v, i) => v < vv2[i]);
}

// Returns true if two version vectors are identical (same causal context).
function vvEquals(a: VersionVector, b: VersionVector): boolean {
  return a.every((v, i) => v === b[i]);
}

// One entry in the MV-Register payload: the written value paired with the
// version vector that was current when it was written.
// The VV is the entry's "timestamp" — but causal, not wall-clock.
type Entry<T> = {
  value: T;
  vv: VersionVector;
};

export class MVRegister<T> {
  // The payload: a set of (value, versionVector) pairs.
  // Normally contains one entry. After a merge of concurrent writes: multiple entries.
  // Multiple entries = conflict — the application must resolve it.
  private entries: Entry<T>[];

  // This replica's current version vector: the element-wise max of all entry VVs.
  // We track it separately so assign() can derive the next VV in O(1).
  private vv: VersionVector;

  private replicaId: number;
  private numReplicas: number;

  constructor(replicaId: number, numReplicas: number) {
    this.replicaId = replicaId;
    this.numReplicas = numReplicas;
    this.vv = new Array(numReplicas).fill(0);
    this.entries = [];
  }

  // Write a new value to this register at this replica.
  //
  // Step 1: derive a new VV by taking the current VV and incrementing this replica's slot.
  //         The current VV already reflects all history this replica has seen.
  //         After incrementing, the new VV dominates ALL existing entries' VVs —
  //         meaning this new write "happened after" everything we currently know about.
  //
  // Step 2: replace ALL existing entries with a single new entry (value, newVV).
  //         Because newVV dominates every previous entry VV, those old entries will be
  //         filtered out during any subsequent merge. The conflict is resolved.
  assign(value: T): void {
    const newVV = [...this.vv];
    newVV[this.replicaId]++;    // increment only this replica's slot
    this.vv = newVV;
    this.entries = [{ value, vv: [...newVV] }];
  }

  // Return all currently live values.
  // One value  → no concurrent conflict.
  // Many values → concurrent writes were merged; application must handle the conflict.
  values(): T[] {
    return this.entries.map(e => e.value);
  }

  // Merge two MV-Registers.
  //
  // Rule: take the UNION of both entry sets, then keep only the "maximal" entries —
  // those not dominated (happened-before) by any other entry in the union.
  //
  // An entry E is dominated if some other entry F's VV strictly happened-after E's VV.
  // That means F saw everything E saw and then some — E is superseded by F and can be dropped.
  //
  // Entries that are incomparable (neither happened-before the other) are BOTH kept.
  // That is the concurrent case — the conflict.
  merge(other: MVRegister<T>): MVRegister<T> {
    const result = new MVRegister<T>(this.replicaId, this.numReplicas);

    // Union of all entries from both sides
    const allEntries: Entry<T>[] = [...this.entries, ...other.entries];

    const kept: Entry<T>[] = [];
    for (const candidate of allEntries) {
      // Is this entry dominated by any other entry in the union?
      const dominated = allEntries.some(
        other => !vvEquals(other.vv, candidate.vv) && happenedBefore(candidate.vv, other.vv)
      );
      // Also deduplicate: skip if an entry with the same VV was already kept.
      // (Two replicas may have independently produced identical entries.)
      const alreadyKept = kept.some(k => vvEquals(k.vv, candidate.vv));

      if (!dominated && !alreadyKept) {
        kept.push({ value: candidate.value, vv: [...candidate.vv] });
      }
    }

    result.entries = kept;
    // Merge the VVs: element-wise max, same as G-Counter.
    // After merge, this replica has "seen" everything both replicas had seen.
    result.vv = this.vv.map((v, i) => Math.max(v, other.vv[i]));
    return result;
  }

  // Clone this register, optionally assigning a different replicaId.
  // Same pattern as OR-Set: needed so test replicas generate independent version vectors.
  clone(newReplicaId: number = this.replicaId): MVRegister<T> {
    const copy = new MVRegister<T>(newReplicaId, this.numReplicas);
    copy.entries = this.entries.map(e => ({ value: e.value, vv: [...e.vv] }));
    copy.vv = [...this.vv];
    return copy;
  }
}
