import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLaneState, layoutRows } from '../../webview/src/graph/layout';
import type { RepoModel } from '../../src/repo/RepoModel';
import { makeRepo, openModel, type TempRepo } from '../unit/helpers';

// Timing of the performance targets (npm run test:perf). Baseline: 100,000 commits.
//   From showing the panel to the first render of history: within 500ms (including the first 500 entries of git log)
//   Reflecting an external change: within 1 second

const N = Number(process.env.TWIGLINE_PERF_COMMITS ?? 100_000);
let repo: TempRepo;
let model: RepoModel;

beforeAll(async () => {
  repo = makeRepo();
  // Create N commits with fast-import (mixing in branches and merges)
  const lines: string[] = [];
  for (let i = 1; i <= N; i++) {
    const msg = `commit ${i}`;
    const onBranch = i % 50 >= 45 && i % 50 <= 48;
    lines.push(`commit refs/heads/${onBranch ? 'side' : 'main'}`, `mark :${i}`, `committer T <t@e> ${1_600_000_000 + i} +0000`, `data ${msg.length}`, msg);
    if (i > 1) {
      if (onBranch && i % 50 === 45) lines.push(`from :${i - 1}`);
      else if (onBranch) lines.push(`from :${i - 1}`);
      else if (i % 50 === 49) lines.push(`from :${i - 5}`, `merge :${i - 1}`);
      else lines.push(`from :${i - 1}`);
    }
    lines.push(`M 644 inline f${i % 100}.txt`, `data ${String(i).length}`, `${i}`, '');
  }
  const started = Date.now();
  repo.git(['fast-import', '--quiet'], { input: lines.join('\n') + '\n' });
  repo.git(['reset', '-q', '--hard', 'main']);
  console.log(`[perf] created ${N} commits in ${Date.now() - started} ms`);
  model = await openModel(repo.dir);
}, 600_000);

afterAll(() => {
  model?.dispose();
  try {
    repo?.cleanup();
  } catch {
    /* When git still holds the directory on Windows */
  }
});

describe(`history of ${N} commits`, () => {
  it('returns the first page quickly and continues without re-scanning', async () => {
    const q = { branches: 'all' as const, includeRemotes: true, includeStashes: false, order: 'date' as const };
    await model.snapshot.get();
    let t = performance.now();
    const p1 = await model.log.page(q, undefined, 0, 500);
    const first = performance.now() - t;
    t = performance.now();
    const p2 = await model.log.page(q, p1.cursor!, 500, 500);
    const second = performance.now() - t;
    t = performance.now();
    const skip = await model.log.page(q, undefined, 50_000 % N, 500);
    const skipped = performance.now() - t;
    console.log(`[perf] first page ${first.toFixed(0)} ms, next page (cursor) ${second.toFixed(0)} ms, recreate with --skip ${skipped.toFixed(0)} ms`);
    expect(p1.rows).toHaveLength(500);
    expect(p2.rows).toHaveLength(500);
    expect(skip.rows.length).toBeGreaterThan(0);
    expect(first).toBeLessThan(3000);
  });

  it('lays out the graph for all rows', async () => {
    const rows = [];
    const q = { branches: 'all' as const, includeRemotes: true, includeStashes: false, order: 'date' as const };
    let cursor: string | undefined;
    const t0 = performance.now();
    for (;;) {
      const page = await model.log.page(q, cursor, rows.length, 10_000);
      rows.push(...page.rows);
      if (page.done || !page.cursor) break;
      cursor = page.cursor;
    }
    const loaded = performance.now() - t0;
    const t1 = performance.now();
    const graph = layoutRows(createLaneState(), rows);
    const layout = performance.now() - t1;
    const maxWidth = graph.reduce((m, g) => Math.max(m, g.width), 0);
    console.log(`[perf] loaded ${rows.length} rows in ${loaded.toFixed(0)} ms, layout ${layout.toFixed(0)} ms, max lanes ${maxWidth}`);
    expect(rows).toHaveLength(N);
    expect(layout).toBeLessThan(2000);
  });

  it('reads status and snapshot', async () => {
    let t = performance.now();
    model.snapshot.invalidate();
    await model.snapshot.get();
    const snap = performance.now() - t;
    t = performance.now();
    model.status.invalidate();
    await model.status.get();
    const status = performance.now() - t;
    console.log(`[perf] snapshot ${snap.toFixed(0)} ms, status ${status.toFixed(0)} ms`);
    expect(snap).toBeLessThan(2000);
  });
});
