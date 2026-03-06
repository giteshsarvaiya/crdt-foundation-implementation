import { describe, it, expect } from 'vitest';
import { MVRegister } from './implementation';

describe('MVRegister', () => {

  // ─── Basic operations ─────────────────────────────────────────────────────────

  describe('basic operations', () => {
    it('starts empty — no values before first assign', () => {
      const r = new MVRegister<string>(0, 2);
      expect(r.values()).toEqual([]);
    });

    it('returns the assigned value', () => {
      const r = new MVRegister<string>(0, 2);
      r.assign('alice');
      expect(r.values()).toEqual(['alice']);
    });

    it('overwrites the previous value when assigned again at the same replica', () => {
      // Sequential writes at the same replica: the new write causally follows the old one.
      // Its VV dominates the old entry's VV — old entry is filtered out on merge.
      const r = new MVRegister<string>(0, 2);
      r.assign('alice');
      r.assign('bob');
      expect(r.values()).toEqual(['bob']);
    });

    it('works with non-string types (generic)', () => {
      const r = new MVRegister<number>(0, 2);
      r.assign(42);
      expect(r.values()).toEqual([42]);
    });
  });

  // ─── Sequential writes (no conflict) ─────────────────────────────────────────

  describe('sequential writes', () => {
    it('later write dominates when it causally follows the earlier one', () => {
      // B clones A *after* A has assigned — so B knows about A's write before assigning its own.
      // B's VV will be [1, 1]: it increments its own slot on top of the [1, 0] it inherited.
      // A's entry has VV [1, 0]. [1, 0] happened-before [1, 1] → A's entry is dominated.
      // Only "bob" survives.
      const a = new MVRegister<string>(0, 2);
      a.assign('alice');       // a.vv = [1, 0], entries = [("alice", [1,0])]

      const b = a.clone(1);    // b inherits a's state — b knows about alice
      b.assign('bob');         // b.vv = [1, 1], entries = [("bob", [1,1])]

      const merged = a.merge(b);
      expect(merged.values()).toEqual(['bob']);
    });
  });

  // ─── Concurrent writes — the key MV-Register behaviour ───────────────────────

  describe('concurrent writes', () => {
    it('both values survive when writes are truly concurrent', () => {
      // A and B both start empty — neither knows about the other.
      // A assigns: VV [1, 0]. B assigns: VV [0, 1].
      // [1, 0] and [0, 1] are INCOMPARABLE — neither happened-before the other.
      // Both entries survive the merge.
      const a = new MVRegister<string>(0, 2);
      const b = new MVRegister<string>(1, 2);

      a.assign('alice');
      b.assign('bob');

      const merged = a.merge(b);
      expect(merged.values().sort()).toEqual(['alice', 'bob']);
    });

    it('three concurrent writes: all three survive', () => {
      const a = new MVRegister<string>(0, 3);
      const b = new MVRegister<string>(1, 3);
      const c = new MVRegister<string>(2, 3);

      a.assign('alice');
      b.assign('bob');
      c.assign('charlie');

      const merged = a.merge(b).merge(c);
      expect(merged.values().sort()).toEqual(['alice', 'bob', 'charlie']);
    });

    it('assigning after seeing a conflict resolves it — only the new value survives', () => {
      // Step 1: create a conflict
      const a = new MVRegister<string>(0, 2);
      const b = new MVRegister<string>(1, 2);
      a.assign('alice');
      b.assign('bob');

      // Step 2: merge — now A sees the conflict
      const merged = a.merge(b);
      expect(merged.values().sort()).toEqual(['alice', 'bob']);

      // Step 3: resolve — assign a new value after having seen both concurrent writes.
      // The new VV is derived from the merged VV ([1, 1]), then incremented: [2, 1].
      // [2, 1] dominates [1, 0] (alice) and [0, 1] (bob) — both are filtered out.
      merged.assign('resolved');
      expect(merged.values()).toEqual(['resolved']);
    });

    it('contrast with LWW: no data is silently lost — both values are visible', () => {
      const a = new MVRegister<string>(0, 2);
      const b = new MVRegister<string>(1, 2);

      a.assign('important-write');
      b.assign('also-important-write');

      const merged = a.merge(b);

      // LWW would silently discard one of these with no warning.
      // MV-Register keeps both — the application can show a conflict UI or merge manually.
      expect(merged.values()).toHaveLength(2);
      expect(merged.values()).toContain('important-write');
      expect(merged.values()).toContain('also-important-write');
    });
  });

  // ─── Convergence ─────────────────────────────────────────────────────────────

  describe('convergence', () => {
    it('merging in either order produces the same values', () => {
      const a = new MVRegister<string>(0, 2);
      const b = new MVRegister<string>(1, 2);

      a.assign('alice');
      b.assign('bob');

      const ab = a.merge(b).values().sort();
      const ba = b.merge(a).values().sort();
      expect(ab).toEqual(ba);
    });

    it('three replicas converge regardless of merge order', () => {
      const a = new MVRegister<string>(0, 3);
      const b = new MVRegister<string>(1, 3);
      const c = new MVRegister<string>(2, 3);

      a.assign('alice');
      b.assign('bob');
      c.assign('charlie');

      const abc = a.merge(b).merge(c).values().sort();
      const cba = c.merge(b).merge(a).values().sort();
      const bac = b.merge(a).merge(c).values().sort();

      expect(abc).toEqual(cba);
      expect(abc).toEqual(bac);
    });

    it('sequential and concurrent mixed: sequential write wins over old concurrent values', () => {
      // A and B conflict. Then C, having seen A's write, assigns "charlie".
      // C's VV dominates A's entry but NOT B's (C never saw B).
      // After merging all three: charlie and bob survive; alice is gone.
      const a = new MVRegister<string>(0, 3);
      const b = new MVRegister<string>(1, 3);

      a.assign('alice');
      b.assign('bob');

      // C starts from A's state (so C knows about alice), then assigns
      const c = a.clone(2);
      c.assign('charlie');  // C's VV [1, 0, 1] — happened after alice, concurrent with bob

      const merged = a.merge(b).merge(c);
      // alice: VV [1, 0, 0] — dominated by charlie's [1, 0, 1] → gone
      // bob:   VV [0, 1, 0] — not dominated by charlie [1, 0, 1] → survives
      // charlie: VV [1, 0, 1] — not dominated → survives
      expect(merged.values().sort()).toEqual(['bob', 'charlie']);
    });
  });

  // ─── Merge laws ──────────────────────────────────────────────────────────────

  describe('merge laws', () => {
    it('commutative: merge(A, B) = merge(B, A)', () => {
      const a = new MVRegister<string>(0, 2);
      const b = new MVRegister<string>(1, 2);
      a.assign('alice');
      b.assign('bob');
      expect(a.merge(b).values().sort()).toEqual(b.merge(a).values().sort());
    });

    it('associative: merge(A, merge(B, C)) = merge(merge(A, B), C)', () => {
      const a = new MVRegister<string>(0, 3);
      const b = new MVRegister<string>(1, 3);
      const c = new MVRegister<string>(2, 3);
      a.assign('alice');
      b.assign('bob');
      c.assign('charlie');
      expect(a.merge(b.merge(c)).values().sort()).toEqual(a.merge(b).merge(c).values().sort());
    });

    it('idempotent: merge(A, A) = A', () => {
      const a = new MVRegister<string>(0, 2);
      a.assign('alice');
      expect(a.merge(a).values()).toEqual(a.values());
    });
  });

  // ─── Drawbacks ───────────────────────────────────────────────────────────────

  describe('drawbacks', () => {
    it('conflict size is unbounded — N concurrent replicas = N values after merge', () => {
      // In a system with many writers, values() can return a large set.
      // The application must handle arbitrarily long conflict lists.
      const registers = Array.from({ length: 5 }, (_, i) => new MVRegister<number>(i, 5));
      registers.forEach((r, i) => r.assign(i * 100));

      const merged = registers.reduce((acc, r) => acc.merge(r));
      expect(merged.values()).toHaveLength(5);  // all 5 concurrent values survive
    });

    it('application must handle multiple values — there is no automatic resolution', () => {
      const a = new MVRegister<string>(0, 2);
      const b = new MVRegister<string>(1, 2);
      a.assign('option-A');
      b.assign('option-B');

      const merged = a.merge(b);
      // MV-Register surfaces the conflict — it does NOT pick a winner.
      // The application must call merged.values(), see 2 values, and decide what to do.
      expect(merged.values().length).toBeGreaterThan(1);
      // If you need automatic resolution, use LWW-Register instead.
    });
  });
});
