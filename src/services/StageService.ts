import { GitError } from '../git/errors';
import { buildPatch, type PatchMode } from '../git/PatchBuilder';
import type { RepoModel } from '../repo/RepoModel';

/** Staging by file, hunk or line */
export class StageService {
  constructor(private readonly repo: RepoModel) {}

  /** Pass paths on stdin separated by NUL (avoids command-line length limits and argument injection) */
  private pathspecInput(paths: string[]): { args: string[]; stdin: Buffer } {
    const rels = paths.map((p) => this.repo.relPath(p));
    return {
      args: ['--pathspec-from-file=-', '--pathspec-file-nul'],
      stdin: Buffer.from(rels.join('\0') + '\0', 'utf8'),
    };
  }

  async stagePaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const ps = this.pathspecInput(paths);
    await this.repo.runOp(['status'], () => this.repo.runner.run(['add', '-A', ...ps.args], { queue: 'write', stdin: ps.stdin }));
  }

  async unstagePaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const snap = await this.repo.snapshot.get();
    const ps = this.pathspecInput(paths);
    await this.repo.runOp(['status'], () =>
      snap.head.unborn
        ? // Before the first commit there is no HEAD, so remove from the index
          this.repo.runner.run(['rm', '--cached', '-r', '-q', '--ignore-unmatch', ...ps.args], { queue: 'write', stdin: ps.stdin })
        : this.repo.runner.run(['restore', '--staged', ...ps.args], { queue: 'write', stdin: ps.stdin }),
    );
  }

  /** Line-level operations. Builds a patch from the raw bytes of the diff held by the host and runs git apply. */
  async applyLines(diffId: string, lineIds: number[], action: PatchMode): Promise<void> {
    const cached = this.repo.diff.getCached(diffId);
    if (!cached) throw new GitError('stale', 'The diff is no longer available. It has been refreshed.');
    const expected = action === 'unstage' ? 'index' : 'worktree';
    if (cached.target.kind !== expected) throw new GitError('invalid', `Cannot ${action} lines of this diff`);
    if (cached.raw.deletedFile || cached.raw.binary || cached.raw.submodule) {
      throw new GitError('invalid', 'Line operations are not available for this file');
    }
    if (cached.untracked && action === 'discard') {
      throw new GitError('invalid', 'Use Discard to remove untracked files');
    }

    await this.repo.diff.assertFresh(cached);
    const patch = buildPatch(cached.raw, new Set(lineIds), action);
    if (!patch) return;

    const args = ['apply', '--recount', '--whitespace=nowarn', '--unidiff-zero'];
    if (action !== 'discard') args.push('--cached');
    if (action !== 'stage') args.push('--reverse');

    await this.repo.runOp(['status'], async () => {
      const check = await this.repo.runner.run([...args, '--check', '-'], { queue: 'write', stdin: patch, noThrow: true });
      if (check.exitCode !== 0) {
        throw new GitError('stale', 'The selected lines could not be applied. The diff has been refreshed.', {
          command: check.command,
          stderr: check.stderr,
        });
      }
      await this.repo.runner.run([...args, '-'], { queue: 'write', stdin: patch });
    });
  }
}
