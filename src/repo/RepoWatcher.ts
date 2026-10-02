import * as path from 'node:path';
import type { ChangeKind } from '../../shared/protocol';
import type { Disposable } from '../util/event';
import type { RepoModel } from './RepoModel';

// Collects changes to .git for 250ms and then decides their kind.

/** Turn a path relative to .git (or the common directory), separated by /, into a kind of change */
export function classifyGitPath(rel: string): ChangeKind[] {
  const p = rel.replace(/\\/g, '/');
  if (!p || p.endsWith('.lock')) return [];
  if (p.startsWith('objects/') || p === 'objects') return [];
  if (p === 'index') return ['status'];
  if (p === 'HEAD') return ['head', 'status'];
  if (p === 'refs/stash' || p === 'logs/refs/stash') return ['stash'];
  if (p.startsWith('logs/')) return [];
  if (p === 'FETCH_HEAD') return ['refs'];
  if (p === 'packed-refs' || p.startsWith('refs/') || p === 'refs') return ['refs'];
  if (
    p === 'MERGE_HEAD' ||
    p === 'MERGE_MSG' ||
    p === 'CHERRY_PICK_HEAD' ||
    p === 'REVERT_HEAD' ||
    p === 'REBASE_HEAD' ||
    p.startsWith('rebase-merge') ||
    p.startsWith('rebase-apply') ||
    p.startsWith('sequencer')
  ) {
    return ['sequence', 'status'];
  }
  if (p === 'config') return ['config'];
  if (p === 'modules' || p.startsWith('modules/')) return [];
  return [];
}

export class RepoWatcher implements Disposable {
  private readonly subscriptions: Disposable[] = [];
  private pending = new Set<ChangeKind>();
  private timer?: NodeJS.Timeout;

  constructor(
    repo: RepoModel,
    private readonly onKinds: (kinds: Set<ChangeKind>) => void,
  ) {
    const dirs = new Set([repo.gitDir, repo.commonDir]);
    for (const dir of dirs) {
      this.subscriptions.push(repo.env.watch(dir, (abs) => this.onFile(dir, abs)));
    }
  }

  private onFile(base: string, abs: string): void {
    const rel = path.relative(base, abs);
    if (rel.startsWith('..')) return;
    const kinds = classifyGitPath(rel);
    if (kinds.length === 0) return;
    for (const k of kinds) this.pending.add(k);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const kinds = this.pending;
      this.pending = new Set();
      this.onKinds(kinds);
    }, 250);
  }

  /** Called from working tree changes (state.onDidChange of vscode.git) */
  worktreeChanged(): void {
    this.pending.add('status');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const kinds = this.pending;
      this.pending = new Set();
      this.onKinds(kinds);
    }, 250);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions.length = 0;
  }
}
