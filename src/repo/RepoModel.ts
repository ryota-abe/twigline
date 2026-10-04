import * as path from 'node:path';
import type { ChangeKind, RepoId } from '../../shared/protocol';
import { GitRunner, parseGitVersion, versionAtLeast } from '../git/GitRunner';
import { GitError } from '../git/errors';
import type { HostEnv } from '../host/HostEnv';
import type { GitHelpers } from '../ipc/helpers';
import { Emitter, type Disposable } from '../util/event';
import { SnapshotService } from '../services/SnapshotService';
import { StatusService } from '../services/StatusService';
import { LogService } from '../services/LogService';
import { DiffService } from '../services/DiffService';
import { StageService } from '../services/StageService';
import { OpsService } from '../services/OpsService';
import { RebaseService } from '../services/RebaseService';
import { CompareService } from '../services/CompareService';
import { CommitService } from '../services/CommitService';
import { PullRequestService } from '../services/PullRequestService';
import { RepoWatcher } from './RepoWatcher';
import { toRepoId } from './repoId';

export const ALL_KINDS: ChangeKind[] = ['status', 'refs', 'head', 'stash', 'sequence', 'config'];

export { toRepoId };

export interface GitInfo {
  path: string;
  version: string;
  parts: [number, number, number];
}

/**
 * Context of one repository. Holds the GitRunner, the services and the aggregation of changes (RepoWatcher -> repo/changed).
 * Does not import vscode (goes through HostEnv).
 */
export class RepoModel implements Disposable {
  readonly id: RepoId;
  readonly runner: GitRunner;
  readonly snapshot: SnapshotService;
  readonly status: StatusService;
  readonly log: LogService;
  readonly diff: DiffService;
  readonly stage: StageService;
  readonly ops: OpsService;
  readonly rebase: RebaseService;
  readonly compare: CompareService;
  readonly commit: CommitService;
  readonly pullRequests: PullRequestService;
  readonly features: { stashStaged: boolean; updateRefs: boolean; pullAutostash: boolean; mergeTree: boolean; aheadBehind: boolean };

  private readonly changeEmitter = new Emitter<ChangeKind[]>();
  readonly onDidChange = this.changeEmitter.event;

  private opDepth = 0;
  private pending = new Set<ChangeKind>();
  private flushTimer?: NodeJS.Timeout;
  private watcher?: RepoWatcher;
  private disposed = false;

  private constructor(
    readonly root: string,
    readonly gitDir: string,
    readonly commonDir: string,
    readonly git: GitInfo,
    readonly env: HostEnv,
    readonly helpers: GitHelpers,
    readonly objectFormat: 'sha1' | 'sha256',
  ) {
    this.id = toRepoId(root);
    this.runner = new GitRunner({ gitPath: git.path, cwd: root, log: (e) => env.logCommand(e) });
    this.features = {
      stashStaged: versionAtLeast(git.parts, 2, 35),
      updateRefs: versionAtLeast(git.parts, 2, 38),
      pullAutostash: versionAtLeast(git.parts, 2, 27),
      mergeTree: versionAtLeast(git.parts, 2, 38),
      aheadBehind: versionAtLeast(git.parts, 2, 41),
    };
    this.snapshot = new SnapshotService(this);
    this.status = new StatusService(this);
    this.log = new LogService(this);
    this.diff = new DiffService(this);
    this.stage = new StageService(this);
    this.ops = new OpsService(this);
    this.rebase = new RebaseService(this);
    this.compare = new CompareService(this);
    this.commit = new CommitService(this);
    this.pullRequests = new PullRequestService(this);
  }

  get name(): string {
    return path.basename(this.root);
  }

  /** Open a repository root. The git location and version are the ones decided by the caller. */
  static async open(root: string, git: GitInfo, env: HostEnv, helpers: GitHelpers): Promise<RepoModel> {
    const probe = new GitRunner({ gitPath: git.path, cwd: root, log: (e) => env.logCommand(e) });
    const res = await probe.run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
    const [top, gitDir, common] = res.stdout.toString('utf8').split(/\r?\n/);
    if (!top || !gitDir) throw new GitError('invalid', `Not a git repository: ${root}`);
    const commonDir = path.resolve(root, common || gitDir);
    let objectFormat: 'sha1' | 'sha256' = 'sha1';
    try {
      const f = await probe.run(['rev-parse', '--show-object-format'], { noThrow: true });
      if (f.stdout.toString().trim() === 'sha256') objectFormat = 'sha256';
    } catch {
      /* sha1 for old git */
    }
    return new RepoModel(path.resolve(top), path.resolve(gitDir), commonDir, git, env, helpers, objectFormat);
  }

  static async detectGit(gitPath: string): Promise<GitInfo> {
    const probe = new GitRunner({ gitPath, cwd: process.cwd() });
    const res = await probe.run(['--version']);
    const v = parseGitVersion(res.stdout.toString('utf8'));
    return { path: gitPath, version: v.text, parts: v.parts };
  }

  /** Start watching .git (when the panel opens) */
  startWatching(autoRefresh: boolean): void {
    if (this.watcher || !autoRefresh) return;
    this.watcher = new RepoWatcher(this, (kinds) => this.notifyChanged(kinds));
  }

  stopWatching(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  /** Changes in the working tree (state.onDidChange of vscode.git). Reflected only while watching */
  worktreeChanged(): void {
    this.watcher?.worktreeChanged();
  }

  /** Changes from outside. While Twigline is writing, hold them and notify once when it finishes. */
  notifyChanged(kinds: Iterable<ChangeKind>): void {
    for (const k of kinds) this.pending.add(k);
    if (this.opDepth > 0) return;
    this.scheduleFlush(0);
  }

  /** Suppress change notifications during a write operation */
  async runOp<T>(kinds: ChangeKind[], fn: () => Promise<T>): Promise<T> {
    this.opDepth++;
    try {
      return await fn();
    } finally {
      for (const k of kinds) this.pending.add(k);
      this.opDepth--;
      if (this.opDepth === 0) {
        this.snapshot.invalidate();
        this.status.invalidate();
        // Watcher events arrive a little late, so fold those into the same notification
        this.scheduleFlush(120);
      }
    }
  }

  private scheduleFlush(delay: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.opDepth > 0 || this.pending.size === 0 || this.disposed) return;
      const kinds = [...this.pending];
      this.pending.clear();
      if (kinds.some((k) => k !== 'status')) this.snapshot.invalidate();
      if (kinds.includes('status') || kinds.includes('head') || kinds.includes('sequence')) this.status.invalidate();
      this.changeEmitter.fire(kinds);
    }, delay);
  }

  /** Normalize a path in the repository and reject ones that point outside the root */
  resolvePath(rel: string): string {
    if (typeof rel !== 'string' || rel.includes('\0')) throw new GitError('invalid', 'Invalid path');
    const abs = path.resolve(this.root, rel);
    const relBack = path.relative(this.root, abs);
    if (relBack === '' || relBack.startsWith('..') || path.isAbsolute(relBack)) {
      throw new GitError('invalid', `Path is outside the repository: ${rel}`);
    }
    return abs;
  }

  /** Repository-relative path to pass to git (separator is /) */
  relPath(rel: string): string {
    return path.relative(this.root, this.resolvePath(rel)).split(path.sep).join('/');
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.stopWatching();
    this.log.dispose();
    this.runner.dispose();
    this.changeEmitter.dispose();
  }
}
