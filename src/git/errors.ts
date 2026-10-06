import type { GitErrorCategory, RpcError } from '../../shared/protocol';

/** A git failure, or a problem detected by Twigline. Can be converted as is to the error envelope of the RPC. */
export class GitError extends Error {
  constructor(
    readonly category: GitErrorCategory,
    message: string,
    readonly details: { command?: string; stderr?: string; exitCode?: number; files?: string[]; rebaseStopped?: boolean } = {},
  ) {
    super(message);
    this.name = 'GitError';
  }

  toRpc(): RpcError {
    return {
      category: this.category,
      message: this.message,
      command: this.details.command,
      stderr: this.details.stderr,
      files: this.details.files,
      rebaseStopped: this.details.rebaseStopped,
    };
  }
}

export function toRpcError(e: unknown): RpcError {
  if (e instanceof GitError) return e.toRpc();
  if (e && typeof e === 'object' && 'name' in e && (e as Error).name === 'AbortError') {
    return { category: 'cancelled', message: 'Cancelled' };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { category: 'unknown', message };
}

interface Rule {
  category: GitErrorCategory;
  test: RegExp;
}

// Classification table, checked from the top (conflict is also decided by exit code, so it does not have to go last).
const RULES: Rule[] = [
  { category: 'locked', test: /index\.lock': File exists|Unable to create '.*\.lock'/ },
  {
    category: 'dirtyWorktree',
    test: /Your local changes to the following files would be overwritten|The following untracked working tree files would be (overwritten|removed)|Please commit your changes or stash them|cannot (rebase|pull with rebase): You have unstaged changes|Your index contains uncommitted changes/,
  },
  { category: 'conflict', test: /^CONFLICT \(|Merge conflict in|could not apply [0-9a-f]+|after resolving the conflicts|fix conflicts and then commit|needs merge|you need to resolve your current index first/m },
  { category: 'rejected', test: /! \[rejected\]|non-fast-forward|\[remote rejected\]|stale info|fetch first|Updates were rejected/ },
  { category: 'noUpstream', test: /There is no tracking information|has no upstream branch|no upstream configured/ },
  {
    category: 'auth',
    test: /Authentication failed|Permission denied \(publickey|could not read Username|could not read Password|Invalid username or password|terminal prompts disabled|HTTP Basic: Access denied|403 Forbidden|returned error: 40[13]/,
  },
  {
    category: 'network',
    test: /Could not resolve host|Connection timed out|Connection refused|Network is unreachable|unable to access '.*': Failed to connect|Operation timed out|Could not read from remote repository|early EOF|The remote end hung up unexpectedly/,
  },
];

const SEQUENCE_COMMANDS = new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'pull', 'stash']);

export function classifyGitError(stderr: string, exitCode: number, args: readonly string[]): GitErrorCategory {
  for (const rule of RULES) {
    if (rule.test.test(stderr)) {
      // "Could not read from remote repository" also appears for authentication failures, so prefer auth when there are hints of it
      if (rule.category === 'network' && RULES.find((r) => r.category === 'auth')!.test.test(stderr)) return 'auth';
      return rule.category;
    }
  }
  const sub = firstSubcommand(args);
  if (exitCode === 1 && sub && SEQUENCE_COMMANDS.has(sub) && /conflict/i.test(stderr)) return 'conflict';
  return 'unknown';
}

/** Extract the affected files from a dirtyWorktree error message (lines that start with a tab) */
export function extractOverwrittenFiles(stderr: string): string[] {
  const files: string[] = [];
  let inList = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/would be (overwritten|removed)/.test(line)) {
      inList = true;
      continue;
    }
    if (inList) {
      if (line.startsWith('\t')) files.push(line.slice(1).trim());
      else if (files.length > 0) inList = false;
    }
  }
  return files;
}

export function firstSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/** Build a summary of one to a few lines from stderr to show to the user */
export function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(hint|remote):\s*$/.test(l) && !/^(Counting|Compressing|Receiving|Resolving|Writing|Enumerating|Total|Delta)/.test(l));
  const important = lines.filter((l) => /^(error|fatal|CONFLICT|!|hint: Updates were rejected)/.test(l));
  const picked = (important.length > 0 ? important : lines).slice(0, 6);
  return picked.join('\n');
}
