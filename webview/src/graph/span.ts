// The span of a branch for the selected commit: from where the tree forks to where it is merged.
//
// Rows come children first. Walking down follows first parents until a commit that has several children (the fork point).
// Walking up follows the only child that continues the line until a commit that takes it as a second or later parent (the merge).
// Selecting a merge commit shows the branch it merges (via its second parent) instead.
// A line that is never merged is emphasized from its tip (a commit with a ref) down to the fork point,
// only if there is no merge commit on the way.

import type { GraphRow } from './layout';

interface Node {
  sha: string;
  parents: readonly string[];
}

export interface BranchSpan {
  /** Index of the merge commit (the upper end) */
  from: number;
  /** Index of the fork point (the lower end) */
  to: number;
  /** Color number of the branch's lane */
  color: number;
}

const childrenCache = new WeakMap<readonly Node[], Map<string, number[]>>();

/** SHA -> indices of its children (ascending) */
function childrenOf(rows: readonly Node[]): Map<string, number[]> {
  let map = childrenCache.get(rows);
  if (!map) {
    map = new Map();
    rows.forEach((r, i) => {
      for (const p of r.parents) {
        const list = map!.get(p);
        if (list) list.push(i);
        else map!.set(p, [i]);
      }
    });
    childrenCache.set(rows, map);
  }
  return map;
}

/**
 * Walk down the first parents to the fork point. Returns the index of the commit at the bottom (the fork point if it is loaded).
 * With `strict`, returns -1 unless it reaches a loaded fork point without passing a merge commit
 */
function walkDown(rows: readonly Node[], index: Map<string, number>, children: Map<string, number[]>, start: number, strict = false): number {
  let cur = start;
  for (;;) {
    if (strict && rows[cur].parents.length > 1) return -1;
    const p = rows[cur].parents[0];
    const pi = p === undefined ? undefined : index.get(p);
    if (pi === undefined) return strict ? -1 : cur;
    if ((children.get(p)?.length ?? 0) > 1) return pi;
    cur = pi;
  }
}

/** Walk up the line. Ends at the merge commit, at the tip if it is never merged, or is undefined if the line is ambiguous */
function walkUp(rows: readonly Node[], children: Map<string, number[]>, start: number): { merge: number } | { tip: number } | undefined {
  let cur = start;
  for (;;) {
    const sha = rows[cur].sha;
    const kids = children.get(sha) ?? [];
    if (kids.length === 0) return { tip: cur };
    const merges = kids.filter((k) => rows[k].parents[0] !== sha);
    const straight = kids.filter((k) => rows[k].parents[0] === sha);
    if (merges.length > 0) return straight.length === 0 && merges.length === 1 ? { merge: merges[0] } : undefined;
    if (straight.length !== 1) return undefined;
    cur = straight[0];
  }
}

/** `tips` are the SHAs that carry a ref (branch, remote branch or tag); only those count as the tip of an unmerged line */
export function branchSpan(rows: readonly Node[], graph: readonly GraphRow[], sha: string, tips: ReadonlySet<string> = new Set()): BranchSpan | undefined {
  const index = new Map<string, number>();
  rows.forEach((r, i) => index.set(r.sha, i));
  const at = index.get(sha);
  if (at === undefined || graph.length < rows.length) return undefined;
  const children = childrenOf(rows);

  const up = walkUp(rows, children, at);
  if (up && 'merge' in up) {
    const to = walkDown(rows, index, children, at);
    return to > up.merge ? { from: up.merge, to, color: graph[at].color } : undefined;
  }
  if (up && tips.has(rows[up.tip].sha)) {
    const to = walkDown(rows, index, children, up.tip, true);
    if (to > up.tip) return { from: up.tip, to, color: graph[at].color };
  }

  // Merge commit: show the branch it brought in
  const second = rows[at].parents[1];
  const si = second === undefined ? undefined : index.get(second);
  if (si === undefined) return undefined;
  const to = walkDown(rows, index, children, si);
  return to > at ? { from: at, to, color: graph[si].color } : undefined;
}
