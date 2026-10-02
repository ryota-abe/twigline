import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostEvent, InitData, RepoId, UiCommand, ViewKind } from '../../shared/protocol';
import { readConfig } from '../host/config';
import type { HostEnv } from '../host/HostEnv';
import type { RepoModel } from '../repo/RepoModel';
import { toRepoId } from '../repo/repoId';
import { loadCore } from '../coreLoader';
import type { RepositoryManager } from '../repo/RepositoryManager';
import { renderHtml } from './html';
import type { RpcRouter } from './RpcRouter';

export const VIEW_TYPE = 'twigline.repository';

interface PanelEntry {
  panel: vscode.WebviewPanel;
  model: RepoModel;
  router: RpcRouter;
  disposables: vscode.Disposable[];
  autoFetch?: NodeJS.Timeout;
  initialView?: ViewKind;
  initialPath?: string;
}

interface PanelState {
  root?: string;
}

/** One repository = one WebviewPanel. Opening the same repository again brings the existing tab to the front. */
export class RepoPanelManager implements vscode.Disposable {
  private readonly panels = new Map<RepoId, PanelEntry>();
  private readonly pendingEdits = new Map<string, { repo: RepoId; resolve: (v: string | null) => void }>();
  private readonly disposables: vscode.Disposable[] = [];
  private active?: RepoId;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepositoryManager,
    private readonly env: HostEnv,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state: PanelState | undefined) => {
          if (!state?.root) {
            panel.dispose();
            return;
          }
          await this.attach(panel, state.root, {});
        },
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('twigline')) return;
        const config = readConfig();
        for (const [id, entry] of this.panels) {
          this.post(id, { type: 'config/changed', config });
          this.scheduleAutoFetch(entry);
        }
      }),
    );
  }

  /** The repository of the frontmost Twigline panel */
  get activeRepo(): RepoId | undefined {
    if (this.active && this.panels.get(this.active)?.panel.active) return this.active;
    for (const [id, e] of this.panels) if (e.panel.active) return id;
    return this.active && this.panels.has(this.active) ? this.active : undefined;
  }

  has(repo: RepoId): boolean {
    return this.panels.has(repo);
  }

  async open(root: string, opts: { view?: ViewKind; path?: string } = {}): Promise<void> {
    const model = await this.repos.model(root);
    const existing = this.panels.get(model.id);
    if (existing) {
      existing.panel.reveal(undefined, false);
      if (opts.view) this.post(model.id, { type: 'ui/showView', view: opts.view, path: opts.path });
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, model.name, vscode.ViewColumn.Active, {
      enableScripts: true,
      // Do not rebuild the graph every time the user switches tabs and comes back
      retainContextWhenHidden: true,
      localResourceRoots: this.resourceRoots(),
    });
    await this.attach(panel, model.root, opts, model);
  }

  private async attach(panel: vscode.WebviewPanel, root: string, opts: { view?: ViewKind; path?: string }, known?: RepoModel): Promise<void> {
    let model: RepoModel;
    try {
      model = known ?? (await this.repos.model(root));
    } catch (e) {
      panel.webview.html = `<!DOCTYPE html><html><body><p>Twigline: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p></body></html>`;
      return;
    }
    if (this.panels.has(model.id)) {
      // If restoring produces two panels for the same repository, close the later one
      panel.dispose();
      this.panels.get(model.id)!.panel.reveal();
      return;
    }
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(),
    };
    panel.title = model.name;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'twigline-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'twigline-dark.svg'),
    };

    const entry: PanelEntry = {
      panel,
      model,
      router: undefined as unknown as RpcRouter,
      disposables: [],
      initialView: opts.view,
      initialPath: opts.path,
    };
    entry.router = new (loadCore().RpcRouter)(model, (msg) => void panel.webview.postMessage(msg), {
      init: async () => this.initData(entry),
      onEditMessageReply: (requestId, message) => {
        const p = this.pendingEdits.get(requestId);
        if (p) {
          this.pendingEdits.delete(requestId);
          p.resolve(message);
        }
      },
    });
    this.panels.set(model.id, entry);
    this.active = model.id;

    entry.disposables.push(
      panel.webview.onDidReceiveMessage((m) => entry.router.handle(m)),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.active = model.id;
      }),
      toVscodeDisposable(model.onDidChange((kinds) => this.post(model.id, { type: 'repo/changed', repo: model.id, kinds }))),
      panel.onDidDispose(() => this.onDisposed(model.id)),
    );
    model.startWatching(vscode.workspace.getConfiguration('twigline', vscode.Uri.file(model.root)).get<boolean>('autoRefresh', true));
    this.scheduleAutoFetch(entry);
    const lang = vscode.env.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    panel.webview.html = renderHtml(panel.webview, this.context.extensionUri, { repo: model.id, root: model.root, lang });
  }

  private resourceRoots(): vscode.Uri[] {
    const ext = this.context.extensionUri;
    return [vscode.Uri.joinPath(ext, 'dist', 'webview'), vscode.Uri.joinPath(ext, 'dist', 'syntax'), vscode.Uri.joinPath(ext, 'media')];
  }

  private async initData(entry: PanelEntry): Promise<InitData & { uiState: Record<string, unknown> }> {
    const lang = vscode.env.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
    const view = entry.initialView;
    const initialPath = entry.initialPath;
    entry.initialView = undefined;
    entry.initialPath = undefined;
    return {
      repo: entry.model.id,
      root: entry.model.root,
      name: entry.model.name,
      language: lang,
      platform: process.platform,
      config: readConfig(),
      initialView: view,
      initialPath,
      uiState: this.env.getState(entry.model.id),
    };
  }

  /** twigline.autoFetch.intervalMinutes. Runs only while the window has focus */
  private scheduleAutoFetch(entry: PanelEntry): void {
    if (entry.autoFetch) clearInterval(entry.autoFetch);
    entry.autoFetch = undefined;
    const minutes = vscode.workspace.getConfiguration('twigline', vscode.Uri.file(entry.model.root)).get<number>('autoFetch.intervalMinutes', 10);
    if (!minutes || minutes <= 0) return;
    entry.autoFetch = setInterval(() => void this.autoFetch(entry), Math.max(1, minutes) * 60_000);
  }

  private async autoFetch(entry: PanelEntry): Promise<void> {
    if (!vscode.window.state.focused) return;
    const snap = await entry.model.snapshot.get().catch(() => undefined);
    if (!snap) return;
    for (const r of snap.remotes) {
      if (entry.model.snapshot.authRequired.has(r.name)) continue;
      try {
        await entry.model.ops.run({ kind: 'fetch', remote: r.name, prune: false, tags: false }, { interactive: false });
      } catch {
        // Mark remotes that need authentication and skip them in later periodic fetches
        if (entry.model.snapshot.authRequired.has(r.name)) entry.model.notifyChanged(['refs']);
      }
    }
  }

  /** Notify every open panel */
  broadcast(event: HostEvent): void {
    for (const id of this.panels.keys()) this.post(id, event);
  }

  post(repo: RepoId, event: HostEvent): void {
    const entry = this.panels.get(repo);
    if (entry) void entry.panel.webview.postMessage({ t: 'evt', event });
  }

  /** Pass an action from a context menu or the Command Palette to the webview */
  forward(repo: RepoId, command: UiCommand): boolean {
    const entry = this.panels.get(repo);
    if (!entry) return false;
    this.post(repo, { type: 'ui/command', command });
    return true;
  }

  editMessage(repo: RepoId, title: string, initial: string): Promise<string | null> {
    if (!this.panels.has(repo)) return Promise.resolve(null);
    const requestId = randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      this.pendingEdits.set(requestId, { repo, resolve });
      this.panels.get(repo)!.panel.reveal(undefined, false);
      this.post(repo, { type: 'ui/editMessage', requestId, title, initial });
    });
  }

  repoForRoot(root: string): RepoId {
    return toRepoId(root);
  }

  modelOf(repo: RepoId): RepoModel | undefined {
    return this.panels.get(repo)?.model;
  }

  /** Number of requests from the webview handled (integration tests use it to check that the webview loaded and RPC works) */
  rpcStats(repo: RepoId): Record<string, { ok: number; failed: number }> {
    return Object.fromEntries(this.panels.get(repo)?.router.stats ?? []);
  }

  private onDisposed(id: RepoId): void {
    const entry = this.panels.get(id);
    if (!entry) return;
    this.panels.delete(id);
    if (entry.autoFetch) clearInterval(entry.autoFetch);
    entry.router.dispose();
    for (const d of entry.disposables) d.dispose();
    for (const [key, p] of this.pendingEdits) {
      if (p.repo === id) {
        this.pendingEdits.delete(key);
        p.resolve(null);
      }
    }
    this.repos.release(id);
    if (this.active === id) this.active = undefined;
  }

  dispose(): void {
    for (const e of [...this.panels.values()]) e.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function toVscodeDisposable(d: { dispose(): void }): vscode.Disposable {
  return new vscode.Disposable(() => d.dispose());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
