import { describe, expect, it } from 'vitest';
import { createLaneState, layoutRows } from '../../webview/src/graph/layout';
import { branchSpan } from '../../webview/src/graph/span';

// M merges feature (F2 - F1) into main (C - B - A)
const rows = [
  { sha: 'M', parents: ['C', 'F2'] },
  { sha: 'F2', parents: ['F1'] },
  { sha: 'C', parents: ['B'] },
  { sha: 'F1', parents: ['B'] },
  { sha: 'B', parents: ['A'] },
  { sha: 'A', parents: [] as string[] },
];
const graph = layoutRows(createLaneState(), rows);

describe('branchSpan', () => {
  it('covers a branch commit from the merge to the fork point', () => {
    expect(branchSpan(rows, graph, 'F1')).toMatchObject({ from: 0, to: 4 });
    expect(branchSpan(rows, graph, 'F2')).toMatchObject({ from: 0, to: 4 });
  });

  it('shows the merged branch when a merge commit is selected', () => {
    expect(branchSpan(rows, graph, 'M')).toMatchObject({ from: 0, to: 4 });
  });

  it('has no span for the fork point or main line commits', () => {
    expect(branchSpan(rows, graph, 'B')).toBeUndefined();
    expect(branchSpan(rows, graph, 'C')).toBeUndefined();
    expect(branchSpan(rows, graph, 'A')).toBeUndefined();
  });

  describe('unmerged branch', () => {
    // T2 - T1 forked from B, next to main (C - B - A)
    const r = [
      { sha: 'T2', parents: ['T1'] },
      { sha: 'T1', parents: ['B'] },
      { sha: 'C', parents: ['B'] },
      { sha: 'B', parents: ['A'] },
      { sha: 'A', parents: [] as string[] },
    ];
    const g = layoutRows(createLaneState(), r);

    it('is emphasized from the tip with a ref to the fork point', () => {
      const tips = new Set(['T2', 'C']);
      expect(branchSpan(r, g, 'T1', tips)).toMatchObject({ from: 0, to: 3 });
      expect(branchSpan(r, g, 'T2', tips)).toMatchObject({ from: 0, to: 3 });
    });

    it('is not emphasized when the tip has no ref', () => {
      expect(branchSpan(r, g, 'T1')).toBeUndefined();
    });

    it('is not emphasized for the fork point or the other line', () => {
      const tips = new Set(['T2', 'C']);
      expect(branchSpan(r, g, 'B', tips)).toBeUndefined();
    });

    it('is not emphasized when it reaches no fork point or has a merge on the way', () => {
      // The main line: its tip is a merge, and its first-parent chain passes the merge to the fork
      expect(branchSpan(rows, graph, 'M', new Set(['M']))).toMatchObject({ from: 0, to: 4 }); // the merged branch, as before
      expect(branchSpan(rows, graph, 'C', new Set(['M']))).toBeUndefined();
      // A line whose parent is not loaded
      const cut = [{ sha: 'X', parents: ['gone'] }];
      expect(branchSpan(cut, layoutRows(createLaneState(), cut), 'X', new Set(['X']))).toBeUndefined();
    });
  });
});
