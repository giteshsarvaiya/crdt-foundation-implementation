// LWW-Register (Last-Write-Wins Register) — a state-based CRDT (CvRDT)
//
// A register holds a single value. When two replicas write concurrently,
// the one with the higher timestamp wins. The other write is silently discarded.
//
// This is the simplest conflict resolution strategy — and the most lossy.
// It answers: "when two replicas disagree, whose write do we keep?"
// Answer: whoever wrote latest (by wall clock / logical timestamp).
//
// Example:
//   Replica A writes ("alice", t=10)
//   Replica B writes ("bob",   t=20)   ← concurrent, neither knows about the other
//   After merge → "bob" wins (higher timestamp)
//   "alice" is gone forever — this is the tradeoff
//
// --- WHY WE NEED A TIEBREAKER ---
//
// What if two replicas write at the exact same timestamp?
//
//   Replica A (replicaId=0) writes ("alice", t=5)
//   Replica B (replicaId=1) writes ("bob",   t=5)   ← same timestamp!
//
// Without a tiebreaker, "keep existing" means:
//   A merges B → A thinks it is "existing" → keeps "alice"
//   B merges A → B thinks it is "existing" → keeps "bob"
//
//   merge(A, B) = "alice"
//   merge(B, A) = "bob"
//   "alice" ≠ "bob"  → DIVERGED. Commutativity is broken.
//
// The fix: when timestamps tie, compare replicaIds. Higher replicaId wins.
// Both replicas see the same two IDs and always pick the same winner —
// the decision is based on the DATA, not on who is calling merge.
//
//   A merges B → timestamps tie → replicaId 1 > 0 → B wins → "bob"
//   B merges A → timestamps tie → replicaId 1 > 0 → B wins → "bob"
//   merge(A, B) = merge(B, A) = "bob"  ✓ converged
//
// The T generic makes this work for any value type (string, number, object, etc.)
export class LWWRegister<T> {
  // The current value stored in this register
  private value: T;

  // The timestamp of the last write — used to resolve conflicts on merge.
  // Higher timestamp = more recent = wins.
  private timestamp: number;

  // A unique, stable identifier for this replica.
  // Only used as a tiebreaker when two replicas have the exact same timestamp.
  // Must be unique per replica — typically assigned at startup.
  private replicaId: number;

  constructor(initialValue: T, replicaId: number, timestamp: number = 0) {
    this.value = initialValue;
    this.replicaId = replicaId;
    this.timestamp = timestamp;
  }

  // Query — returns the current value locally, no network needed.
  read(): T {
    return this.value;
  }

  // Update — overwrites the value only if the incoming timestamp is strictly newer.
  // If the timestamp is equal or older, the write is ignored.
  write(value: T, timestamp: number): void {
    if (timestamp > this.timestamp) {
      this.value = value;
      this.timestamp = timestamp;
    }
  }

  // Merge — the heart of LWW-Register.
  //
  // Priority 1: higher timestamp wins — time only moves forward.
  // Priority 2: on a timestamp tie, higher replicaId wins.
  //             This is deterministic — both replicas see the same IDs
  //             and will always make the same decision, guaranteeing convergence.
  merge(other: LWWRegister<T>): LWWRegister<T> {
    if (other.timestamp > this.timestamp) {
      // Other replica wrote more recently — it wins outright.
      return new LWWRegister(other.value, other.replicaId, other.timestamp);
    }
    if (other.timestamp === this.timestamp && other.replicaId > this.replicaId) {
      // Timestamps are equal — use replicaId as a deterministic tiebreaker.
      // Higher replicaId wins. Both replicas will reach this same conclusion.
      return new LWWRegister(other.value, other.replicaId, other.timestamp);
    }
    // We are newer, or tied but we have the higher replicaId — we win.
    return new LWWRegister(this.value, this.replicaId, this.timestamp);
  }

  // Semilattice ordering: this <= other
  // Means: other has seen a more recent write (or same timestamp but higher replicaId).
  compare(other: LWWRegister<T>): boolean {
    if (this.timestamp !== other.timestamp) {
      return this.timestamp <= other.timestamp;
    }
    return this.replicaId <= other.replicaId;
  }

  // Creates an independent copy — used in tests to simulate diverging replicas.
  clone(): LWWRegister<T> {
    return new LWWRegister(this.value, this.replicaId, this.timestamp);
  }
}
