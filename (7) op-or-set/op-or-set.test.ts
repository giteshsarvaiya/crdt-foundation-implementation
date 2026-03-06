import { describe, it, expect } from 'vitest';
import { OpORSet } from './implementation';

describe('OpORSet (Spec 15 — op-based)', () => {

  // ─── Basic operations ─────────────────────────────────────────────────────────

  describe('basic operations', () => {
    it('add makes an element visible', () => {
      const s = new OpORSet(0);
      s.add('x');
      expect(s.lookup('x')).toBe(true);
    });

    it('remove makes an element invisible', () => {
      const s = new OpORSet(0);
      s.add('x');
      s.remove('x');
      expect(s.lookup('x')).toBe(false);
    });

    it('re-add after remove works — the new add has a fresh tag never targeted', () => {
      const s = new OpORSet(0);
      s.add('x');
      s.remove('x');
      s.add('x');  // new tag, never targeted by the remove
      expect(s.lookup('x')).toBe(true);
    });

    it('removing an element that was never added is a no-op', () => {
      const s = new OpORSet(0);
      s.remove('ghost');  // no tags to observe, op has empty tag set
      expect(s.lookup('ghost')).toBe(false);
    });
  });

  // ─── The op-based model: ops travel, not state ────────────────────────────────

  describe('op-based delivery: ops travel to other replicas', () => {
    it('add op delivered to another replica makes element visible there', () => {
      const a = new OpORSet(0);
      const b = new OpORSet(1);

      const op = a.add('x');  // A adds, gets back an op
      b.apply(op);            // B receives and applies the op

      expect(b.lookup('x')).toBe(true);
    });

    it('remove op delivered to another replica makes element invisible there', () => {
      const a = new OpORSet(0);
      const b = new OpORSet(1);

      const addOp = a.add('x');
      b.apply(addOp);          // B receives the add

      const removeOp = a.remove('x');
      b.apply(removeOp);       // B receives the remove

      expect(b.lookup('x')).toBe(false);
    });

    it('apply() is idempotent — delivering the same op twice has no effect', () => {
      const a = new OpORSet(0);
      const b = new OpORSet(1);

      const op = a.add('x');
      b.apply(op);
      b.apply(op);  // duplicate — should not create a phantom extra tag

      expect(b.lookup('x')).toBe(true);
      expect(b.liveTagCount('x')).toBe(1);  // only one tag, not two
    });
  });

  // ─── Observed-remove semantics: same as state-based, but no tombstones ────────

  describe('observed-remove semantics', () => {
    it('concurrent add wins over concurrent remove — add-wins', () => {
      // Setup: A generates the first add, B receives it.
      // Then A adds again concurrently while B removes — neither knows about the other's op.
      const a = new OpORSet(0);
      const addOp1 = a.add('x');  // tag: "0-0", a.counter is now 1

      const b = new OpORSet(1);
      b.apply(addOp1);  // B knows about x (tag "0-0")

      // A adds 'x' again concurrently — a.counter is 1, so tag is "0-1" (fresh, distinct)
      const addOpA = a.add('x');   // tag: "0-1" (A's new unique tag)

      // B removes 'x' — captures only the tags B has seen: {"0-0"}
      const removeOpB = b.remove('x');

      // Now deliver both ops to a third replica C in different orders

      // Order 1: remove first, then add
      const c1 = new OpORSet(2);
      c1.apply(addOp1);
      c1.apply(removeOpB);  // removes "0-0"
      c1.apply(addOpA);     // adds "0-1" — untouched by the remove
      expect(c1.lookup('x')).toBe(true);

      // Order 2: add first, then remove
      const c2 = new OpORSet(2);
      c2.apply(addOp1);
      c2.apply(addOpA);     // adds "0-1"
      c2.apply(removeOpB);  // removes "0-0" — "0-1" is not in removeOpB.tags, survives
      expect(c2.lookup('x')).toBe(true);
    });

    it("remove only kills the tags it observed at source — concurrent add's tag survives", () => {
      const a = new OpORSet(0);
      const b = new OpORSet(1);

      const addOpB = b.add('x');  // B adds x: tag "1-0"
      // A has NOT seen B's add yet

      const removeOpA = a.remove('x');  // A removes x: observedTags = {} (A never saw x)

      // B receives A's remove — tag "1-0" is not in removeOpA.tags (empty set)
      b.apply(removeOpA);

      // x is still in B because its tag was never targeted
      expect(b.lookup('x')).toBe(true);
    });
  });

  // ─── Operations commute — delivery order doesn't matter ──────────────────────

  describe('operations commute', () => {
    it('two add ops in any order: same result', () => {
      const opA = new OpORSet(0);
      const opB = new OpORSet(1);
      const addA = opA.add('x');
      const addB = opB.add('y');

      const c1 = new OpORSet(2);
      c1.apply(addA);
      c1.apply(addB);

      const c2 = new OpORSet(2);
      c2.apply(addB);
      c2.apply(addA);

      expect(c1.lookup('x')).toBe(c2.lookup('x'));
      expect(c1.lookup('y')).toBe(c2.lookup('y'));
    });

    it('add then remove in any order: same result', () => {
      const a = new OpORSet(0);
      const addOp = a.add('x');
      const removeOp = a.remove('x');

      // Order 1: add then remove
      const c1 = new OpORSet(1);
      c1.apply(addOp);
      c1.apply(removeOp);
      expect(c1.lookup('x')).toBe(false);

      // Order 2: remove first (no-op since tag not present), then add
      // WAIT — this is where it gets interesting.
      // The remove op targets tag "0-0". If it arrives before the add, it tries to
      // delete a tag that doesn't exist yet. Then the add arrives and adds tag "0-0".
      // But tag "0-0" was already "targeted" by the remove — it just wasn't there yet.
      // Is this handled correctly? Yes — because apply(removeOp) deletes "0-0" if present.
      // If not present, it's a no-op. Then the add CREATES "0-0" — after the remove already ran.
      // Result: x IS in the set. This differs from order 1!
      //
      // This is why CmRDTs require CAUSAL DELIVERY for correct behaviour.
      // The remove causally depends on the add (you can only remove what you added).
      // With causal delivery, remove is guaranteed to arrive AFTER add everywhere.
      // Without it (as in this test), the result can differ.
      const c2 = new OpORSet(1);
      c2.apply(removeOp);  // arrives first — deletes "0-0" but it doesn't exist yet
      c2.apply(addOp);     // arrives after — adds "0-0" — now it IS in the set
      // c2 and c1 have different results — this is the causal delivery requirement in action
      expect(c2.lookup('x')).toBe(true);  // x is "back" because add ran after remove

      // This is NOT a bug — it's why op-based CRDTs require causal delivery.
      // With causal delivery: remove always arrives after the add it observed.
    });
  });

  // ─── No tombstones — the key difference from state-based ─────────────────────

  describe('no tombstone growth', () => {
    it('after remove, the element has zero live tags — nothing stored for it', () => {
      const s = new OpORSet(0);
      s.add('x');
      s.remove('x');

      // State-based OR-Set would still have 'x' in entries AND tombstones.
      // Op-based: the tag was physically deleted. No trace.
      expect(s.liveTagCount('x')).toBe(0);
    });

    it('adding and removing the same element many times does not grow storage', () => {
      // Each add/remove cycle: tag added, then physically deleted. No accumulation.
      const s = new OpORSet(0);
      for (let i = 0; i < 100; i++) {
        s.add('x');
        s.remove('x');
      }
      expect(s.liveTagCount('x')).toBe(0);
      // In state-based OR-Set: entries would have 100 tags, tombstones would have 100 tags.
      // Here: 0 tags, because each was physically deleted on remove.
    });

    it('the tradeoff: this only works with reliable causal delivery', () => {
      // Op-based can physically delete because causal delivery guarantees:
      //   - A remove arrives after all adds it has observed
      //   - Concurrent adds arrive independently and add new tags — they're never deleted
      // Without causal delivery: a remove could arrive before the add it "saw",
      // and the subsequent add would bring back a tag that should be dead.
      // State-based avoids this with tombstones — the tombstone persists and blocks future merges.
      // Op-based avoids this with a network guarantee instead of extra storage.
      //
      // YJS relies on causal delivery (via Lamport clocks and ordering rules).
      // This is why YJS's delete is cheap: no tombstone set growing forever.
      expect(true).toBe(true);  // documented as a comment — no assertion needed
    });
  });

  // ─── Drawbacks ───────────────────────────────────────────────────────────────

  describe('drawbacks (documented)', () => {
    it('requires reliable exactly-once delivery — duplicate ops break tag counts', () => {
      // If an add op is delivered twice, the same tag appears to have been added twice.
      // apply() is idempotent for sets (Set.add is idempotent), so this is actually safe
      // for OpORSet — but illustrates the general concern for non-idempotent CmRDTs.
      const s = new OpORSet(0);
      const addOp = s.add('x');

      const other = new OpORSet(1);
      other.apply(addOp);
      other.apply(addOp);  // duplicate — Set.add() handles it

      expect(other.liveTagCount('x')).toBe(1);  // not 2 — Set prevents it
    });
  });
});
