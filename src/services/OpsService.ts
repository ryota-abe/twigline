import { appendFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ChangeKind, OpResult, Operation } from '../../shared/protocol';
import { GitError } from '../git/errors';
import { formatCommand, type QueueKind } from '../git/GitRunner';
import { ALL_KINDS, type RepoModel } from '../repo/RepoModel';

// op/run. Breaks an operation into steps (git commands or host-side work) and runs them in order.
// With dryRun nothing is run; only the list of commands shown at the bottom of the dialog is returned.

export type Step =
  | {
      type: 'git';
      args: string[];
      queue: QueueKind;
      /** Needs authentication (attach askpass) */
      auth?: boolean;
      alsoWrite?: boolean;
      stdin?: string | Buffer;
      okExitCodes?: number[];
      /** Progress title (network operations) */
      progress?: string;
      /** Attach the editor environment for interactive rebase */
      rebaseEditor?: boolean;
    }
  | { type: 'fn'; describe: string; run: () => Promise<void> };

export interface RunOpOptions {
  dryRun?: boolean;
  /** Whether the user started the operation (periodic fetch does not ask for credentials) */
  interactive?: boolean;
  signal?: AbortSignal;
  opId?: string;
}

const SHA_RE = /^[0-9a-f]{4,64}$/i;

