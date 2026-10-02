import type { WorkingTreeStatus } from '../../shared/protocol';
import { parseStatusV2, type ParsedStatus } from '../git/parsers/status';
import type { RepoModel } from '../repo/RepoModel';

/** State of the working tree (git status --porcelain=v2) */
export class StatusService {
  private cache?: Promise<ParsedStatus>;

  constructor(private readonly repo: RepoModel) {}

  invalidate(): void {
    this.cache = undefined;
  }

  getParsed(): Promise<ParsedStatus> {
    this.cache ??= this.repo.runner
      .run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--no-renames'])
      .then((res) => parseStatusV2(res.stdout))
      .catch((e) => {
        this.cache = undefined;
        throw e;
      });
    return this.cache;
  }

  async get(): Promise<WorkingTreeStatus> {
    const s = await this.getParsed();
    return { staged: s.staged, unstaged: s.unstaged, conflicted: s.conflicted };
  }
}
