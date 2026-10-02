import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TwiglineConfig } from '../../shared/protocol';
import type { HostEnv } from '../../src/host/HostEnv';
import { GitHelpers } from '../../src/ipc/helpers';
import { RepoModel, type GitInfo } from '../../src/repo/RepoModel';
import { parseGitVersion } from '../../src/git/GitRunner';

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  LC_ALL: 'en_US.UTF-8',
};

export interface TempRepo {
  dir: string;
  git(args: string[], opts?: { input?: string | Buffer; env?: Record<string, string> }): string;
  gitBuf(args: string[], opts?: { input?: string | Buffer }): Buffer;
  write(rel: string, content: string | Buffer): void;
  read(rel: string): Buffer;
  commit(message: string, files?: Record<string, string | Buffer>): string;
  cleanup(): void;
}

export function makeRepo(opts: { init?: boolean; bare?: boolean } = {}): TempRepo {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'twigline-test-'));
  const gitBuf = (args: string[], o: { input?: string | Buffer; env?: Record<string, string> } = {}) =>
    execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      env: { ...process.env, ...GIT_ENV, ...o.env },
      input: o.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  const repo: TempRepo = {
    dir,
    gitBuf,
    git: (args, o) => gitBuf(args, o).toString('utf8'),
    write(rel, content) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    read(rel) {
      return readFileSync(path.join(dir, rel));
    },
    commit(message, files) {
      if (files) {
        for (const [k, v] of Object.entries(files)) repo.write(k, v);
        repo.git(['add', '-A']);
      }
      repo.git(['commit', '-q', '--allow-empty', '-m', message]);
      return repo.git(['rev-parse', 'HEAD']).trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  if (opts.init !== false) {
    repo.git(opts.bare ? ['init', '-q', '--bare'] : ['init', '-q']);
    if (!opts.bare) {
      repo.git(['config', 'user.name', 'Test User']);
      repo.git(['config', 'user.email', 'test@example.com']);
      repo.git(['config', 'core.autocrlf', 'false']);
      repo.git(['config', 'commit.gpgsign', 'false']);
    }
  }
  return repo;
}

export const TEST_CONFIG: TwiglineConfig = {
  historyOrder: 'date',
  historyBranches: 'all',
  showRemoteBranches: true,
  showStashes: false,
  pageSize: 500,
  dateFormat: 'absolute',
  graphColors: ['#000'],
  fileStatusLayout: 'split',
  fileStatusView: 'list',
  contextLines: 3,
  ignoreWhitespace: false,
  maxDiffLines: 5000,
  syntaxHighlight: true,
  forcePushMode: 'withLease',
  rememberPushAfter: true,
  pullRequests: true,
  customActions: [],
};

/** HostEnv for tests (runs on Node only) */
export function testEnv(overrides: Partial<HostEnv> = {}): HostEnv {
  const state = new Map<string, Record<string, unknown>>();
  return {
    encodingFor: () => ({ encoding: 'utf8', autoGuess: true, language: 'ja' }),
    config: () => TEST_CONFIG,
    trash: async () => undefined,
    askpass: async () => undefined,
    logCommand: () => undefined,
    showMessage: () => undefined,
    withProgress: (_t, _c, task) => task(() => undefined, new AbortController().signal),
    uiAction: async () => undefined,
    watch: () => ({ dispose: () => undefined }),
    getState: (repo) => state.get(repo) ?? {},
    setState: (repo, patch) => state.set(repo, { ...(state.get(repo) ?? {}), ...patch }),
    postEvent: () => undefined,
    editMessage: async () => null,
    extensionPath: path.resolve(__dirname, '../..'),
    helperExecPath: process.execPath,
    ...overrides,
  };
}

let gitInfo: GitInfo | undefined;
export function testGit(): GitInfo {
  if (!gitInfo) {
    const v = parseGitVersion(execFileSync('git', ['--version']).toString());
    gitInfo = { path: 'git', version: v.text, parts: v.parts };
  }
  return gitInfo;
}

export async function openModel(dir: string, env: HostEnv = testEnv()): Promise<RepoModel> {
  return RepoModel.open(dir, testGit(), env, new GitHelpers(env.extensionPath, env.helperExecPath));
}
