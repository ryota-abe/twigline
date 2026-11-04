import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoId } from '../../shared/protocol';
import type { HostEnv } from '../host/HostEnv';
import { gitPathSetting } from '../host/config';
import type { GitHelpers } from '../ipc/helpers';
import type { API, GitExtension, Repository } from '../types/git';
import { loadCore } from '../coreLoader';
import { addOther, hasOther, isSameOrInside, removeOther, sanitizeOthers, type OtherRepository } from './otherRepositories';
import type { GitInfo, RepoModel } from './RepoModel';
import { toRepoId } from './repoId';
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

/** Key of the list of other repositories in globalState */
const OTHERS_KEY = 'twigline.otherRepositories';

/**
 * Discovers repositories through the vscode.git API and manages RepoId and RepoModel.
 * Also keeps the list of other repositories (outside the workspace, opened by the user; see otherRepositories.ts).
 * vscode.git does not open those (its openRepository leaves repositories outside the workspace to its "parent folder" prompt),
 * so their state for the repository list comes from Twigline's own `git status` while their panel is open.
 */
export class RepositoryManager implements vscode.Disposable {
  private api?: API;
  private gitInfo?: Promise<GitInfo>;
  private readonly models = new Map<RepoId, Promise<RepoModel>>();
  /** When opened at a subdirectory etc.: the requested ID -> the ID of the root */
  private readonly aliases = new Map<RepoId, RepoId>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** The list of repositories or HEAD changed */
  readonly onDidChange = this.changeEmitter.event;
  private readonly stateSubs = new Map<RepoId, vscode.Disposable>();
  /** Other repositories with an open RepoModel: their last state, and the subscription that keeps it current */
  private readonly otherStates = new Map<RepoId, { head: HeadState; status: RepoStatus }>();
  private readonly otherSubs = new Map<RepoId, { dispose(): void }>();

  constructor(
    private readonly env: HostEnv,
    private readonly helpers: GitHelpers,
    /** globalState, which keeps the list of other repositories (none in tests that do not need it) */
    private readonly memento?: vscode.Memento,
  ) {}

  async initialize(): Promise<void> {
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

  findEntry(id: RepoId): RepoEntry | undefined {
    return this.repositories.find((r) => r.id === id) ?? this.otherRepositories.find((r) => r.id === id);
  }

  /** The repository that contains a file or folder */
  repositoryFor(uri: vscode.Uri): RepoEntry | undefined {
    const r = this.api?.getRepository(uri);
    if (r) return this.repositories.find((e) => e.id === toRepoId(r.rootUri.fsPath));
    return [...this.repositories, ...this.otherRepositories]
      .filter((e) => isSameOrInside(uri.fsPath, e.root))
      .sort((a, b) => b.id.length - a.id.length)[0];
  }

  // ---- Other repositories ----

  /**
   * The list is kept per remote (a path means something only on its own machine): by the authority of the workspace folder
   * (e.g. `ssh-remote+host`, `wsl+Ubuntu`), or by the kind of remote in a window without a folder.
   */
  private othersKey(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const scope = folder?.scheme === 'vscode-remote' ? folder.authority : vscode.env.remoteName;
    return scope ? `${OTHERS_KEY}:${scope}` : OTHERS_KEY;
  }

  private readOthers(): OtherRepository[] {
    return sanitizeOthers(this.memento?.get(this.othersKey()));
  }

  private writeOthers(list: OtherRepository[]): void {
    void this.memento?.update(this.othersKey(), list);
  }

  /** Whether `root` is in the list of other repositories (and vscode.git does not have it) */
  isOther(root: string): boolean {
    const id = toRepoId(root);
    return hasOther(this.readOthers(), root) && !this.repositories.some((r) => r.id === id);
  }

  /**
   * Whether running git in `root` needs the user's confirmation first: Workspace Trust covers only the workspace folders.
   * Not needed inside a workspace folder, a repository vscode.git has opened, or a repository already in the list.
   */
  needsTrust(root: string): boolean {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const known = [...folders, ...this.repositories.map((r) => r.root), ...this.readOthers().map((o) => o.root)];
    return !known.some((base) => isSameOrInside(root, base));
  }

  /** Add a repository the user chose (and confirmed) to the list */
  addOther(root: string): void {
    this.writeOthers(addOther(this.readOthers(), root, Date.now()));
    void this.existingModel(toRepoId(root))?.then((m) => this.trackOther(m), () => undefined);
    this.changeEmitter.fire();
  }

  /** Record that a repository in the list was opened (the oldest are dropped when the list is full) */
  touchOther(root: string): void {
    const list = this.readOthers();
    if (hasOther(list, root)) this.writeOthers(addOther(list, root, Date.now()));
  }

  removeOther(root: string): void {
    const id = toRepoId(root);
    this.writeOthers(removeOther(this.readOthers(), root));
    this.otherSubs.get(id)?.dispose();
    this.otherSubs.delete(id);
    this.otherStates.delete(id);
    this.changeEmitter.fire();
  }

  /** Whether the folder of a repository still exists (the list may hold a folder that was moved, deleted or is on a disconnected drive) */
  exists(root: string): boolean {
    return existsSync(root);
  }

  /** Keep the state of an open other repository for the repository list: read `git status` again when the model reports changes */
  private trackOther(model: RepoModel): void {
    if (this.otherSubs.has(model.id) || !this.isOther(model.root)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void this.readOtherState(model), 300);
    };
    const sub = model.onDidChange(refresh);
    this.otherSubs.set(model.id, {
      dispose: () => {
        if (timer) clearTimeout(timer);
        sub.dispose();
      },
    });
    refresh();
  }

