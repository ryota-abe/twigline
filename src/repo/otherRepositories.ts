import * as path from 'node:path';
import type { RepoId } from '../../shared/protocol';
import { isSameOrInside, toRepoId } from './repoId';

// "Other repositories": repositories outside the workspace that the user opened in Twigline.
// The list is kept in globalState, so every window of the same machine shows it. It also records that the user confirmed
// running git there: Workspace Trust does not cover folders outside the workspace.
// (This file does not import vscode)

export interface OtherRepository {
  root: string;
  /** Date.now() of the last time it was opened. The oldest ones are dropped when the list is full */
  lastOpened: number;
}

export const MAX_OTHER_REPOSITORIES = 20;

/** Read the stored value, dropping anything that is not an entry (the value may come from another version) */
export function sanitizeOthers(value: unknown): OtherRepository[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<RepoId>();
  const out: OtherRepository[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const { root, lastOpened } = v as { root?: unknown; lastOpened?: unknown };
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    const id = toRepoId(root);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ root, lastOpened: typeof lastOpened === 'number' && Number.isFinite(lastOpened) ? lastOpened : 0 });
  }
  return out;
}

/** Add (or move up) a repository. When the list is full, the one opened longest ago is dropped */
export function addOther(list: readonly OtherRepository[], root: string, now: number, max = MAX_OTHER_REPOSITORIES): OtherRepository[] {
  const id = toRepoId(root);
  return [{ root, lastOpened: now }, ...list.filter((o) => toRepoId(o.root) !== id)].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, max);
}

export function removeOther(list: readonly OtherRepository[], root: string): OtherRepository[] {
  const id = toRepoId(root);
  return list.filter((o) => toRepoId(o.root) !== id);
}

export function hasOther(list: readonly OtherRepository[], root: string): boolean {
  const id = toRepoId(root);
  return list.some((o) => toRepoId(o.root) === id);
}

/** What decides whether git may run in a repository without asking the user (see isTrustedRoot) */
export interface TrustContext {
  /** Workspace folders (with their real paths when they go through a symbolic link): Workspace Trust covers everything inside */
  workspaceFolders: readonly string[];
  /** Roots of the repositories vscode.git has opened: it already runs git there */
  gitRoots: readonly string[];
  /** Roots of the other repositories: the user confirmed exactly these */
  others: readonly string[];
}

/**
 * Whether git may run in the repository at `root` (its top level as git reports it) without asking.
 * Inside a workspace folder: yes. Otherwise only the exact root of a repository vscode.git has opened or the user confirmed;
 * a repository inside one of those (a vendored repository, a test fixture) is a different repository with its own settings.
 */
export function isTrustedRoot(root: string, ctx: TrustContext): boolean {
  const id = toRepoId(root);
  return ctx.workspaceFolders.some((f) => isSameOrInside(root, f)) || [...ctx.gitRoots, ...ctx.others].some((r) => toRepoId(r) === id);
}

/**
 * Key of the list in globalState. globalState is kept on the local machine even for a remote window, and a path means something
 * only on its own machine, so a remote window keys the list by the machine the extension runs on (the remote host, the WSL
 * distribution or the container; a rebuilt container starts a new list).
 */
export function othersStorageKey(machine: { remoteName?: string; hostname: string; wslDistro?: string }): string {
  const base = 'twigline.otherRepositories';
  if (!machine.remoteName) return base;
  return [base, machine.remoteName, machine.hostname, machine.wslDistro].filter(Boolean).join(':');
}
