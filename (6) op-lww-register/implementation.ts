// Op-based LWW-Register (Spec 9)
//
// The state-based version (Spec 8, folder 3) sends the full register state on every sync.
// The op-based version sends just the OPERATION — a small {value, timestamp, replicaId} tuple.
// The recipient replays it using the same LWW logic.
//
// This introduces the two-phase structure every CmRDT follows:
//   Phase 1 — atSource: generate the operation at the source replica (no state mutation)
//   Phase 2 — downstream: apply the operation at EVERY replica (including source)
//
// Clock: we use a Lamport clock instead of wall-clock time.
//   - Increment locally on every write (so our next write is always "after" this one)
//   - Take max(local, incoming) on every receive (so we're always ahead of anything we've seen)
//   - This is immune to clock skew — the ordering is logical, not physical

// The operation type — this is what travels over the network instead of the full state.
export type LWWOp<T> = {
  value: T;
  timestamp: number;   // Lamport clock value at the time of the write
  replicaId: number;   // which replica wrote this — used as tiebreaker on equal timestamp
};

export class OpLWWRegister<T> {
  // The currently winning write — value + its timestamp + which replica wrote it
  private _value: T;
  private _winningTimestamp: number;
  private _winningReplicaId: number;

  // Lamport clock: this replica's logical clock, updated on every write and every receive
  private _clock: number;

  readonly replicaId: number;

  constructor(initialValue: T, replicaId: number) {
    this._value = initialValue;
    this._winningTimestamp = 0;
    this._winningReplicaId = -1;
    this._clock = 0;
    this.replicaId = replicaId;
  }

  // ── Phase 1: atSource ─────────────────────────────────────────────────────
  //
  // Called at the source replica when a client wants to write a value.
  //
  // Steps:
  //   1. Increment the Lamport clock — this write is a new local event
  //   2. Create the operation (the thing that will be broadcast)
  //   3. Apply the op at source — source is also a downstream replica
  //   4. Return the op — caller is responsible for broadcasting it to all other replicas
  //
  // Key difference from state-based: we return a SMALL op, not the full register state.
  // A replica with 10 GB of history still broadcasts a 3-field object.
  write(value: T): LWWOp<T> {
    this._clock++;  // Lamport: increment on every local event
    const op: LWWOp<T> = { value, timestamp: this._clock, replicaId: this.replicaId };
    this.apply(op); // source applies its own op (it's also a downstream replica)
    return op;      // broadcast this to all other replicas
  }

  // ── Phase 2: downstream ───────────────────────────────────────────────────
  //
  // Called at EVERY replica when an operation arrives — including source (from write() above).
  //
  // Two things happen here:
  //   1. Lamport clock update: take max(local, incoming). This ensures our clock is always
  //      ahead of anything we've seen, so our next write() will get a fresh timestamp.
  //   2. LWW rule: apply the op only if it beats the current winner.
  //      Same logic as state-based merge, but applied to one op at a time.
  //
  // Operations commute: apply(op1, op2) == apply(op2, op1) because LWW always picks
  // the same winner regardless of which arrived first. This is what makes it a CmRDT.
  apply(op: LWWOp<T>): void {
    // Lamport clock update on receive
    this._clock = Math.max(this._clock, op.timestamp);

    // LWW: this op wins if its timestamp is higher, or timestamps tie and its replicaId is higher
    const winsOnTimestamp = op.timestamp > this._winningTimestamp;
    const tiesOnTimestamp = op.timestamp === this._winningTimestamp;
    const winsOnTiebreak  = op.replicaId > this._winningReplicaId;

    if (winsOnTimestamp || (tiesOnTimestamp && winsOnTiebreak)) {
      this._value = op.value;
      this._winningTimestamp = op.timestamp;
      this._winningReplicaId = op.replicaId;
    }
    // Otherwise: existing write wins, op is discarded. No state change.
  }

  // Query — read-only, local, no network
  read(): T {
    return this._value;
  }
}