  private async readOtherState(model: RepoModel): Promise<void> {
    try {
      // Shares the cache with the panel, which reads the status after the same change
      const s = await model.status.getParsed();
      if (!this.otherSubs.has(model.id)) return;
      const b = s.branch;
      this.otherStates.set(model.id, {
        head: { branch: b.head ?? undefined, ahead: b.ahead, behind: b.behind, detached: !b.head && !!b.oid, commit: b.oid ?? undefined },
        status: repoStatusFromWorkingTree(model.gitDir, s),
      });
      this.changeEmitter.fire();
    } catch {
      // Keep the last state
    }
  }

  /**
   * What the repository list shows for a repository, without running git: the state of vscode.git, or for an other repository
   * the last state read while its panel is open (undefined before that)
   */
  statusOf(entry: RepoEntry): RepoStatus | undefined {
    if (entry.gitRepo) return repoStatus(entry.root, entry.gitRepo.state);
    if (entry.other) return this.otherStates.get(entry.id)?.status;
    return repoStatus(entry.root, undefined);
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
          this.trackOther(model);
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

  /** Close the RepoModel when the panel closes */
  release(id: RepoId): void {
    const m = this.models.get(id);
    this.models.delete(id);
    this.otherSubs.get(id)?.dispose();
    this.otherSubs.delete(id);
    this.otherStates.delete(id);
    void m?.then((x) => x.dispose(), () => undefined);
  }

  /** HEAD for the status bar (uses the state of vscode.git, or the last state of an open other repository, and does not call git) */
  headOf(entry: RepoEntry): HeadState {
    if (!entry.gitRepo && entry.other) return this.otherStates.get(entry.id)?.head ?? { ahead: 0, behind: 0, detached: false };
    const head = entry.gitRepo?.state.HEAD;
    return {
      branch: head?.name,
      ahead: head?.ahead ?? 0,
      behind: head?.behind ?? 0,
      detached: !head?.name && !!head?.commit,
      commit: head?.commit,
    };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const d of this.stateSubs.values()) d.dispose();
    for (const d of this.otherSubs.values()) d.dispose();
    for (const m of this.models.values()) void m.then((x) => x.dispose(), () => undefined);
    this.models.clear();
    this.changeEmitter.dispose();
  }
}
