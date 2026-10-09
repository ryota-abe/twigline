import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { HeadInfo, RepoSnapshot, SequenceState, SubmoduleInfo } from '../../shared/protocol';
import { FOR_EACH_REF_FORMAT, FOR_EACH_REF_FORMAT_NO_WORKTREE, STASH_FORMAT, parseConfigZ, parseForEachRef, parseStashList, remotesFromConfig } from '../git/parsers/refs';
import type { RepoModel } from '../repo/RepoModel';
import { readSequenceIn } from '../repo/sequence';

/** repo/snapshot: HEAD, refs, remotes, stashes and the operation in progress */
export class SnapshotService {
  private cache?: Promise<RepoSnapshot>;
  /** Remotes where authentication failed in the periodic fetch */
  readonly authRequired = new Set<string>();

  constructor(private readonly repo: RepoModel) {}

  invalidate(): void {
    this.cache = undefined;
  }

  get(): Promise<RepoSnapshot> {
    this.cache ??= this.load().catch((e) => {
      this.cache = undefined;
      throw e;
    });
    return this.cache;
  }

  private async load(): Promise<RepoSnapshot> {
    const r = this.repo.runner;
    const [headRef, headSha, refsOut, stashOut, configOut, submodules] = await Promise.all([
      r.run(['symbolic-ref', '-q', 'HEAD'], { noThrow: true }),
      r.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { noThrow: true }),
      r.run(['for-each-ref', `--format=${this.repo.features.worktreePath ? FOR_EACH_REF_FORMAT : FOR_EACH_REF_FORMAT_NO_WORKTREE}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      r.run(['stash', 'list', '-z', `--format=${STASH_FORMAT}`], { noThrow: true }),
      r.run(['config', '-z', '--get-regexp', '^(remote\\..+\\.(url|pushurl)|user\\.(name|email))$'], { noThrow: true }),
      this.readSubmodules(),
    ]);

    const config = parseConfigZ(configOut.stdout.toString('utf8'));
    const remotes = remotesFromConfig(config).map((rm) => ({ ...rm, authRequired: this.authRequired.has(rm.name) || undefined }));
    const refs = parseForEachRef(
      refsOut.stdout.toString('utf8'),
      remotes.map((x) => x.name),
    );

    const symbolic = headRef.exitCode === 0 ? headRef.stdout.toString('utf8').trim() : '';
    const sha = headSha.exitCode === 0 ? headSha.stdout.toString('utf8').trim() : null;
    const branch = symbolic.startsWith('refs/heads/') ? symbolic.slice('refs/heads/'.length) : null;
    const headBranchRef = branch ? refs.find((x) => x.kind === 'head' && x.name === branch) : undefined;
    const head: HeadInfo = {
      sha,
      branch,
      detached: !symbolic,
      unborn: sha === null,
      upstream: headBranchRef?.upstream,
      ahead: headBranchRef?.ahead ?? 0,
      behind: headBranchRef?.behind ?? 0,
    };
    for (const ref of refs) if (ref.kind === 'head') ref.isHead = ref.name === branch;

    const last = (key: string) => {
      const v = config.get(key);
      return v ? v[v.length - 1] : undefined;
    };

    return {
      repo: this.repo.id,
      root: this.repo.root,
      name: this.repo.name,
      head,
      refs,
      remotes,
      stashes: parseStashList(stashOut.stdout.toString('utf8')),
      sequence: this.readSequence(),
      submodules,
      user: { name: last('user.name'), email: last('user.email') },
      features: { stashStaged: this.repo.features.stashStaged, updateRefs: this.repo.features.updateRefs, pullAutostash: this.repo.features.pullAutostash },
      gitVersion: this.repo.git.version,
      objectFormat: this.repo.objectFormat,
    };
  }

  private async readSubmodules(): Promise<SubmoduleInfo[]> {
    const file = path.join(this.repo.root, '.gitmodules');
    if (!existsSync(file)) return [];
    const res = await this.repo.runner.run(['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], {
      noThrow: true,
    });
    const map = parseConfigZ(res.stdout.toString('utf8'));
    const list: SubmoduleInfo[] = [];
    for (const values of map.values()) for (const v of values) list.push({ path: v });
    return list.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The operation in progress (sequence) */
  readSequence(): SequenceState | null {
    return readSequenceIn(this.repo.gitDir);
  }
}
