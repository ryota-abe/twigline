import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { SequenceState } from '../../shared/protocol';

// Read from the git directory without running git, so the repository list can show it for repositories without a panel

/** The operation in progress (sequence) in a git directory. Decided by the presence of specific files */
export function readSequenceIn(gitDir: string): SequenceState | null {
  const g = gitDir;
  const read = (name: string) => {
    try {
      return readFileSync(path.join(g, name), 'utf8').trim();
    } catch {
      return undefined;
    }
  };
  const shortHead = (s?: string) => (s?.startsWith('refs/heads/') ? s.slice(11) : s);

  if (existsSync(path.join(g, 'rebase-merge'))) {
    const step = Number(read('rebase-merge/msgnum'));
    const total = Number(read('rebase-merge/end'));
    return {
      kind: 'rebase',
      step: Number.isFinite(step) ? step : undefined,
      total: Number.isFinite(total) ? total : undefined,
      interactive: existsSync(path.join(g, 'rebase-merge/interactive')),
      branch: shortHead(read('rebase-merge/head-name')),
      onto: read('rebase-merge/onto'),
      incoming: read('REBASE_HEAD') ?? read('rebase-merge/stopped-sha'),
      // An amend is created only when stopped at an edit (not when stopped by a conflict)
      stoppedForEdit: existsSync(path.join(g, 'rebase-merge/amend')) || undefined,
    };
  }
  if (existsSync(path.join(g, 'rebase-apply'))) {
    const step = Number(read('rebase-apply/next'));
    const total = Number(read('rebase-apply/last'));
    return {
      kind: 'rebase',
      step: Number.isFinite(step) ? step : undefined,
      total: Number.isFinite(total) ? total : undefined,
      branch: shortHead(read('rebase-apply/head-name')),
      onto: read('rebase-apply/onto'),
      incoming: read('REBASE_HEAD'),
    };
  }
  const mergeHead = read('MERGE_HEAD');
  if (mergeHead) {
    const msg = read('MERGE_MSG') ?? '';
    const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg) ?? /^Merge (?:tag|commit) '([^']+)'/.exec(msg);
    return { kind: 'merge', incoming: mergeHead.split(/\s+/)[0], incomingName: m?.[1] };
  }
  const pick = read('CHERRY_PICK_HEAD');
  if (pick) return { kind: 'cherry-pick', incoming: pick };
  const revert = read('REVERT_HEAD');
  if (revert) return { kind: 'revert', incoming: revert };
  // A cherry-pick or revert of several commits that stopped without applying a commit (a file was in the way), or
  // whose conflicted commit was committed with git commit, has neither of those: only the sequencer is left
  const next = firstTodoLine(read('sequencer/todo') ?? '');
  if (next) {
    const [action, sha] = next.split(/\s+/);
    if (action === 'pick' || action === 'p') return { kind: 'cherry-pick', incoming: sha };
    if (action === 'revert') return { kind: 'revert', incoming: sha };
  }
  return null;
}

/** The first command of a sequencer todo (blank and comment lines skipped) */
export function firstTodoLine(todo: string): string | undefined {
  return todo
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
}

/**
 * The git directory of a working tree, found without running git: `.git` is the directory itself,
 * or (in linked worktrees and submodules) a file `gitdir: <path>` relative to the working tree
 */
export function findGitDir(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    return m ? path.resolve(root, m[1]) : undefined;
  } catch {
    return undefined;
  }
}