export function assertRef(name: string, what = 'ref'): string {
  if (typeof name !== 'string' || !name || name.startsWith('-') || /[\s\0~^:?*[\\]|\.\.|@\{/.test(name)) {
    throw new GitError('invalid', `Invalid ${what}: ${name}`);
  }
  return name;
}

/** A ref or revision (stash@{n} and HEAD~1 are not accepted; only SHAs, branch names and tag names) */
export function assertRev(rev: string): string {
  if (SHA_RE.test(rev)) return rev;
  return assertRef(rev, 'revision');
}

function assertSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new GitError('invalid', `Invalid commit: ${sha}`);
  return sha;
}

function assertRemote(name: string): string {
  if (!name || name.startsWith('-') || /[\s\0]/.test(name)) throw new GitError('invalid', `Invalid remote: ${name}`);
  return name;
}

function kindsFor(op: Operation): ChangeKind[] {
  switch (op.kind) {
    case 'fetch':
      return ['refs'];
    case 'remote/add':
    case 'remote/edit':
    case 'remote/remove':
    case 'config/user':
      return ['config', 'refs'];
    case 'gitignore/add':
    case 'discard':
    case 'conflict/resolve':
    case 'conflict/mark':
      return ['status', 'sequence'];
    case 'stash/push':
    case 'stash/apply':
    case 'stash/drop':
      return ['stash', 'status', 'sequence'];
    default:
      return ALL_KINDS;
  }
}

export class OpsService {
  constructor(private readonly repo: RepoModel) {}

  async run(op: Operation, opts: RunOpOptions = {}): Promise<OpResult> {
    if (op.kind === 'rebase/interactive' && !opts.dryRun) {
      return this.repo.rebase.run(op.base, op.todo, opts);
    }
    const steps = await this.plan(op);
    const commands = steps.map((s) => (s.type === 'git' ? formatCommand(s.args) : s.describe));
    if (opts.dryRun) return { commands };
    return this.repo.runOp(kindsFor(op), async () => {
      await this.execute(steps, opts, op);
      return { commands, message: undefined, stopped: this.repo.snapshot.readSequence() !== null && isSequenceOp(op) ? true : undefined };
    });
  }

  /** Run the steps in order. Stop at the first failure. */
  async execute(steps: Step[], opts: RunOpOptions, op?: Operation): Promise<void> {
    for (const step of steps) {
      if (opts.signal?.aborted) throw new GitError('cancelled', 'Cancelled');
      if (step.type === 'fn') {
        await step.run();
        continue;
      }
      await this.runGitStep(step, opts, op);
    }
  }

  private async runGitStep(step: Extract<Step, { type: 'git' }>, opts: RunOpOptions, op?: Operation): Promise<void> {
    const env: Record<string, string> = {};
    const disposables: { dispose(): void }[] = [];
    const interactive = opts.interactive !== false;
    try {
      if (step.auth) {
        const auth = await this.repo.helpers.authEnv((prompt) => this.repo.env.askpass(prompt, { interactive, repo: this.repo.id }));
        disposables.push(auth);
        Object.assign(env, auth.env);
      }
      if (step.rebaseEditor) {
        const ed = await this.repo.rebase.editorEnv();
        disposables.push(ed);
        Object.assign(env, ed.env);
      }
      const runOnce = (signal?: AbortSignal, report?: (m: string, p?: number) => void) =>
        this.repo.runner.run(step.args, {
          queue: step.queue,
          alsoWrite: step.alsoWrite,
          stdin: step.stdin,
          okExitCodes: step.okExitCodes,
          env,
          signal,
          onProgress: report
            ? (p) => {
                report(p.message, p.percent);
                if (opts.opId) {
                  this.repo.env.postEvent(this.repo.id, {
                    type: 'op/progress',
                    opId: opts.opId,
                    title: step.progress ?? '',
                    message: p.message,
                    percent: p.percent,
                  });
                }
              }
            : undefined,
        });

      if (step.progress && interactive) {
        await this.repo.env.withProgress(step.progress, true, async (report, cancel) => {
          const ctrl = new AbortController();
          const abort = () => ctrl.abort();
          cancel.addEventListener('abort', abort);
          opts.signal?.addEventListener('abort', abort);
          try {
            await runOnce(ctrl.signal, report);
          } finally {
            cancel.removeEventListener('abort', abort);
            opts.signal?.removeEventListener('abort', abort);
          }
        });
      } else {
        await runOnce(opts.signal, step.progress ? () => undefined : undefined);
      }
    } catch (e) {
      if (e instanceof GitError && e.category === 'auth' && !interactive && op?.kind === 'fetch') {
        this.repo.snapshot.authRequired.add(op.remote);
      }
      if (e instanceof Error && e.name === 'AbortError') throw new GitError('cancelled', 'Cancelled');
      throw e;
    } finally {
      for (const d of disposables) d.dispose();
    }
  }

  /** Turn an operation into a sequence of git commands */
  async plan(op: Operation): Promise<Step[]> {
    const w = (args: string[], extra: Partial<Extract<Step, { type: 'git' }>> = {}): Step => ({ type: 'git', args, queue: 'write', ...extra });
    const net = (args: string[], progress: string, extra: Partial<Extract<Step, { type: 'git' }>> = {}): Step => ({
      type: 'git',
      args,
      queue: 'net',
      auth: true,
      progress,
      ...extra,
    });

    switch (op.kind) {
      case 'checkout': {
        if (op.createTracking) {
          return [w(['switch', '-c', assertRef(op.createTracking, 'branch name'), '--track', '--end-of-options', assertRev(op.ref)])];
        }
        const snap = await this.repo.snapshot.get();
        const isLocal = snap.refs.some((r) => r.kind === 'head' && r.name === op.ref);
        if (isLocal && !op.detach) return [w(['switch', '--end-of-options', assertRef(op.ref, 'branch name')])];
        return [w(['switch', '--detach', '--end-of-options', assertRev(op.ref)])];
      }

      case 'branch/create':
        return op.checkout
          ? [w(['switch', '-c', assertRef(op.name, 'branch name'), '--end-of-options', assertRev(op.start)])]
          : [w(['branch', '--end-of-options', assertRef(op.name, 'branch name'), assertRev(op.start)])];

      case 'branch/delete': {
        const steps: Step[] = [];
        if (op.names.length > 0) steps.push(w(['branch', op.force ? '-D' : '-d', '--end-of-options', ...op.names.map((n) => assertRef(n, 'branch name'))]));
        for (const rb of op.remoteBranches ?? []) {
          steps.push(net(['push', '--progress', '--delete', '--end-of-options', assertRemote(rb.remote), assertRef(rb.branch, 'branch name')], `Deleting ${rb.remote}/${rb.branch}`));
        }
        return steps;
      }

      case 'branch/rename':
        return [w(['branch', '-m', '--end-of-options', assertRef(op.from, 'branch name'), assertRef(op.to, 'branch name')])];

      case 'branch/setUpstream':
        return op.upstream
          ? [w(['branch', `--set-upstream-to=${assertRef(op.upstream, 'upstream')}`, '--end-of-options', assertRef(op.branch, 'branch name')])]
          : [w(['branch', '--unset-upstream', '--end-of-options', assertRef(op.branch, 'branch name')])];

      case 'remoteBranch/delete':
        return [net(['push', '--progress', '--delete', '--end-of-options', assertRemote(op.remote), assertRef(op.branch, 'branch name')], `Deleting ${op.remote}/${op.branch}`)];

      case 'merge': {
        if (op.squash && op.noFastForward) throw new GitError('invalid', 'Squash cannot be combined with --no-ff');
        const args = ['merge', '--no-edit'];
        if (op.noFastForward) args.push('--no-ff');
        if (op.squash) args.push('--squash');
        if (!op.commit && !op.squash) args.push('--no-commit');
        if (op.autostash) {
          if (!this.repo.features.pullAutostash) throw new GitError('invalid', 'git 2.27 or later is required for --autostash');
          args.push('--autostash');
        }
        args.push('--end-of-options', assertRev(op.ref));
        return [w(args)];
      }

      case 'rebase': {
        const args = ['rebase'];
        if (op.autostash) args.push('--autostash');
        if (op.updateRefs && this.repo.features.updateRefs) args.push('--update-refs');
        args.push('--end-of-options', assertRev(op.onto));
        return [w(args)];
      }

      case 'cherry-pick': {
        if (op.shas.length === 0) throw new GitError('invalid', 'No commits selected');
        const shas = op.shas.map(assertSha);
        const merges = await Promise.all(shas.map(async (s) => (await this.repo.diff.parentsOf(s)).length > 1));
        const args = ['cherry-pick'];
        if (op.noCommit) args.push('-n');
        // A merge commit is based on its first parent (since 2.21, -m 1 can also be given for non-merge commits)
        if (merges.some(Boolean)) args.push('-m', '1');
        args.push('--end-of-options', ...shas);
        return [w(args)];
      }

      case 'revert': {
        const sha = assertSha(op.sha);
        const parents = await this.repo.diff.parentsOf(sha);
        const args = ['revert', '--no-edit'];
        if (parents.length > 1) args.push('-m', '1');
        args.push('--end-of-options', sha);
        return [w(args)];
      }

      case 'reset':
        return [w(['reset', `--${op.mode}`, '--end-of-options', assertSha(op.sha)])];

      case 'fetch': {
        const args = ['fetch', '--progress'];
        if (op.prune) args.push('--prune');
        if (op.tags) args.push('--tags');
        if (op.remote === '*') args.push('--all');
        else args.push('--end-of-options', assertRemote(op.remote));
        return [net(args, op.remote === '*' ? 'Fetching all remotes' : `Fetching ${op.remote}`)];
      }

      case 'pull': {
        const remote = assertRemote(op.remote);
        const branch = assertRef(op.branch, 'branch name');
        if (op.into && op.into !== (await this.repo.snapshot.get()).head.branch) {
          // git pull always merges into HEAD, so for a branch that is not checked out, only fast-forward it with fetch
          // (if the branches have diverged, git rejects it with [rejected])
          const into = assertRef(op.into, 'branch name');
          return [
            net(['fetch', '--progress', '--end-of-options', remote, `refs/heads/${branch}:refs/heads/${into}`], `Pulling ${remote}/${branch} into ${into}`, {
              alsoWrite: true,
            }),
          ];
        }
        const args = ['pull', '--progress', op.rebase ? '--rebase' : '--no-rebase'];
        if (op.ffOnly) args.push('--ff-only');
        if (op.autostash) {
          if (!op.rebase && !this.repo.features.pullAutostash) throw new GitError('invalid', 'git 2.27 or later is required for --autostash without --rebase');
          args.push('--autostash');
        }
        args.push(remote, branch);
        return [net(args, `Pulling ${remote}/${branch}`, { alsoWrite: true })];
      }

      case 'push': {
        const mode = this.repo.env.config().forcePushMode;
        const force = op.force ? (mode === 'force' ? ['--force'] : ['--force-with-lease', '--force-if-includes']) : [];
        const remote = assertRemote(op.remote);
        const refspec = (b: { local: string; remote: string }) => `refs/heads/${assertRef(b.local, 'branch name')}:refs/heads/${assertRef(b.remote, 'branch name')}`;
        const steps: Step[] = [];
        const tracked = op.branches.filter((b) => b.setUpstream);
        const plain = op.branches.filter((b) => !b.setUpstream);
        const groups: [string[], typeof op.branches][] = [];
        if (tracked.length > 0) groups.push([['-u'], tracked]);
        if (plain.length > 0 || op.branches.length === 0) groups.push([[], plain]);
        groups.forEach(([flags, branches], i) => {
          const tags = op.tags && i === groups.length - 1 ? ['--tags'] : [];
          if (branches.length === 0 && tags.length === 0) return;
          steps.push(net(['push', '--progress', ...flags, ...force, ...tags, '--end-of-options', remote, ...branches.map(refspec)], `Pushing to ${remote}`));
        });
        if (steps.length === 0) throw new GitError('invalid', 'Nothing to push');
        return steps;
      }

      case 'stash/push': {
        const args = ['stash', 'push'];
        if (op.stagedOnly) {
          if (!this.repo.features.stashStaged) throw new GitError('invalid', 'git 2.35 or later is required for --staged');
          args.push('--staged');
        } else {
          if (op.keepIndex) args.push('--keep-index');
          if (op.includeUntracked) args.push('--include-untracked');
        }
        if (op.message) args.push('-m', op.message);
        return [w(args)];
      }

      case 'stash/apply': {
        const args = ['stash', op.drop ? 'pop' : 'apply'];
        if (op.restoreIndex) args.push('--index');
        args.push(`stash@{${Math.trunc(op.index)}}`);
        return [w(args)];
      }

      case 'stash/drop':
        return [w(['stash', 'drop', `stash@{${Math.trunc(op.index)}}`])];

      case 'stash/branch':
        return [w(['stash', 'branch', assertRef(op.name, 'branch name'), `stash@{${Math.trunc(op.index)}}`])];

      case 'tag/create': {
        const name = assertRef(op.name, 'tag name');
        const steps: Step[] = [
          op.message
            ? w(['tag', '-a', '-F', '-', '--end-of-options', name, assertSha(op.sha)], { stdin: op.message })
            : w(['tag', '--end-of-options', name, assertSha(op.sha)]),
        ];
        if (op.pushTo) steps.push(net(['push', '--progress', '--end-of-options', assertRemote(op.pushTo), `refs/tags/${name}`], `Pushing tag ${name}`));
        return steps;
      }

      case 'tag/delete': {
        const name = assertRef(op.name, 'tag name');
        const steps: Step[] = [w(['tag', '-d', '--end-of-options', name])];
        if (op.remote) steps.push(net(['push', '--progress', '--delete', '--end-of-options', assertRemote(op.remote), `refs/tags/${name}`], `Deleting tag ${name}`));
        return steps;
      }

      case 'tag/push':
        return [net(['push', '--progress', '--end-of-options', assertRemote(op.remote), `refs/tags/${assertRef(op.name, 'tag name')}`], `Pushing tag ${op.name}`)];

      case 'discard': {
        const steps: Step[] = [];
        const tracked = op.paths.map((p) => this.repo.relPath(p));
        if (tracked.length > 0) {
          steps.push(w(['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: Buffer.from(tracked.join('\0') + '\0') }));
        }
        const untracked = op.untracked.map((p) => this.repo.resolvePath(p));
        if (untracked.length > 0) {
          steps.push({
            type: 'fn',
            describe: `(move ${untracked.length} untracked file(s) to the trash)`,
            run: () => this.repo.env.trash(untracked),
          });
        }
        return steps;
      }

      case 'conflict/resolve': {
        const seq = this.repo.snapshot.readSequence();
        // During a rebase, ours is the base being rebased onto and theirs is the commit being reapplied, the opposite of a merge
        const rebasing = seq?.kind === 'rebase';
        const useOurs = (op.side === 'current') !== rebasing;
        const status = await this.repo.status.getParsed();
        const steps: Step[] = [];
        const checkout: string[] = [];
        const remove: string[] = [];
        for (const p of op.paths) {
          const rel = this.repo.relPath(p);
          const c = status.conflicted.find((f) => f.path === rel)?.conflict ?? 'UU';
          // DU: deleted on our side / UD: deleted on their side. If the chosen side is a deletion, use git rm
          const deletedOnChosenSide = useOurs ? c[0] === 'D' : c[1] === 'D';
          (deletedOnChosenSide ? remove : checkout).push(rel);
        }
        if (checkout.length > 0) {
          steps.push(w(['checkout', useOurs ? '--ours' : '--theirs', '--', ...checkout]));
          steps.push(w(['add', '--', ...checkout]));
        }
        if (remove.length > 0) steps.push(w(['rm', '-q', '--', ...remove]));
        return steps;
      }

      case 'conflict/mark': {
        const rels = op.paths.map((p) => this.repo.relPath(p));
        return op.resolved ? [w(['add', '--', ...rels])] : [w(['checkout', '-m', '--', ...rels])];
      }

      case 'file/restore':
        return [w(['restore', `--source=${assertSha(op.sha)}`, '--staged', '--worktree', '--', this.repo.relPath(op.path)])];

      case 'gitignore/add': {
        const pattern = op.pattern.replace(/[\r\n]/g, '');
        if (!pattern) throw new GitError('invalid', 'Empty pattern');
        const file = path.join(this.repo.root, '.gitignore');
        return [
          {
            type: 'fn',
            describe: `(append "${pattern}" to .gitignore)`,
            run: async () => {
              let current = '';
              try {
                current = await readFile(file, 'utf8');
              } catch {
                /* New file */
              }
              const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
              await appendFile(file, `${prefix}${pattern}\n`, 'utf8');
            },
          },
        ];
      }

      case 'remote/add':
        return [w(['remote', 'add', '--end-of-options', assertRemote(op.name), op.url])];

      case 'remote/edit': {
        const steps: Step[] = [];
        let name = assertRemote(op.name);
        if (op.newName && op.newName !== op.name) {
          steps.push(w(['remote', 'rename', '--end-of-options', name, assertRemote(op.newName)]));
          name = op.newName;
        }
        steps.push(w(['remote', 'set-url', '--end-of-options', name, op.url]));
        return steps;
      }

      case 'remote/remove':
        return [w(['remote', 'remove', '--end-of-options', assertRemote(op.name)])];

      case 'config/user': {
        const set = (key: string, value: string) =>
          value ? w(['config', '--local', key, value]) : w(['config', '--local', '--unset', key], { okExitCodes: [5] });
        return [set('user.name', op.name), set('user.email', op.email)];
      }

      case 'rebase/interactive':
        return this.repo.rebase.plan(op.base, op.todo);

      case 'sequence/control':
        return this.planSequenceControl(op.action, op.message);
    }
  }

  private planSequenceControl(action: 'continue' | 'skip' | 'abort', message?: string): Step[] {
    const seq = this.repo.snapshot.readSequence();
    if (!seq) throw new GitError('invalid', 'No operation is in progress');
    const w = (args: string[], extra: Partial<Extract<Step, { type: 'git' }>> = {}): Step => ({ type: 'git', args, queue: 'write', ...extra });
    switch (seq.kind) {
      case 'merge':
        if (action === 'abort') return [w(['merge', '--abort'])];
        if (action === 'skip') throw new GitError('invalid', 'A merge cannot be skipped');
        return message?.trim() ? [w(['commit', '-F', '-'], { stdin: message })] : [w(['commit', '--no-edit'])];
      case 'rebase':
        return [w(['rebase', `--${action}`], { rebaseEditor: action === 'continue' && !!seq.interactive })];
      case 'cherry-pick':
        return [w(['cherry-pick', `--${action}`])];
      case 'revert':
        return [w(['revert', `--${action}`])];
    }
  }
}

function isSequenceOp(op: Operation): boolean {
  return ['merge', 'rebase', 'cherry-pick', 'revert', 'pull', 'stash/apply', 'sequence/control', 'rebase/interactive'].includes(op.kind);
}
