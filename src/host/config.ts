import * as vscode from 'vscode';
import type { IssueLinkSettings, IssueLinksState, SettingsTarget, TwiglineConfig } from '../../shared/protocol';
import { issueTrackerSettings } from '../util/messageLinks';
import type { TerminalProfile } from '../util/terminalProfile';

export const DEFAULT_GRAPH_COLORS = ['#2f6bd8', '#c0397f', '#c98410', '#2c9a58', '#7a4fd0', '#d0503a', '#1a93a8', '#8a8f1f'];

export interface CustomAction {
  name: string;
  command: string;
  args?: string[];
  /** Run in the terminal (by default, recorded in the Twigline output) */
  terminal?: boolean;
}

/** Read the settings */
export function readConfig(): TwiglineConfig {
  // Some settings have resource scope, but the caller has no repository context, so pass null (no resource)
  // (if omitted, VS Code logs a warning on every access)
  const c = vscode.workspace.getConfiguration('twigline', null);
  const num = (key: string, def: number, min: number, max: number) => {
    const v = c.get<number>(key, def);
    return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : def;
  };
  const colors = c.get<string[]>('graph.colors', DEFAULT_GRAPH_COLORS);
  return {
    historyOrder: c.get<'date' | 'topo'>('history.order', 'date') === 'topo' ? 'topo' : 'date',
    historyBranches: c.get<'all' | 'current'>('history.branches', 'all') === 'current' ? 'current' : 'all',
    showRemoteBranches: c.get<boolean>('history.showRemoteBranches', true),
    showStashes: c.get<boolean>('history.showStashes', false),
    pageSize: num('history.pageSize', 500, 50, 10_000),
    dateFormat: c.get<string>('history.dateFormat', 'absolute'),
    graphColors: Array.isArray(colors) && colors.length > 0 ? colors.map(String) : DEFAULT_GRAPH_COLORS,
    fileStatusLayout: c.get<'split' | 'single'>('fileStatus.layout', 'split') === 'single' ? 'single' : 'split',
    fileStatusView: c.get<'list' | 'tree'>('fileStatus.view', 'list') === 'tree' ? 'tree' : 'list',
    contextLines: num('diff.contextLines', 3, 0, 25),
    ignoreWhitespace: c.get<boolean>('diff.ignoreWhitespace', false),
    maxDiffLines: num('diff.maxLines', 5000, 100, 1_000_000),
    syntaxHighlight: c.get<boolean>('diff.syntaxHighlight', true),
    forcePushMode: c.get<'withLease' | 'force'>('push.forceMode', 'withLease') === 'force' ? 'force' : 'withLease',
    rememberPushAfter: c.get<boolean>('commit.rememberPushAfter', true),
    pullRequests: c.get<boolean>('pullRequests.enabled', true),
    customActions: readCustomActions().map((a) => ({ name: a.name })),
  };
}

/**
 * twigline.issueLinks.* of a repository. Read with the repository as the resource, so each folder of a multi-root workspace can have its own;
 * also where they are set and where they can be saved (the workspace folder holding the repository, or the user settings)
 */
export function readIssueLinks(root: string): Pick<IssueLinksState, 'settings' | 'source' | 'targets'> {
  const uri = vscode.Uri.file(root);
  const c = vscode.workspace.getConfiguration('twigline', uri);
  const inspected = [c.inspect('issueLinks.builtIn'), c.inspect('issueLinks.trackers')];
  const inWorkspace = inspected.some((i) => i?.workspaceFolderValue !== undefined || i?.workspaceValue !== undefined);
  const inUser = inspected.some((i) => i?.globalValue !== undefined);
  return {
    settings: { builtIn: c.get<boolean>('issueLinks.builtIn', false) === true, trackers: issueTrackerSettings(c.get<unknown>('issueLinks.trackers', [])) },
    source: inWorkspace ? 'workspace' : inUser ? 'user' : 'default',
    targets: vscode.workspace.getWorkspaceFolder(uri) ? ['workspace', 'user'] : ['user'],
  };
}

export async function saveIssueLinks(root: string, settings: IssueLinkSettings, target: SettingsTarget): Promise<void> {
  const uri = vscode.Uri.file(root);
  if (target === 'workspace' && !vscode.workspace.getWorkspaceFolder(uri)) throw new Error('The repository is not in a workspace folder.');
  const c = vscode.workspace.getConfiguration('twigline', uri);
  const t = target === 'workspace' ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
  await c.update('issueLinks.builtIn', settings.builtIn, t);
  await c.update('issueLinks.trackers', settings.trackers, t);
}

export function readCustomActions(): CustomAction[] {
  // application scope, so it cannot be injected from workspace settings
  const inspected = vscode.workspace.getConfiguration('twigline').inspect<CustomAction[]>('customActions');
  const list = inspected?.globalValue ?? inspected?.defaultValue ?? [];
  return Array.isArray(list) ? list.filter((a) => a && typeof a.name === 'string' && typeof a.command === 'string') : [];
}

export function gitPathSetting(): string | undefined {
  // machine scope. Values from workspace settings are not used
  const inspected = vscode.workspace.getConfiguration('twigline').inspect<string>('gitPath');
  const v = inspected?.globalValue;
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * The terminal profile to open (twigline.terminal.profile), or undefined for VS Code's default profile (`default`).
 * When empty on Windows, Git Bash, unless a default profile is chosen in VS Code (terminal.integrated.defaultProfile.windows).
 * explicit: named in the setting (a profile that is not found is reported)
 */
export function terminalProfileSetting(): { name: string; explicit: boolean } | undefined {
  const v = vscode.workspace.getConfiguration('twigline', null).get<string>('terminal.profile', '').trim();
  if (v === 'default') return undefined;
  if (v) return { name: v, explicit: true };
  if (process.platform !== 'win32' || vscode.workspace.getConfiguration('terminal.integrated', null).get<string | null>('defaultProfile.windows')) return undefined;
  return { name: 'Git Bash', explicit: false };
}

/** terminal.integrated.profiles.<os>. Only user settings, like twigline.gitPath: the shell to run is not taken from workspace settings */
export function terminalProfiles(): Record<string, TerminalProfile | null> {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const inspected = vscode.workspace.getConfiguration('terminal.integrated', null).inspect<Record<string, TerminalProfile | null>>(`profiles.${os}`);
  return { ...inspected?.defaultValue, ...inspected?.globalValue };
}
