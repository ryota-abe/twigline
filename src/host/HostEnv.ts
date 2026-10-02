import type { TwiglineConfig, HostEvent, PullRequestProvider, RepoId, SyntaxLanguage, SyntaxTheme, UiAction } from '../../shared/protocol';
import type { EncodingPrefs } from '../git/encoding';
import type { CommandLogEntry } from '../git/GitRunner';
import type { Disposable } from '../util/event';
import type { PullRequestCredential } from '../util/pullRequests';

/**
 * The "runtime environment" as seen from the service layer. In the VS Code extension it is implemented with the vscode API;
 * in the development server and tests it is implemented with Node only. The service layer never imports vscode.
 */
export interface HostEnv {
  /** Encoding settings for the body of a diff (files.encoding, files.autoGuessEncoding) */
  encodingFor(absPath: string): EncodingPrefs;
  /** Twigline settings */
  config(): TwiglineConfig;
  /** Move an untracked file to the OS trash */
  trash(absPaths: string[]): Promise<void>;
  /** Authentication prompt (askpass). Returning undefined cancels authentication */
  askpass(prompt: string, opts: { interactive: boolean; repo: RepoId }): Promise<string | undefined>;
  /** Log of git output (the "Twigline" OutputChannel) */
  logCommand(entry: CommandLogEntry): void;
  /** Notifications to the user */
  showMessage(kind: 'info' | 'warning' | 'error', message: string): void;
  /** Progress display (network operations, etc.). Pressing cancel aborts the signal */
  withProgress<T>(title: string, cancellable: boolean, task: (report: (message: string, percent?: number) => void, signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Actions the in-panel UI cannot express (open in the editor, clipboard, etc.) */
  uiAction(repo: RepoId, action: UiAction): Promise<void>;
  /** File watching. Notifies absolute paths for changes under dir */
  watch(dir: string, onChange: (absPath: string) => void): Disposable;
  /** Small persistent state per repository (column widths, split positions, "push right away", etc.) */
  getState(repo: RepoId): Record<string, unknown>;
  setState(repo: RepoId, patch: Record<string, unknown>): void;
  /** Send a notification to the webview (if the repository has a panel) */
  postEvent(repo: RepoId, event: HostEvent): void;
  /** Show a message editing dialog in the webview and wait for the result (squash in an interactive rebase, etc.) */
  editMessage(repo: RepoId, title: string, initial: string): Promise<string | null>;
  /**
   * Credentials for reading PRs (a token for GitHub, an email address and API token for Bitbucket Cloud).
   * If interactive, asks for sign-in / input as needed. undefined when unavailable; omitted in environments that cannot provide it
   */
  pullRequestCredential?(provider: PullRequestProvider, host: string, opts: { interactive: boolean }): Promise<PullRequestCredential | undefined>;
  /** Grammars and color theme for syntax highlighting. undefined in environments that cannot provide them */
  readonly syntax?: SyntaxProvider;
  /** Location of the files of the extension (or the development server) */
  readonly extensionPath: string;
  /** Executable that runs the askpass / editor helpers (the Electron bundled with VS Code, or node) */
  readonly helperExecPath: string;
}

export interface SyntaxProvider {
  /** Grammars for the language of a file (absolute path). Grammars are omitted for languages in loaded */
  language(absPath: string, loaded: readonly string[]): Promise<SyntaxLanguage | null>;
  /** The current color theme */
  theme(): Promise<SyntaxTheme | null>;
}
