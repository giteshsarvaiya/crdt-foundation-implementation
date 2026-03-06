import { describe, it, expect } from 'vitest';
import { OpLWWRegister } from './implementation';

describe('OpLWWRegister (Spec 9)', () => {

  // ─── Basic operations ─────────────────────────────────────────────────────────

  describe('basic operations', () => {
    it('write() returns an op and the local register reflects the new value', () => {
      const r = new OpLWWRegister<string>('initial', 0);
      r.write('hello');
      expect(r.read()).toBe('hello');
    });

    it('sequential writes at the same replica: last write wins', () => {
      const r = new OpLWWRegister<string>('', 0);
      r.write('first');
      r.write('second');
      expect(r.read()).toBe('second');
    });

    it('works with non-string types (generic)', () => {
      const r = new OpLWWRegister<number>(0, 0);
      r.write(42);
      expect(r.read()).toBe(42);
    });
  });

  // ─── The op-based model: write() + apply() ────────────────────────────────────

  describe('op-based delivery: write produces an op, apply delivers it', () => {
    it('apply() delivers an op to another replica', () => {
      const a = new OpLWWRegister<string>('', 0);
      const b = new OpLWWRegister<string>('', 1);

      const op = a.write('hello');  // A writes and gets back an op
      b.apply(op);                  // B receives and applies the op

      expect(b.read()).toBe('hello');
    });

    it('the op is small — just value, timestamp, replicaId — not full state', () => {
      // This test documents the structural point: the object that travels over the
      // network is a 3-field object, regardless of how complex the register's history is.
      const a = new OpLWWRegister<string>('', 0);
      const op = a.write('hello');

      expect(op).toHaveProperty('value', 'hello');
      expect(op).toHaveProperty('timestamp');
      expect(op).toHaveProperty('replicaId', 0);
      expect(Object.keys(op)).toHaveLength(3);  // nothing else in the op
    });

    it('apply() is idempotent — delivering the same op twice has no effect', () => {
      // Op-based systems try to deliver exactly-once, but applying twice should be safe.
      const b = new OpLWWRegister<string>('', 1);
      const a = new OpLWWRegister<string>('', 0);
      const op = a.write('hello');

      b.apply(op);
      b.apply(op);  // duplicate delivery — should not change anything

      expect(b.read()).toBe('hello');
    });
  });

  // ─── Concurrent writes — LWW resolves them ───────────────────────────────────

  describe('concurrent writes', () => {
    it('higher timestamp wins regardless of apply() order', () => {
      // A writes first (lower clock), B writes second (higher clock).
      // Regardless of which op arrives first, B wins.
      const a = new OpLWWRegister<string>('', 0);
      const b = new OpLWWRegister<string>('', 1);

      const opA = a.write('alice');  // clock 1
      const opB = b.write('bob');    // also clock 1 — wait, they're independent
      // Both start at clock 0, both increment to 1. Tie. replicaId breaks it.
      // B has replicaId=1, A has replicaId=0 → B wins.

      // Apply in order A then B
      const c1 = new OpLWWRegister<string>('', 2);
      c1.apply(opA);
      c1.apply(opB);
      expect(c1.read()).toBe('bob');

      // Apply in order B then A — same result
      const c2 = new OpLWWRegister<string>('', 2);
      c2.apply(opB);
      c2.apply(opA);
      expect(c2.read()).toBe('bob');
    });

    it('ops commute — applying in any order produces the same result', () => {
      // This is the core CmRDT property: operations must commute.
      // LWW commutes because the winner is determined by (timestamp, replicaId) — data in the op,
      // not by who calls apply first.
      const a = new OpLWWRegister<string>('', 0);
      const b = new OpLWWRegister<string>('', 1);

      // Give B a higher clock so B wins clearly (no tie needed)
      a.write('first');      // a._clock = 1
      const opB = b.write('from-b');   // b._clock = 1 → ties with a, B's replicaId wins

      const opA2 = a.write('from-a'); // a._clock = 2 → A now has higher timestamp → A wins

      // Apply both on a fresh replica in both orders
      const c1 = new OpLWWRegister<string>('', 2);
      c1.apply(opA2);
      c1.apply(opB);
      const result1 = c1.read();

      const c2 = new OpLWWRegister<string>('', 2);
      c2.apply(opB);
      c2.apply(opA2);
      const result2 = c2.read();

      expect(result1).toBe(result2);
    });
  });

  // ─── Lamport clock ───────────────────────────────────────────────────────────

  describe('Lamport clock', () => {
    it('each write gets a strictly higher timestamp than the previous one', () => {
      const a = new OpLWWRegister<string>('', 0);
      const op1 = a.write('first');
      const op2 = a.write('second');
      expect(op2.timestamp).toBeGreaterThan(op1.timestamp);
    });

    it('after applying an op with a high timestamp, the next write gets a higher one', () => {
      // If B has a very high clock and A receives B's op, A's next write should
      // get a clock higher than B's — so A's sequential write beats B.
      const a = new OpLWWRegister<string>('', 0);
      const b = new OpLWWRegister<string>('', 1);

      // Advance B's clock by writing many times
      b.write('b1');
      b.write('b2');
      b.write('b3');
      const opB = b.write('b4');  // timestamp = 4

      // A receives B's op — A's Lamport clock jumps to max(0, 4) = 4
      a.apply(opB);

      // A's next write should get timestamp 5 (> 4) so A's sequential write beats B
      const opA = a.write('a-after');
      expect(opA.timestamp).toBeGreaterThan(opB.timestamp);
      expect(a.read()).toBe('a-after');  // A's write beats B's
    });
  });

  // ─── Contrast with state-based (Spec 8) ─────────────────────────────────────

  describe('contrast with state-based LWW-Register', () => {
    it('what travels over the network is a small op — not a copy of the register', () => {
      // State-based: send the entire register (value + timestamp + replicaId)
      // Op-based: ALSO sends (value + timestamp + replicaId) for a register —
      //   but the structural point is that the op is independently defined,
      //   can be logged, replayed, batched, or queued without the register object.
      const a = new OpLWWRegister<string>('', 0);
      const op = a.write('hello');

      // The op exists independently — it can be sent to any number of replicas
      const b = new OpLWWRegister<string>('', 1);
      const c = new OpLWWRegister<string>('', 2);
      b.apply(op);
      c.apply(op);

      expect(b.read()).toBe('hello');
      expect(c.read()).toBe('hello');
      // One write → one op → applied to N replicas. State-based sends full state to each.
    });

    it('ops can be stored and replayed — registers can be rebuilt from op log', () => {
      // In op-based systems, the operation log IS the source of truth.
      // A new replica can be initialized by replaying all ops from the log.
      const a = new OpLWWRegister<string>('', 0);
      const ops = [
        a.write('first'),
        a.write('second'),
        a.write('third'),
      ];

      // New replica replays the op log
      const newReplica = new OpLWWRegister<string>('', 99);
      for (const op of ops) {
        newReplica.apply(op);
      }

      expect(newReplica.read()).toBe('third');
    });
  });

  // ─── Drawbacks ───────────────────────────────────────────────────────────────

  describe('drawbacks (documented)', () => {
    it('out-of-order delivery without causal delivery: same final result for LWW', () => {
      // LWW's ops commute, so out-of-order delivery still converges.
      // (For CRDTs with non-commuting ops, causal delivery would be REQUIRED.)
      const a = new OpLWWRegister<string>('', 0);
      const b = new OpLWWRegister<string>('', 1);

      const op1 = a.write('op1');  // timestamp 1
      const op2 = a.write('op2');  // timestamp 2

      // B applies in reverse order (op2 before op1) — simulates out-of-order delivery
      b.apply(op2);
      b.apply(op1);

      // LWW still picks op2 (higher timestamp) — correct result even without causal delivery
      expect(b.read()).toBe('op2');
      // Note: OR-Set would NOT be safe without causal delivery for remove ops
    });
  });
});
