import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommitInfo, Sha } from '../../shared/protocol';
import { GitError } from '../git/errors';
import { parseConfigZ } from '../git/parsers/refs';
import { ALL_KINDS, type RepoModel } from '../repo/RepoModel';

export interface CreateCommitParams {
  message: string;
  amend: boolean;
  signoff: boolean;
  noVerify: boolean;
  pushAfter: boolean;
}

export interface PushTarget {
  branch: string;
  remote: string;
  remoteBranch: string;
  /** No upstream yet: the remote branch is created and set as the upstream */
  setUpstream: boolean;
}

/** Commit box: author, previous messages, template, commit, push after commit */
export class CommitService {
  constructor(private readonly repo: RepoModel) {}

  async info(): Promise<CommitInfo> {
    const r = this.repo.runner;
    const snap = await this.repo.snapshot.get();
    const [ident, last, recent, template] = await Promise.all([
      r.run(['var', 'GIT_AUTHOR_IDENT'], { noThrow: true }),
      snap.head.unborn ? undefined : r.run(['log', '-1', '--encoding=UTF-8', '--format=%B'], { noThrow: true }),
      snap.head.unborn ? undefined : r.run(['log', '-n', '20', '-z', '--encoding=UTF-8', '--format=%B'], { noThrow: true }),
      this.readTemplate(),
    ]);
    const m = /^(.*) <([^>]*)>/.exec(ident.stdout.toString('utf8'));
    const seen = new Set<string>();
    const recentMessages: string[] = [];
    for (const msg of recent?.stdout.toString('utf8').split('\0') ?? []) {
      const t = msg.replace(/^\n+|\n+$/g, '');
      if (t && !seen.has(t)) {
        seen.add(t);
        recentMessages.push(t);
      }
    }
    const state = this.repo.env.getState(this.repo.id);
    return {
      author: m ? { name: m[1], email: m[2] } : { name: snap.user.name, email: snap.user.email },
      lastMessage: last?.stdout.toString('utf8').replace(/\n+$/, ''),
      recentMessages,
      template,
      pushAfter: this.repo.env.config().rememberPushAfter ? state.pushAfter === true : false,
      upstream: snap.head.upstream,
    };
  }

  private async readTemplate(): Promise<string | undefined> {
    const res = await this.repo.runner.run(['config', '--get', 'commit.template'], { noThrow: true });
    let file = res.stdout.toString('utf8').trim();
    if (!file) return undefined;
    if (file.startsWith('~/')) file = path.join(os.homedir(), file.slice(2));
    if (!path.isAbsolute(file)) file = path.join(this.repo.root, file);
    try {
      return (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    } catch {
      return undefined;
    }
  }

  async create(p: CreateCommitParams): Promise<{ sha: Sha; pushed: boolean }> {
    if (!p.message.trim()) throw new GitError('invalid', 'The commit message is empty');
    if (this.repo.env.config().rememberPushAfter) this.repo.env.setState(this.repo.id, { pushAfter: p.pushAfter });
    const args = ['commit', '-F', '-'];
    if (p.amend) args.push('--amend');
    if (p.signoff) args.push('--signoff');
    if (p.noVerify) args.push('--no-verify');
    const sha = await this.repo.runOp(ALL_KINDS, async () => {
      // Pass the message on stdin (avoids problems with newlines, encodings and length)
      await this.repo.runner.run(args, { queue: 'write', stdin: p.message });
      const head = await this.repo.runner.run(['rev-parse', 'HEAD']);
      return head.stdout.toString('utf8').trim();
    });
    if (!p.pushAfter) return { sha, pushed: false };
    await this.pushCurrent();
    return { sha, pushed: true };
  }

  /** Push the current branch to where pushTarget() points (pass a target already shown to the user to push exactly there) */
  async pushCurrent(target?: PushTarget): Promise<void> {
    const to = target ?? (await this.pushTarget());
    await this.repo.ops.run({
      kind: 'push',
      remote: to.remote,
      branches: [{ local: to.branch, remote: to.remoteBranch, setUpstream: to.setUpstream }],
      tags: false,
      force: false,
    });
  }

  /** Where the current branch is pushed: its upstream. Without an upstream, a branch with the same name on the default remote, set as tracking */
  async pushTarget(): Promise<PushTarget> {
    this.repo.snapshot.invalidate();
    const snap = await this.repo.snapshot.get();
    const branch = snap.head.branch;
    if (!branch) throw new GitError('invalid', 'HEAD is detached; nothing to push');
    const cfg = await this.repo.runner.run(['config', '-z', '--get-regexp', `^branch\\.${escapeRegExp(branch)}\\.(remote|merge)$`], {
      noThrow: true,
    });
    const map = parseConfigZ(cfg.stdout.toString('utf8'));
    const remote = map.get(`branch.${branch}.remote`)?.[0];
    const merge = map.get(`branch.${branch}.merge`)?.[0];
    if (remote && merge?.startsWith('refs/heads/') && remote !== '.') {
      return { branch, remote, remoteBranch: merge.slice(11), setUpstream: false };
    }
    const fallback = snap.remotes.find((r) => r.name === 'origin')?.name ?? snap.remotes[0]?.name;
    if (!fallback) throw new GitError('noUpstream', 'No remote is configured');
    return { branch, remote: fallback, remoteBranch: branch, setUpstream: true };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
