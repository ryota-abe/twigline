import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoId } from '../../shared/protocol';
import type { HostEnv } from '../host/HostEnv';
import { gitPathSetting } from '../host/config';
import type { GitHelpers } from '../ipc/helpers';
import type { API, GitExtension, Repository } from '../types/git';
import { loadCore } from '../coreLoader';
import type { GitInfo, RepoModel } from './RepoModel';
import { toRepoId } from './repoId';

export interface RepoEntry {
  id: RepoId;
  root: string;
  name: string;
  /** A repository detected by vscode.git */
  gitRepo?: Repository;
  submodules: string[];
}

/** Discovers repositories through the vscode.git API and manages RepoId and RepoModel */
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

  constructor(
    private readonly env: HostEnv,
    private readonly helpers: GitHelpers,
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

  findEntry(id: RepoId): RepoEntry | undefined {
    return this.repositories.find((r) => r.id === id);
  }

  /** The repository that contains a file or folder */
  repositoryFor(uri: vscode.Uri): RepoEntry | undefined {
    const r = this.api?.getRepository(uri);
    if (r) return this.repositories.find((e) => e.id === toRepoId(r.rootUri.fsPath));
    const p = toRepoId(uri.fsPath);
    return this.repositories
      .filter((e) => p === e.id || p.startsWith(e.id + path.sep))
      .sort((a, b) => b.id.length - a.id.length)[0];
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

  /** Close the RepoModel when the panel closes */
  release(id: RepoId): void {
    const m = this.models.get(id);
    this.models.delete(id);
    void m?.then((x) => x.dispose(), () => undefined);
  }

  /** HEAD for the status bar (uses the state of vscode.git and does not call git) */
  headOf(entry: RepoEntry): { branch?: string; ahead: number; behind: number; detached: boolean; commit?: string } {
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
    for (const m of this.models.values()) void m.then((x) => x.dispose(), () => undefined);
    this.models.clear();
    this.changeEmitter.dispose();
  }
}
