// Lane assignment for the graph. A pure function on the webview side that carries the lane state across pages.
//
// Commits arrive in an order where children come before parents. Each lane remembers one "commit expected next".
// For each row, the commit is placed in a lane that was waiting for it, and the waiting for its parents is registered.
//  - If several lanes were waiting, place it at the left end and release the rest, which merge in this row ([B, B] -> [C, .])
//  - The first parent continues straight in the same lane (the color does not change either)
//  - For the second and later parents, go to a lane that is already waiting for that parent if there is one, otherwise take a free lane
//  - Lanes are not packed to the left; the next new branch reuses a released number

export type Sha = string;

export interface LaneState {
  /** The commit each lane is waiting for (null is free) */
  lanes: (Sha | null)[];
  /** Color number of a lane (assigned when it is taken) */
  colors: number[];
  nextColor: number;
  /** SHA -> numbers of the lanes waiting for it (ascending) */
  waiting: Map<Sha, number[]>;
}

export interface Segment {
  lane: number;
  color: number;
}

export interface DownEdge {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  /** Lane where the node is placed */
  lane: number;
  color: number;
  /** Lines gathering into the node from above */
  up: Segment[];
  /** Lines passing vertically through this row */
  through: Segment[];
  /** Lines going from the node to its parents */
  down: DownEdge[];
  /** Number of lanes needed for drawing */
  width: number;
}

export function createLaneState(): LaneState {
  return { lanes: [], colors: [], nextColor: 0, waiting: new Map() };
}

export function cloneLaneState(s: LaneState): LaneState {
  return {
    lanes: [...s.lanes],
    colors: [...s.colors],
    nextColor: s.nextColor,
    waiting: new Map([...s.waiting].map(([k, v]) => [k, [...v]])),
  };
}

function allocate(s: LaneState, reserved: number): number {
  let i = s.lanes.indexOf(null);
  while (i >= 0 && i === reserved) i = s.lanes.indexOf(null, i + 1);
  if (i < 0) {
    i = s.lanes.length;
    if (i === reserved) i++;
    while (s.lanes.length <= i) s.lanes.push(null);
  }
  s.colors[i] = s.nextColor++;
  return i;
}

function wait(s: LaneState, lane: number, sha: Sha): void {
  s.lanes[lane] = sha;
  const list = s.waiting.get(sha);
  if (!list) s.waiting.set(sha, [lane]);
  else {
    list.push(lane);
    list.sort((a, b) => a - b);
  }
}

export function layoutRow(s: LaneState, c: { sha: Sha; parents: readonly Sha[] }): GraphRow {
  const up = s.waiting.get(c.sha) ?? [];
  s.waiting.delete(c.sha);

  // Lines passing vertically through this row (lanes that are not waiting for this commit)
  const through: Segment[] = [];
  for (let i = 0; i < s.lanes.length; i++) {
    const w = s.lanes[i];
    if (w !== null && w !== c.sha) through.push({ lane: i, color: s.colors[i] });
  }

  // Place at the left end of the lanes that were waiting. If nobody was waiting, it is the tip of a new branch
  const lane = up.length > 0 ? up[0] : allocate(s, -1);
  const upSegs = up.map((i) => ({ lane: i, color: s.colors[i] }));
  for (const i of up) s.lanes[i] = null;

  const down: DownEdge[] = [];
  c.parents.forEach((p, k) => {
    if (k === 0) {
      // The first parent goes straight (even if other lanes wait for the same parent, they merge at the parent's row)
      wait(s, lane, p);
      down.push({ from: lane, to: lane, color: s.colors[lane] });
      return;
    }
    const existing = s.waiting.get(p);
    if (existing && existing.length > 0) {
      // Go to a parent that someone is already waiting for
      const j = existing[0];
      down.push({ from: lane, to: j, color: s.colors[j] });
      return;
    }
    const n = allocate(s, lane);
    wait(s, n, p);
    down.push({ from: lane, to: n, color: s.colors[n] });
  });

  while (s.lanes.length > 0 && s.lanes[s.lanes.length - 1] === null) s.lanes.pop();

  let width = lane + 1;
  for (const t of through) width = Math.max(width, t.lane + 1);
  for (const u of upSegs) width = Math.max(width, u.lane + 1);
  for (const d of down) width = Math.max(width, d.to + 1);
  return { lane, color: s.colors[lane], up: upSegs, through, down, width };
}

export function layoutRows(s: LaneState, rows: readonly { sha: Sha; parents: readonly Sha[] }[]): GraphRow[] {
  return rows.map((r) => layoutRow(s, r));
}
