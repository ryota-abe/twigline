import type { RefComparison, Sha } from '../../shared/protocol';
import type { RepoModel } from '../repo/RepoModel';

// How two commits relate, for the dialogs that show what an operation would do before it runs.
// Only reads the repository (merge-tree --write-tree writes objects, but no refs, index or working tree).

/** Upper limit of incomingFiles */
const MAX_FILES = 2000;

export class CompareService {
  constructor(private readonly repo: RepoModel) {}

  async compare(ours: string, theirs: string, opts: { files?: boolean; conflicts?: boolean } = {}, signal?: AbortSignal): Promise<RefComparison | null> {
    const [a, b] = await Promise.all([this.resolve(ours, signal), this.resolve(theirs, signal)]);
    if (!a || !b) return null;
    const runner = this.repo.runner;
    const [counts, base] = await Promise.all([
      runner.run(['rev-list', '--left-right', '--count', `${a}...${b}`], { signal }),
      runner.run(['merge-base', a, b], { signal, noThrow: true }),
    ]);
    const [ahead, behind] = counts.stdout.toString('utf8').trim().split(/\s+/).map(Number);
    const mergeBase = base.exitCode === 0 ? base.stdout.toString('utf8').trim() : null;
    const result: RefComparison = { ours: a, theirs: b, ahead: ahead || 0, behind: behind || 0, mergeBase };

    if (opts.files && mergeBase && result.behind > 0) {
      const res = await runner.run(['diff', '--name-only', '-z', '--no-renames', mergeBase, b], { signal });
      const files = splitNul(res.stdout);
      result.incomingFiles = files.slice(0, MAX_FILES);
      if (files.length > MAX_FILES) result.incomingFilesTruncated = true;
    }
    if (opts.conflicts && result.ahead > 0 && result.behind > 0) {
      result.conflicts = mergeBase && this.repo.features.mergeTree ? await this.conflicts(a, b, signal) : null;
    }
    return result;
  }

  private async resolve(rev: string, signal?: AbortSignal): Promise<Sha | null> {
    const res = await this.repo.runner.run(['rev-parse', '-q', '--verify', '--end-of-options', `${rev}^{commit}`], { signal, noThrow: true });
    return res.exitCode === 0 ? res.stdout.toString('utf8').trim() : null;
  }

  /** Paths a merge would conflict in. Exit code 1 means conflicts; the output is the tree, then the paths (NUL separated) */
  private async conflicts(a: Sha, b: Sha, signal?: AbortSignal): Promise<string[] | null> {
    const res = await this.repo.runner.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], { signal, noThrow: true });
    if (res.exitCode === 0) return [];
    if (res.exitCode !== 1) return null;
    return [...new Set(splitNul(res.stdout).slice(1))];
  }
}

function splitNul(buf: Buffer): string[] {
  return buf
    .toString('utf8')
    .split('\0')
    .filter((s) => s.length > 0);
}
