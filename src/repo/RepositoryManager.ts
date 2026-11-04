import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoId } from '../../shared/protocol';
import type { HostEnv } from '../host/HostEnv';
import { gitPathSetting } from '../host/config';
import type { GitHelpers } from '../ipc/helpers';
import type { API, GitExtension, Repository } from '../types/git';
import { loadCore } from '../coreLoader';
import { addOther, hasOther, isTrustedRoot, othersStorageKey, removeOther, sanitizeOthers, type OtherRepository, type TrustContext } from './otherRepositories';
import type { GitInfo, RepoModel } from './RepoModel';
import { isSameOrInside, toRepoId } from './repoId';
import { repoStatus, repoStatusFromWorkingTree, type RepoStatus } from './repoStatus';

export interface RepoEntry {
  id: RepoId;
  root: string;
  name: string;
  /** A repository detected by vscode.git */
  gitRepo?: Repository;
  submodules: string[];
  /** A repository outside the workspace from the list of other repositories (vscode.git does not know it) */
  other?: boolean;
}

export interface HeadState {
  branch?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  commit?: string;
}

const NO_HEAD: HeadState = { ahead: 0, behind: 0, detached: false };

/** A repository with an open panel (see panelOpened) */
interface PanelRepo {
  model: RepoModel;
  /** For a repository vscode.git does not know: the last state read from the panel's git status, for the list and the status bar */
  state?: { head: HeadState; status: RepoStatus };
  dispose(): void;
}

/**
 * Discovers repositories through the vscode.git API and manages RepoId and RepoModel.
 * Also keeps the list of other repositories (outside the workspace, opened by the user; see otherRepositories.ts) and decides
 * where git may run without asking (isTrusted). vscode.git does not open repositories outside the workspace (its openRepository
 * leaves them to its "parent folder" prompt), so the state of those for the repository list comes from Twigline's own
 * `git status` while their panel is open.
 */
export class RepositoryManager implements vscode.Disposable {
  private api?: API;
  private initializing?: Promise<void>;
  private gitInfo?: Promise<GitInfo>;
  private readonly models = new Map<RepoId, Promise<RepoModel>>();
  /** When opened at a subdirectory etc.: the requested ID -> the ID of the root */
  private readonly aliases = new Map<RepoId, RepoId>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** The list of repositories or HEAD changed */
  readonly onDidChange = this.changeEmitter.event;
  private readonly stateSubs = new Map<RepoId, vscode.Disposable>();
  private readonly panelRepos = new Map<RepoId, PanelRepo>();
  /** Repositories the user confirmed for this session only (a fetch another extension asked for: not added to the list) */
  private readonly trustedForSession = new Set<RepoId>();

  constructor(
    private readonly env: HostEnv,
    private readonly helpers: GitHelpers,
    /** globalState, which keeps the list of other repositories (none in tests that do not need it) */
    private readonly memento?: vscode.Memento,
  ) {}

  /** Attach to vscode.git (once; later calls wait for the first) */
  initialize(): Promise<void> {
    this.initializing ??= this.attachGit();
    return this.initializing;
  }

  private async attachGit(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return;
    try {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      if (!exports.enabled) {
        this.disposables.push(exports.onDidChangeEnablement((enabled) => enabled && void this.attachApi(exports.getAPI(1))));
        return;
      }
      this.attachApi(exports.getAPI(1));
    } catch (e) {
      console.error('[twigline] vscode.git is not available', e);
    }
  }

