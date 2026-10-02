import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffTarget, TwiglineConfig, HostEvent, PullRequestProvider, RepoId, SyntaxLanguage, SyntaxTheme, UiAction } from '../../shared/protocol';
import { loadCore } from '../coreLoader';
import type { EncodingPrefs } from '../git/encoding';
import type { CommandLogEntry } from '../git/GitRunner';
import type { RepoPanelManager } from '../panel/RepoPanelManager';
import type { RepoModel } from '../repo/RepoModel';
import type { RepositoryManager } from '../repo/RepositoryManager';
import type { Disposable } from '../util/event';
import { hostedRemotes, pullRequestUrl } from '../util/hosting';
import type { PullRequestCredential } from '../util/pullRequests';
import { readConfig, readCustomActions } from './config';
import type { SyntaxRegistry, ThemeKind } from '../syntax/SyntaxRegistry';
import type { HostEnv, SyntaxProvider } from './HostEnv';
import { revUri } from './RevisionContentProvider';

const t = vscode.l10n.t;

/** VS Code implementation of HostEnv */
export class VscodeEnv implements HostEnv {
  readonly output = vscode.window.createOutputChannel('Twigline');
  repos!: RepositoryManager;
  panels!: RepoPanelManager;

  private registry?: SyntaxRegistry;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    // Syntax highlighting: when the theme, color settings or extensions change, have the webview re-read them
    const changed = () => this.panels?.broadcast({ type: 'syntax/changed' });
    this.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(changed),
      vscode.extensions.onDidChange(() => {
        this.registry = undefined;
        changed();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (SYNTAX_KEYS.some((k) => e.affectsConfiguration(k))) changed();
      }),
      // Signing in to or out of GitHub changes how PRs appear
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === 'github' || e.provider.id === 'github-enterprise') this.panels?.broadcast({ type: 'pr/changed' });
      }),
      context.secrets.onDidChange((e) => {
        if (e.key === BITBUCKET_SECRET) this.panels?.broadcast({ type: 'pr/changed' });
      }),
    );
  }

  get extensionPath(): string {
    return this.context.extensionPath;
  }

  get helperExecPath(): string {
    return process.execPath;
  }

  encodingFor(absPath: string): EncodingPrefs {
    const c = vscode.workspace.getConfiguration('files', vscode.Uri.file(absPath));
    return { encoding: c.get<string>('encoding', 'utf8'), autoGuess: c.get<boolean>('autoGuessEncoding', false), language: vscode.env.language };
  }

  config(): TwiglineConfig {
    return readConfig();
  }

  async trash(absPaths: string[]): Promise<void> {
    for (const p of absPaths) {
      await vscode.workspace.fs.delete(vscode.Uri.file(p), { useTrash: true, recursive: true });
    }
  }

  async askpass(prompt: string, opts: { interactive: boolean; repo: RepoId }): Promise<string | undefined> {
    // Do not show an input box for actions the user did not start (periodic fetch)
    if (!opts.interactive) return undefined;
    if (/\(yes\/no(\/\[fingerprint\])?\)\?/i.test(prompt)) {
      const yes = t('Yes');
      const choice = await vscode.window.showWarningMessage(prompt, { modal: true }, yes, t('No'));
      return choice === yes ? 'yes' : 'no';
    }
    const secret = /password|passphrase|token|pin/i.test(prompt);
    return vscode.window.showInputBox({
      title: t('Twigline: Git authentication'),
      prompt: prompt.trim(),
      password: secret,
      ignoreFocusOut: true,
    });
  }

  async pullRequestCredential(provider: PullRequestProvider, host: string, opts: { interactive: boolean }): Promise<PullRequestCredential | undefined> {
    if (provider === 'github') {
      const token = await this.githubToken(host, opts);
      return token ? { token } : undefined;
    }
    if (host !== 'bitbucket.org') return undefined;
    return opts.interactive ? this.askBitbucketCredential() : this.readBitbucketCredential();
  }

  private async githubToken(host: string, opts: { interactive: boolean }): Promise<string | undefined> {
    // github.com uses the built-in GitHub authentication; GitHub Enterprise Server only the host set in github-enterprise.uri
    let provider = 'github';
    if (host !== 'github.com') {
      const uri = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
      let configured: string | undefined;
      try {
        configured = uri ? new URL(uri).hostname.toLowerCase() : undefined;
      } catch {
        configured = undefined;
      }
      if (configured !== host) return undefined;
      provider = 'github-enterprise';
    }
    try {
      // When not interactive, if the user has not granted permission yet, show nothing and return undefined (no mark in the Accounts menu either)
      const session = await vscode.authentication.getSession(provider, GITHUB_SCOPES, opts.interactive ? { createIfNone: true } : { silent: true });
      return session?.accessToken;
    } catch {
      return undefined;
    }
  }

  /** Saved Bitbucket Cloud credentials (SecretStorage) */
  private async readBitbucketCredential(): Promise<{ username: string; password: string } | undefined> {
    try {
      const v = JSON.parse((await this.context.secrets.get(BITBUCKET_SECRET)) ?? 'null') as unknown;
      const c = v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
      return typeof c?.username === 'string' && typeof c.password === 'string' ? { username: c.username, password: c.password } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Ask for an Atlassian email address and API token and save them in SecretStorage */
  private async askBitbucketCredential(): Promise<{ username: string; password: string } | undefined> {
    const enter = t('Enter API Token');
    const create = t('Create API Token');
    const choice = await vscode.window.showInformationMessage(
      t('Reading pull requests of a private Bitbucket repository needs an Atlassian API token.'),
      { modal: true, detail: t('Create an API token with the read:pullrequest:bitbucket scope, then enter it with the email address of your Atlassian account. It is kept in the VS Code secret storage.') },
      enter,
      create,
    );
    if (!choice) return undefined;
    if (choice === create) await vscode.env.openExternal(vscode.Uri.parse(ATLASSIAN_API_TOKENS));
    const saved = await this.readBitbucketCredential();
    const title = t('Twigline: Connect to Bitbucket');
    const required = (v: string) => (v.trim() ? undefined : t('Enter a value.'));
    const username = await vscode.window.showInputBox({ title, prompt: t('Email address of your Atlassian account'), value: saved?.username, ignoreFocusOut: true, validateInput: required });
    if (!username) return undefined;
    const password = await vscode.window.showInputBox({ title, prompt: t('Atlassian API token (read:pullrequest:bitbucket)'), password: true, ignoreFocusOut: true, validateInput: required });
    if (!password) return undefined;
    const credential = { username: username.trim(), password: password.trim() };
    await this.context.secrets.store(BITBUCKET_SECRET, JSON.stringify(credential));
    return credential;
  }

  /** Remove the saved Bitbucket credentials (command twigline.bitbucket.signOut) */
  async signOutBitbucket(): Promise<void> {
    await this.context.secrets.delete(BITBUCKET_SECRET);
    void vscode.window.showInformationMessage(t('Removed the saved Bitbucket API token.'));
  }

  logCommand(e: CommandLogEntry): void {
    const time = new Date().toLocaleTimeString();
    this.output.appendLine(`[${time}] ${e.command}  (${e.durationMs} ms, exit ${e.exitCode ?? 'killed'})`);
    if (e.stderr) {
      for (const line of e.stderr.trimEnd().split(/\r?\n/).slice(0, 40)) this.output.appendLine(`    ${line}`);
    }
  }

  showMessage(kind: 'info' | 'warning' | 'error', message: string): void {
    if (kind === 'error') void vscode.window.showErrorMessage(message);
    else if (kind === 'warning') void vscode.window.showWarningMessage(message);
    else void vscode.window.showInformationMessage(message);
  }

  withProgress<T>(
    title: string,
    cancellable: boolean,
    task: (report: (message: string, percent?: number) => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Twigline: ${title}`, cancellable }, async (progress, token) => {
        const ctrl = new AbortController();
        token.onCancellationRequested(() => ctrl.abort());
        let last = 0;
        let lastPhase = '';
        return task((message, percent) => {
          const phase = message.split(':')[0];
          if (phase !== lastPhase) {
            lastPhase = phase;
            last = 0;
          }
          const increment = percent !== undefined && percent > last ? percent - last : undefined;
          if (percent !== undefined) last = Math.max(last, percent);
          progress.report({ message, increment: increment !== undefined ? increment / 4 : undefined });
        }, ctrl.signal);
      }),
    );
  }

  watch(dir: string, onChange: (absPath: string) => void): Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '**'));
    const fire = (u: vscode.Uri) => onChange(u.fsPath);
    const subs = [watcher.onDidChange(fire), watcher.onDidCreate(fire), watcher.onDidDelete(fire)];
    return {
      dispose: () => {
        for (const s of subs) s.dispose();
        watcher.dispose();
      },
    };
  }

  readonly syntax: SyntaxProvider = {
    language: async (absPath: string, loaded: readonly string[]): Promise<SyntaxLanguage | null> => {
      const assoc = vscode.workspace.getConfiguration('files', vscode.Uri.file(absPath)).get<Record<string, string>>('associations', {});
      return this.syntaxRegistry().resolve(absPath, loaded, assoc ?? {});
    },
    theme: async (): Promise<SyntaxTheme | null> => {
      const kind = activeThemeKind();
      const custom = vscode.workspace.getConfiguration('editor').get<Record<string, unknown>>('tokenColorCustomizations');
      return this.syntaxRegistry().theme(themeCandidates(kind), kind, custom);
    },
  };

  private syntaxRegistry(): SyntaxRegistry {
    // Extensions installed by the user come after vscode.extensions.all, so the later one wins at equal strength
    this.registry ??= new (loadCore().SyntaxRegistry)(vscode.extensions.all);
    return this.registry;
  }

  getState(repo: RepoId): Record<string, unknown> {
    return this.context.globalState.get<Record<string, unknown>>(`twigline.ui:${repo}`, {});
  }

  setState(repo: RepoId, patch: Record<string, unknown>): void {
    const next = { ...this.getState(repo), ...patch };
    void this.context.globalState.update(`twigline.ui:${repo}`, next);
  }

  postEvent(repo: RepoId, event: HostEvent): void {
    this.panels?.post(repo, event);
  }

  editMessage(repo: RepoId, title: string, initial: string): Promise<string | null> {
    return this.panels ? this.panels.editMessage(repo, title, initial) : Promise.resolve(null);
  }

  // -------------------------------------------------------------------------
  // Actions the in-panel UI cannot express
  // -------------------------------------------------------------------------

  async uiAction(repo: RepoId, action: UiAction): Promise<void> {
    const model = this.panels.modelOf(repo) ?? (await this.repos.existingModel(repo));
    if (!model) throw new Error('Repository is not open');
    const abs = (p: string) => vscode.Uri.file(model.resolvePath(p));
    switch (action.kind) {
      case 'openDiff':
        return this.openDiff(model, action.target, action.path, action.oldPath);
      case 'openFile':
        if (action.sha) {
          await vscode.commands.executeCommand('vscode.open', revUri(model.root, action.sha, model.relPath(action.path)));
        } else {
          await vscode.commands.executeCommand('vscode.open', abs(action.path));
        }
        return;
      case 'compareWithWorktree': {
        const rel = model.relPath(action.path);
        await vscode.commands.executeCommand(
          'vscode.diff',
          revUri(model.root, action.sha, rel),
          abs(action.path),
          `${path.basename(rel)} (${action.sha.slice(0, 7)} ↔ ${t('Working Tree')})`,
        );
        return;
      }
      case 'revealInOS':
        await vscode.commands.executeCommand('revealFileInOS', abs(action.path));
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(action.text);
        return;
      case 'showOutput':
        this.output.show(true);
        return;
      case 'openMergeEditor':
        try {
          await vscode.commands.executeCommand('git.openMergeEditor', abs(action.path));
        } catch {
          await vscode.commands.executeCommand('vscode.open', abs(action.path));
        }
        return;
      case 'openGitignore': {
        const file = path.join(model.root, '.gitignore');
        if (!existsSync(file)) await writeFile(file, '', 'utf8');
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
        return;
      }
      case 'createPatch':
        return this.createPatch(model, action.shas);
      case 'createPullRequest':
        return this.createPullRequest(model, action.branch);
      case 'openPullRequest': {
        // The URL is not taken from the webview; the host looks it up from the result it read
        const pr = model.pullRequests.last?.byRef[action.ref];
        if (!pr) {
          void vscode.window.showWarningMessage(t('No pull request was found for this branch.'));
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(pr.url));
        return;
      }
      case 'pullRequestSignIn':
        return this.pullRequestSignIn(model, action.provider);
      case 'customAction':
        return this.runCustomAction(model, action);
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ryota-abe.twigline');
        return;
      case 'openRepo':
        await this.panels.open(model.resolvePath(action.path));
        return;
      case 'removeLock':
        return this.removeLock(model);
      case 'optimize':
        return this.optimize(model);
      case 'saveUiState':
        this.setState(repo, action.state);
        return;
    }
  }

  private async openDiff(model: RepoModel, target: DiffTarget, p: string, oldPath?: string): Promise<void> {
    const rel = model.relPath(p);
    const oldRel = oldPath ? model.relPath(oldPath) : rel;
    const name = path.basename(rel);
    let left: vscode.Uri;
    let right: vscode.Uri;
    let title: string;
    switch (target.kind) {
      case 'worktree':
        left = revUri(model.root, ':', rel);
        right = vscode.Uri.file(model.resolvePath(rel));
        title = `${name} (${t('Working Tree')})`;
        break;
      case 'index':
        left = revUri(model.root, 'HEAD', rel);
        right = revUri(model.root, ':', rel);
        title = `${name} (${t('Index')})`;
        break;
      case 'commit': {
        const parents = await model.diff.parentsOf(target.sha);
        const parent = parents[Math.min(target.parent ?? 0, Math.max(parents.length - 1, 0))];
        left = parent ? revUri(model.root, parent, oldRel) : revUri(model.root, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', oldRel);
        right = revUri(model.root, target.sha, rel);
        title = `${name} (${parent ? parent.slice(0, 7) : '∅'} ↔ ${target.sha.slice(0, 7)})`;
        break;
      }
      case 'range':
        left = revUri(model.root, target.from, oldRel);
        right = revUri(model.root, target.to, rel);
        title = `${name} (${target.from.slice(0, 7)} ↔ ${target.to.slice(0, 7)})`;
        break;
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  }

  private async createPatch(model: RepoModel, shas: string[]): Promise<void> {
    const parts: Buffer[] = [];
    for (const sha of shas) {
      const res = await model.runner.run(['format-patch', '-1', '--stdout', '--end-of-options', sha]);
      parts.push(res.stdout);
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(model.root, `${shas[0].slice(0, 7)}.patch`)),
      filters: { Patch: ['patch', 'diff'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.concat(parts));
  }

  private async createPullRequest(model: RepoModel, branch: string): Promise<void> {
    const snap = await model.snapshot.get();
    const ref = snap.refs.find((r) => r.kind === 'head' && r.name === branch);
    const remoteName = ref?.upstream?.split('/')[0] ?? 'origin';
    const remote = snap.remotes.find((r) => r.name === remoteName) ?? snap.remotes[0];
    const upstreamBranch = ref?.upstream && remote ? ref.upstream.slice(remote.name.length + 1) : branch;
    const url = remote?.fetchUrl ? pullRequestUrl(remote.fetchUrl, upstreamBranch) : undefined;
    if (!url) {
      void vscode.window.showWarningMessage(t('Could not determine the pull request URL for this remote.'));
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async pullRequestSignIn(model: RepoModel, provider: PullRequestProvider): Promise<void> {
    const snap = await model.snapshot.get();
    const hosts = new Set([...hostedRemotes(snap.remotes).values()].filter((r) => r.provider === provider).map((r) => r.host));
    let signedIn = false;
    for (const host of hosts) if (await this.pullRequestCredential(provider, host, { interactive: true })) signedIn = true;
    if (!signedIn && provider === 'github' && [...hosts].some((h) => h !== 'github.com')) {
      void vscode.window.showWarningMessage(t('To show pull requests from GitHub Enterprise Server, set github-enterprise.uri to the server URL.'));
    }
    // Allowing use of an existing session does not send a session change notification, so have the webview re-fetch here
    model.pullRequests.invalidate();
    this.panels.post(model.id, { type: 'pr/changed' });
  }

  private async runCustomAction(model: RepoModel, ctx: { sha?: string; path?: string; ref?: string }): Promise<void> {
    const actions = readCustomActions();
    if (actions.length === 0) {
      const open = t('Open Settings');
      const choice = await vscode.window.showInformationMessage(t('No custom actions are configured (twigline.customActions).'), open);
      if (choice === open) await vscode.commands.executeCommand('workbench.action.openSettings', 'twigline.customActions');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      actions.map((a) => ({ label: a.name, description: [a.command, ...(a.args ?? [])].join(' '), action: a })),
      { title: t('Custom Actions') },
    );
    if (!picked) return;
    // Variables are expanded as elements of the argument array, never by string concatenation
    const vars: Record<string, string> = {
      repo: model.root,
      sha: ctx.sha ?? '',
      shortSha: ctx.sha?.slice(0, 7) ?? '',
      file: ctx.path ? model.resolvePath(ctx.path) : '',
      relFile: ctx.path ? model.relPath(ctx.path) : '',
      ref: ctx.ref ?? '',
    };
    const args = (picked.action.args ?? []).map((a) => a.replace(/\$\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m)));
    if (picked.action.terminal) {
      vscode.window.createTerminal({ name: picked.action.name, shellPath: picked.action.command, shellArgs: args, cwd: model.root }).show();
      return;
    }
    this.output.appendLine(`> ${picked.action.command} ${args.join(' ')}`);
    const child = spawn(picked.action.command, args, { cwd: model.root, shell: false, windowsHide: true });
    child.stdout.on('data', (d: Buffer) => this.output.append(d.toString()));
    child.stderr.on('data', (d: Buffer) => this.output.append(d.toString()));
    child.on('error', (e) => void vscode.window.showErrorMessage(`${picked.action.name}: ${e.message}`));
    child.on('close', (code) => {
      if (code === 0) void vscode.window.showInformationMessage(t('{0} finished.', picked.action.name));
      else {
        const show = t('Show Output');
        void vscode.window.showErrorMessage(t('{0} failed (exit code {1}).', picked.action.name, String(code)), show).then((c) => c === show && this.output.show());
      }
      model.notifyChanged(['status', 'refs', 'head']);
    });
  }

  private async removeLock(model: RepoModel): Promise<void> {
    if (model.runner.isBusy) {
      void vscode.window.showWarningMessage(t('A git command started by Twigline is still running. Try again after it finishes.'));
      return;
    }
    const lock = path.join(model.gitDir, 'index.lock');
    const remove = t('Delete Lock File');
    const choice = await vscode.window.showWarningMessage(
      t('Delete {0}? Make sure no other git process (terminal, other tools) is running in this repository.', lock),
      { modal: true },
      remove,
    );
    if (choice !== remove) return;
    await unlink(lock).catch(() => undefined);
    model.notifyChanged(['status']);
  }

  private async optimize(model: RepoModel): Promise<void> {
    // Never run automatically. Suggest, and run only what is chosen
    const items = [
      { label: 'git commit-graph write --reachable', description: t('Faster history for large repositories'), args: ['commit-graph', 'write', '--reachable'], picked: true },
      { label: 'git config core.untrackedCache true', description: t('Faster status'), args: ['config', 'core.untrackedCache', 'true'], picked: false },
      { label: 'git config core.fsmonitor true', description: t('Faster status using the file system monitor (Windows / macOS)'), args: ['config', 'core.fsmonitor', 'true'], picked: false },
    ];
    const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: t('Optimize Repository') });
    if (!picked || picked.length === 0) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Optimizing repository…') }, async () => {
      for (const p of picked) await model.runner.run(p.args, { queue: 'write' });
    });
    void vscode.window.showInformationMessage(t('Repository optimized.'));
  }

  dispose(): void {
    this.output.dispose();
    for (const d of this.subscriptions) d.dispose();
  }
}

/** Scope needed to read PRs of private repositories */
const GITHUB_SCOPES = ['repo'];
/** SecretStorage key for saving the Bitbucket Cloud email address and API token */
const BITBUCKET_SECRET = 'twigline.bitbucket.credential';
/** Management page for Atlassian account API tokens */
const ATLASSIAN_API_TOKENS = 'https://id.atlassian.com/manage-profile/security/api-tokens';

const SYNTAX_KEYS = [
  'workbench.colorTheme',
  'workbench.preferredDarkColorTheme',
  'workbench.preferredLightColorTheme',
  'workbench.preferredHighContrastColorTheme',
  'workbench.preferredHighContrastLightColorTheme',
  'window.autoDetectColorScheme',
  'window.autoDetectHighContrast',
  'editor.tokenColorCustomizations',
  'files.associations',
];

function activeThemeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'hcDark';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'hcLight';
    default:
      return 'dark';
  }
}

/**
 * Candidate setting names for the current theme. The VS Code API does not return the theme ID, so infer it from the settings.
 * When the setting follows the OS color scheme (window.autoDetectColorScheme, autoDetectHighContrast), preferred* is used.
 */
function themeCandidates(kind: ThemeKind): (string | undefined)[] {
  const w = vscode.workspace.getConfiguration('workbench');
  const preferred: Record<ThemeKind, string> = {
    dark: 'preferredDarkColorTheme',
    light: 'preferredLightColorTheme',
    hcDark: 'preferredHighContrastColorTheme',
    hcLight: 'preferredHighContrastLightColorTheme',
  };
  const auto = vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme', false);
  const pref = w.get<string>(preferred[kind]);
  const current = w.get<string>('colorTheme');
  return auto ? [pref, current] : [current, pref];
}
