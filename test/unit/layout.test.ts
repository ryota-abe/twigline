import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLaneState, layoutRow, layoutRows, type GraphRow } from '../../webview/src/graph/layout';

// Graph layout: verify invariants on random DAGs.
//  - Two lines never use the same lane in the same row
//  - Every edge ends at its parent's row
//  - The number of lanes never exceeds the number of branches alive at once

interface C {
  sha: string;
  parents: string[];
}

/** A DAG where children come before parents (the i-th parent is after i) */
const dagArb = fc.integer({ min: 1, max: 60 }).chain((n) =>
  fc
    .array(
      fc.record({
        count: fc.nat({ max: 3 }),
        picks: fc.array(fc.nat(), { minLength: 3, maxLength: 3 }),
        missing: fc.boolean(),
      }),
      { minLength: n, maxLength: n },
    )
    .map((specs) =>
      specs.map((spec, i): C => {
        const later = n - i - 1;
        const parents: string[] = [];
        if (later > 0) {
          for (let k = 0; k < Math.min(spec.count, later); k++) {
            const p = `c${i + 1 + (spec.picks[k] % later)}`;
            if (!parents.includes(p)) parents.push(p);
          }
        } else if (spec.missing && spec.count > 0) {
          parents.push('outside'); // A parent outside the loaded range
        }
        return { sha: `c${i}`, parents };
      }),
    ),
);

function checkInvariants(commits: C[], rows: GraphRow[]): void {
  const index = new Map(commits.map((c, i) => [c.sha, i]));
  rows.forEach((row, r) => {
    const through = row.through.map((t) => t.lane);
    const up = row.up.map((u) => u.lane);
    // Two lines never use the same lane in the same row
    expect(new Set(through).size).toBe(through.length);
    expect(new Set(up).size).toBe(up.length);
    for (const u of up) expect(through).not.toContain(u);
    expect(through).not.toContain(row.lane);
    if (up.length > 0) expect(up[0]).toBe(row.lane);
    for (const d of row.down) {
      expect(d.from).toBe(row.lane);
      // A newly taken line does not overlap a passing-through line (except when it goes to an existing lane)
      const joins = through.includes(d.to);
      if (!joins && d.to !== row.lane) expect(through).not.toContain(d.to);
    }
    // Every edge ends at its parent's row
    commits[r].parents.forEach((p, k) => {
      const target = index.get(p);
      const edge = row.down[k];
      expect(edge).toBeDefined();
      const end = target ?? rows.length;
      for (let q = r + 1; q < end; q++) {
        expect(rows[q].through.map((t) => t.lane)).toContain(edge.to);
      }
      if (target !== undefined) expect(rows[target].up.map((u) => u.lane)).toContain(edge.to);
    });
  });
}

describe('graph layout', () => {
  it('matches figure 7-1', () => {
    const s = createLaneState();
    const commits: C[] = [
      { sha: 'M', parents: ['A', 'F2'] },
      { sha: 'F2', parents: ['F1'] },
      { sha: 'A', parents: ['B'] },
      { sha: 'F1', parents: ['B'] },
      { sha: 'B', parents: ['C'] },
      { sha: 'C', parents: [] },
    ];
    const states: (string | null)[][] = [];
    const rows = commits.map((c) => {
      const r = layoutRow(s, c);
      states.push([...s.lanes]);
      return r;
    });
    expect(states).toEqual([['A', 'F2'], ['A', 'F1'], ['B', 'F1'], ['B', 'B'], ['C'], []]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0, 0]);
    // Two lanes gather at B and it is placed at the left end
    expect(rows[4].up.map((u) => u.lane)).toEqual([0, 1]);
    // The color does not change while it continues straight to the first parent
    expect(rows[2].color).toBe(rows[0].color);
    expect(rows[3].color).toBe(rows[1].color);
    expect(rows[1].color).not.toBe(rows[0].color);
  });

  it('reuses released lanes instead of compacting', () => {
    const s = createLaneState();
    const rows = layoutRows(s, [
      { sha: 'a', parents: ['x'] },
      { sha: 'b', parents: ['y'] },
      { sha: 'c', parents: ['z'] },
      { sha: 'y', parents: [] }, // Lane 1 becomes free
      { sha: 'd', parents: ['w'] }, // Reuse the freed lane 1
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 2, 1, 1]);
    expect(rows[4].through.map((t) => t.lane)).toEqual([0, 2]);
  });

  it('joins merge parents into a lane that already waits for them', () => {
    const s = createLaneState();
    const rows = layoutRows(s, [
      { sha: 'm', parents: ['a', 'b'] },
      { sha: 'n', parents: ['b'] },
      { sha: 'o', parents: ['c', 'b'] },
    ]);
    // The first parent b of n goes straight in lane 2 ([a, b, b]).
    // The second parent b of o does not take a new lane; it goes to lane 1, the leftmost lane already waiting for b
    expect(rows[1].lane).toBe(2);
    expect(rows[2].lane).toBe(3);
    expect(rows[2].down.map((d) => d.to)).toEqual([3, 1]);
  });

  it('continues lane state across pages', () => {
    const commits: C[] = Array.from({ length: 40 }, (_, i) => ({ sha: `c${i}`, parents: i < 39 ? [`c${i + 1}`, ...(i % 7 === 0 && i + 3 < 40 ? [`c${i + 3}`] : [])] : [] }));
    const whole = layoutRows(createLaneState(), commits);
    const s = createLaneState();
    const paged = [...layoutRows(s, commits.slice(0, 13)), ...layoutRows(s, commits.slice(13, 27)), ...layoutRows(s, commits.slice(27))];
    expect(paged).toEqual(whole);
  });

  it('satisfies invariants on random DAGs', () => {
    fc.assert(
      fc.property(dagArb, (commits) => {
        const s = createLaneState();
        let peak = 0;
        const rows = commits.map((c) => {
          const row = layoutRow(s, c);
          const active = s.lanes.filter((x) => x !== null).length;
          peak = Math.max(peak, active);
          // The number of lanes never exceeds the number of branches alive at once
          expect(s.lanes.length).toBeLessThanOrEqual(peak);
          expect(row.width).toBeLessThanOrEqual(Math.max(peak, 1) + 1);
          return row;
        });
        checkInvariants(commits, rows);
      }),
      { numRuns: 400 },
    );
  });
});