  /** Wait until vscode.git has discovered the repositories of the workspace, at most `timeoutMs` (it may be disabled or slow) */
  async discovered(timeoutMs = 10_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sub: { dispose(): void } | undefined;
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      void this.initialize().then(() => {
        const api = this.api;
        if (!api || api.state === 'initialized') return resolve();
        sub = api.onDidChangeState((state) => state === 'initialized' && resolve());
      });
    });
    clearTimeout(timer);
    sub?.dispose();
  }

  private attachApi(api: API): void {
    this.api = api;
    this.disposables.push(
      api.onDidOpenRepository((r) => {
        this.watchState(r);
        this.changeEmitter.fire();
      }),
      api.onDidCloseRepository((r) => {
        const id = toRepoId(r.rootUri.fsPath);
        this.stateSubs.get(id)?.dispose();
        this.stateSubs.delete(id);
        this.changeEmitter.fire();
      }),
      api.onDidChangeState(() => this.changeEmitter.fire()),
    );
    for (const r of api.repositories) this.watchState(r);
    this.changeEmitter.fire();
  }

  private watchState(r: Repository): void {
    const id = toRepoId(r.rootUri.fsPath);
    if (this.stateSubs.has(id)) return;
    this.stateSubs.set(
      id,
      r.state.onDidChange(() => {
        // Working tree changes. Tell only the repositories that are open
        void this.models.get(id)?.then((m) => m.worktreeChanged(), () => undefined);
        this.changeEmitter.fire();
      }),
    );
  }

  get repositories(): RepoEntry[] {
    const list = (this.api?.repositories ?? []).map((r) => {
      const root = r.rootUri.fsPath;
      return {
        id: toRepoId(root),
        root,
        name: path.basename(root),
        gitRepo: r,
        submodules: r.state.submodules.map((s) => path.join(root, s.path)),
      };
    });
    return list.sort((a, b) => a.root.localeCompare(b.root));
  }

  /**
   * Other repositories, sorted by name. One that vscode.git now has (its folder was added to the workspace, say) is left out:
   * it is in `repositories`.
   */
  get otherRepositories(): RepoEntry[] {
    const known = new Set(this.repositories.map((r) => r.id));
    return this.readOthers()
      .map((o): RepoEntry => ({ id: toRepoId(o.root), root: o.root, name: path.basename(o.root), submodules: [], other: true }))
      .filter((e) => !known.has(e.id))
      .sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  }

  /** A repository of vscode.git or of the list of other repositories */
  findEntry(id: RepoId): RepoEntry | undefined {
    return this.repositories.find((r) => r.id === id) ?? this.otherRepositories.find((r) => r.id === id);
  }

  /** Whether vscode.git has opened the repository (it then reports its changes and state) */
  isKnownToGit(id: RepoId): boolean {
    return this.repositories.some((r) => r.id === id);
  }

  /** The repository that contains a file or folder */
  repositoryFor(uri: vscode.Uri): RepoEntry | undefined {
    const r = this.api?.getRepository(uri);
    if (r) return this.repositories.find((e) => e.id === toRepoId(r.rootUri.fsPath));
    return [...this.repositories, ...this.otherRepositories]
      .filter((e) => isSameOrInside(uri.fsPath, e.root))
      .sort((a, b) => b.id.length - a.id.length)[0];
  }

  // ---- Where git may run ----

  /**
   * Whether git may run in the repository at `root` (its top level, as git reports it) without asking the user:
   * inside a workspace folder, the exact root of a repository vscode.git has opened or of an other repository,
   * or a repository with an open panel or confirmed for this session. Workspace Trust covers only the workspace folders,
   * and git can run programs set in a repository (hooks, core.fsmonitor).
   */
  isTrusted(root: string): boolean {
    const id = toRepoId(root);
    return this.panelRepos.has(id) || this.trustedForSession.has(id) || isTrustedRoot(root, this.trustContext());
  }

  /** The user confirmed a repository without adding it to the list */
  trustForSession(root: string): void {
    this.trustedForSession.add(toRepoId(root));
  }

  private trustContext(): TrustContext {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    return {
      // git reports the real path: a workspace folder opened through a symbolic link must match it too
      workspaceFolders: withRealPaths(folders),
      gitRoots: withRealPaths(this.repositories.map((r) => r.root)),
      others: this.readOthers().map((o) => o.root),
    };
  }

  // ---- Other repositories ----

  private othersKey(): string {
    return othersStorageKey({ remoteName: vscode.env.remoteName, hostname: os.hostname(), wslDistro: process.env.WSL_DISTRO_NAME });
  }

  private readOthers(): OtherRepository[] {
    return sanitizeOthers(this.memento?.get(this.othersKey()));
  }

  private writeOthers(list: OtherRepository[]): void {
    void this.memento?.update(this.othersKey(), list);
  }

  /** Whether `root` is in the list of other repositories (and vscode.git does not have it) */
  isOther(root: string): boolean {
    return hasOther(this.readOthers(), root) && !this.isKnownToGit(toRepoId(root));
  }

  /** Add a repository the user confirmed to the list (its root, as git reports it) */
  addOther(root: string): void {
    this.writeOthers(addOther(this.readOthers(), root, Date.now()));
    this.changeEmitter.fire();
  }

  /** Record that a repository in the list was opened (the oldest are dropped when the list is full) */
  touchOther(root: string): void {
    const list = this.readOthers();
    if (hasOther(list, root)) this.writeOthers(addOther(list, root, Date.now()));
  }

  removeOther(root: string): void {
    this.writeOthers(removeOther(this.readOthers(), root));
    this.changeEmitter.fire();
  }

  /**
   * Whether the folder of a repository can be used: the list may hold a folder that was moved or deleted, or one on a drive
   * that is disconnected (which may not answer at all, hence the time limit)
   */
  async isAvailable(root: string, timeoutMs = 3_000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    try {
      return await Promise.race([stat(root).then((s) => s.isDirectory(), () => false), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Panels ----

  /**
   * A panel opened for the repository (RepoPanelManager tells; `release` ends it). git may run there from now on,
   * and for a repository vscode.git does not know, the list and the status bar show the state read from the panel's git status.
   */
  panelOpened(model: RepoModel): void {
    if (this.panelRepos.has(model.id)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void this.readPanelState(repo), 300);
    };
    const sub = model.onDidChange(refresh);
    const repo: PanelRepo = {
      model,
      dispose: () => {
        if (timer) clearTimeout(timer);
        sub.dispose();
      },
    };
    this.panelRepos.set(model.id, repo);
    refresh();
  }

  private async readPanelState(repo: PanelRepo): Promise<void> {
    const { model } = repo;
    // vscode.git reports the state of the repositories it knows
    if (this.panelRepos.get(model.id) !== repo || this.isKnownToGit(model.id)) return;
    try {
      // Shares the cache with the panel, which reads the status after the same change
      const s = await model.status.getParsed();
      // The panel may have been closed (and opened again) meanwhile
      if (this.panelRepos.get(model.id) !== repo) return;
      const b = s.branch;
      repo.state = {
        head: { branch: b.head ?? undefined, ahead: b.ahead, behind: b.behind, detached: !b.head && !!b.oid, commit: b.oid ?? undefined },
        status: repoStatusFromWorkingTree(model.gitDir, s),
      };
      this.changeEmitter.fire();
    } catch {
      // Keep the last state
    }
  }

  /** HEAD for the list and the status bar, without running git: the state of vscode.git, or the last one read for an open panel */
  headOf(entry: RepoEntry): HeadState {
    if (!entry.gitRepo) return this.panelRepos.get(entry.id)?.state?.head ?? NO_HEAD;
    const head = entry.gitRepo.state.HEAD;
    return {
      branch: head?.name,
      ahead: head?.ahead ?? 0,
      behind: head?.behind ?? 0,
      detached: !head?.name && !!head?.commit,
      commit: head?.commit,
    };
  }

  /**
   * What the list shows for a repository, without running git: from the state of vscode.git, or the last one read for an open panel.
   * undefined for a repository vscode.git does not know whose panel is not open (its folder is not read: it may be on a disconnected drive)
   */
  statusOf(entry: RepoEntry): RepoStatus | undefined {
    if (entry.gitRepo) return repoStatus(entry.root, entry.gitRepo.state);
    return this.panelRepos.get(entry.id)?.state?.status;
  }

  /** For a submodule vscode.git has not opened: only what the files in its git directory tell */
  statusOfFolder(root: string): RepoStatus {
    return repoStatus(root, undefined);
  }

  /** The git executable to use: twigline.gitPath (machine scope) -> the git of vscode.git -> git on PATH */
  git(): Promise<GitInfo> {
    this.gitInfo ??= loadCore().RepoModel.detectGit(gitPathSetting() ?? this.api?.git.path ?? 'git').catch((e) => {
      this.gitInfo = undefined;
      throw e;
    });
    return this.gitInfo;
  }

  resetGit(): void {
    this.gitInfo = undefined;
  }

  /** Open a RepoModel (only one per repository) */
  model(root: string): Promise<RepoModel> {
    const requested = toRepoId(root);
    const id = this.aliases.get(requested) ?? requested;
    let m = this.models.get(id);
    if (!m) {
      const opening = this.git()
        .then((git) => loadCore().RepoModel.open(root, git, this.env, this.helpers))
        .then((model) => {
          if (model.id !== id) {
            // If a subdirectory was passed, register again under the ID of the root
            this.aliases.set(id, model.id);
            this.models.delete(id);
            const existing = this.models.get(model.id);
            if (existing) {
              model.dispose();
              return existing;
            }
            this.models.set(model.id, Promise.resolve(model));
          }
          return model;
        });
      opening.catch(() => this.models.delete(id));
      this.models.set(id, opening);
      m = opening;
    }
    return m;
  }

  existingModel(id: RepoId): Promise<RepoModel> | undefined {
    return this.models.get(this.aliases.get(id) ?? id);
  }

  /** Close the RepoModel (when its panel closes) */
  release(id: RepoId): void {
    const m = this.models.get(id);
    this.models.delete(id);
    const repo = this.panelRepos.get(id);
    this.panelRepos.delete(id);
    repo?.dispose();
    void m?.then((x) => x.dispose(), () => undefined);
    // The row and the status bar showed the state read for the panel
    if (repo?.state) this.changeEmitter.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const d of this.stateSubs.values()) d.dispose();
    for (const r of this.panelRepos.values()) r.dispose();
    for (const m of this.models.values()) void m.then((x) => x.dispose(), () => undefined);
    this.models.clear();
    this.changeEmitter.dispose();
  }
}

/** The paths and, when they go through a symbolic link, their real paths */
function withRealPaths(paths: readonly string[]): string[] {
  const out = new Set(paths);
  for (const p of paths) {
    try {
      out.add(realpathSync.native(p));
    } catch {
      // A folder that is gone: the path itself is enough
    }
  }
  return [...out];
}
