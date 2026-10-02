import { afterEach, describe, expect, it } from 'vitest';
import type { RefInfo, RemoteInfo } from '../../shared/protocol';
import type { HostEnv } from '../../src/host/HostEnv';
import type { RepoModel } from '../../src/repo/RepoModel';
import { branchQuery, fetchBitbucketPullRequests, parseBitbucketPullRequests, pullRequestsUrl } from '../../src/util/bitbucket';
import { buildPullRequestQuery, fetchGitHubPullRequests, parseGraphQLPullRequests, parseRestPullRequests } from '../../src/util/github';
import { hostedRepoOf } from '../../src/util/hosting';
import { PullRequestError, matchPullRequests, pullRequestTargets, type FetchLike } from '../../src/util/pullRequests';
import { TEST_CONFIG, makeRepo, openModel, testEnv, type TempRepo } from './helpers';

// Pull requests linked to branches (GitHub, Bitbucket Cloud): remote detection, queries, response conversion, matching with branches, caching

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

/** Stand-in for fetch that returns responses in order. A response with only a status has no body */
function fakeFetch(respond: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      json: async () => r.body,
    };
  };
  return { impl, calls };
}

const gqlNode = (p: { number: number; head: string; owner?: string; state?: string; draft?: boolean; updated?: string }) => ({
  number: p.number,
  title: `PR ${p.number}`,
  url: `https://github.com/me/repo/pull/${p.number}`,
  state: p.state ?? 'OPEN',
  isDraft: p.draft ?? false,
  headRefName: p.head,
  headRefOid: 'a'.repeat(40),
  baseRefName: 'main',
  updatedAt: p.updated ?? '2026-09-01T00:00:00Z',
  headRepositoryOwner: { login: p.owner ?? 'me' },
  author: { login: 'me' },
});

const restItem = (p: { number: number; head: string; state?: 'open' | 'closed'; merged?: boolean; draft?: boolean; owner?: string | null }) => ({
  number: p.number,
  title: `PR ${p.number}`,
  html_url: `https://github.com/me/repo/pull/${p.number}`,
  state: p.state ?? 'open',
  draft: p.draft ?? false,
  merged_at: p.merged ? '2026-09-02T00:00:00Z' : null,
  updated_at: '2026-09-02T00:00:00Z',
  user: { login: 'me' },
  head: { ref: p.head, sha: 'b'.repeat(40), repo: p.owner === null ? null : { owner: { login: p.owner ?? 'me' } }, user: { login: 'me' } },
  base: { ref: 'main' },
});

describe('hosted remotes', () => {
  it.each([
    ['git@github.com:me/repo.git', { provider: 'github', host: 'github.com', owner: 'me', name: 'repo' }],
    ['https://github.com/me/repo', { provider: 'github', host: 'github.com', owner: 'me', name: 'repo' }],
    ['ssh://git@ssh.github.com:443/me/repo.git', { provider: 'github', host: 'github.com', owner: 'me', name: 'repo' }],
    ['https://GitHub.example.com/org/repo.git', { provider: 'github', host: 'github.example.com', owner: 'org', name: 'repo' }],
    ['git@bitbucket.org:team/app.git', { provider: 'bitbucket', host: 'bitbucket.org', owner: 'team', name: 'app' }],
    ['https://me@bitbucket.org/team/app.git', { provider: 'bitbucket', host: 'bitbucket.org', owner: 'team', name: 'app' }],
    ['ssh://git@altssh.bitbucket.org:443/team/app.git', { provider: 'bitbucket', host: 'bitbucket.org', owner: 'team', name: 'app' }],
    // Bitbucket Data Center is out of scope
    ['https://bitbucket.example.com/scm/proj/app.git', undefined],
    ['https://gitlab.com/g/repo.git', undefined],
    ['https://github.com/me', undefined],
    [undefined, undefined],
  ])('%s', (url, expected) => {
    expect(hostedRepoOf(url)).toEqual(expected);
  });

  it('finds the branch each local and remote branch pushes to', () => {
    const remotes: RemoteInfo[] = [
      { name: 'origin', fetchUrl: 'git@github.com:me/repo.git' },
      { name: 'gl', fetchUrl: 'git@gitlab.com:me/repo.git' },
      { name: 'bb', fetchUrl: 'git@bitbucket.org:team/app.git' },
    ];
    const ref = (kind: RefInfo['kind'], name: string, extra: Partial<RefInfo> = {}): RefInfo => ({
      kind,
      name,
      fullName: `refs/${kind === 'head' ? 'heads' : kind === 'remote' ? 'remotes' : 'tags'}/${name}`,
      sha: '0'.repeat(40),
      ...extra,
    });
    const refs = [
      ref('head', 'feature/a', { upstream: 'origin/feature/a' }),
      // The upstream has a different name
      ref('head', 'topic', { upstream: 'origin/renamed' }),
      // No upstream, but there is a remote branch with the same name
      ref('head', 'same'),
      // Not pushed
      ref('head', 'local-only'),
      // A remote that is not GitHub
      ref('head', 'gitlab', { upstream: 'gl/gitlab' }),
      ref('remote', 'origin/same', { remote: 'origin' }),
      ref('remote', 'origin/claude/x', { remote: 'origin' }),
      ref('remote', 'gl/gitlab', { remote: 'gl' }),
      ref('head', 'bb-topic', { upstream: 'bb/topic' }),
      ref('tag', 'v1'),
    ];
    const targets = pullRequestTargets(refs, remotes).map((t) => [t.ref, `${t.repo.owner}/${t.repo.name}`, t.headRef, t.local]);
    expect(targets).toEqual([
      ['refs/heads/feature/a', 'me/repo', 'feature/a', true],
      ['refs/heads/topic', 'me/repo', 'renamed', true],
      ['refs/heads/same', 'me/repo', 'same', true],
      ['refs/remotes/origin/same', 'me/repo', 'same', false],
      ['refs/remotes/origin/claude/x', 'me/repo', 'claude/x', false],
      ['refs/heads/bb-topic', 'team/app', 'topic', true],
    ]);
    expect(pullRequestTargets(refs, [remotes[1]])).toEqual([]);
  });
});

describe('GitHub responses', () => {
  it('passes branch names as variables and asks for recent PRs once', () => {
    const q = buildPullRequestQuery(['a"b', 'c'], true);
    expect(q.query).not.toContain('a"b');
    expect(q.query).toContain('recent: pullRequests(first: 100');
    expect(q.query).toContain('h1: pullRequests(headRefName: $h1');
    expect(q.variables).toEqual({ h0: 'a"b', h1: 'c' });
    expect(buildPullRequestQuery([], false).query).not.toContain('recent');
  });

  it('maps GraphQL and REST states to open, draft, merged and closed', () => {
    const gql = parseGraphQLPullRequests('github.com', {
      recent: { nodes: [gqlNode({ number: 1, head: 'a' }), gqlNode({ number: 2, head: 'b', draft: true })] },
      h0: { nodes: [gqlNode({ number: 3, head: 'c', state: 'MERGED' }), gqlNode({ number: 4, head: 'd', state: 'CLOSED' }), null] },
    });
    expect(gql.map((p) => [p.number, p.state, p.headOwner])).toEqual([
      [1, 'open', 'me'],
      [2, 'draft', 'me'],
      [3, 'merged', 'me'],
      [4, 'closed', 'me'],
    ]);
    expect(gql[0]).toMatchObject({ url: 'https://github.com/me/repo/pull/1', baseRef: 'main', headRef: 'a', updatedAt: 1788220800 });

    const rest = parseRestPullRequests('github.com', [
      restItem({ number: 5, head: 'e' }),
      restItem({ number: 6, head: 'f', draft: true }),
      restItem({ number: 7, head: 'g', state: 'closed', merged: true }),
      restItem({ number: 8, head: 'h', state: 'closed' }),
      // A fork whose original repository was deleted
      restItem({ number: 9, head: 'i', owner: null }),
      { ...restItem({ number: 10, head: 'j' }), html_url: 'javascript:alert(1)' },
    ]);
    expect(rest.map((p) => [p.number, p.state, p.headOwner])).toEqual([
      [5, 'open', 'me'],
      [6, 'draft', 'me'],
      [7, 'merged', 'me'],
      [8, 'closed', 'me'],
      [9, 'open', 'me'],
    ]);
  });

  it('prefers an open PR, then the latest one, and ignores PRs from other forks', () => {
    const repo = { provider: 'github' as const, host: 'github.com', owner: 'me', name: 'repo' };
    const targets = [
      { ref: 'refs/heads/a', repo, headRef: 'a', local: true },
      { ref: 'refs/heads/b', repo, headRef: 'b', local: true },
      { ref: 'refs/heads/c', repo, headRef: 'c', local: true },
      { ref: 'refs/remotes/fork/c', repo: { ...repo, owner: 'Someone' }, headRef: 'c', local: false },
    ];
    const candidates = parseGraphQLPullRequests('github.com', {
      recent: {
        nodes: [
          gqlNode({ number: 1, head: 'a', state: 'MERGED', updated: '2026-09-10T00:00:00Z' }),
          gqlNode({ number: 2, head: 'a', updated: '2026-09-01T00:00:00Z' }),
          gqlNode({ number: 3, head: 'b', state: 'CLOSED', updated: '2026-09-01T00:00:00Z' }),
          gqlNode({ number: 4, head: 'b', state: 'MERGED', updated: '2026-09-05T00:00:00Z' }),
          gqlNode({ number: 5, head: 'c', owner: 'someone' }),
        ],
      },
      // The same PR also appears in the query for another name
      h0: { nodes: [gqlNode({ number: 2, head: 'a', updated: '2026-09-01T00:00:00Z' })] },
    });
    const byRef = matchPullRequests(targets, candidates);
    expect(Object.fromEntries(Object.entries(byRef).map(([k, v]) => [k, v.number]))).toEqual({
      'refs/heads/a': 2,
      'refs/heads/b': 4,
      'refs/remotes/fork/c': 5,
    });
    expect(byRef['refs/heads/a']).not.toHaveProperty('headOwner');
  });
});

describe('GitHub requests', () => {
  const repo = { provider: 'github' as const, host: 'github.com', owner: 'me', name: 'repo' };

  it('reads recent PRs over REST without a token', async () => {
    const f = fakeFetch(() => ({ body: [restItem({ number: 1, head: 'a' })] }));
    const list = await fetchGitHubPullRequests(repo, ['a'], undefined, f.impl);
    expect(list.map((p) => p.number)).toEqual([1]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.github.com/repos/me/repo/pulls?state=all&sort=updated&direction=desc&per_page=100');
    expect(f.calls[0].headers).not.toHaveProperty('Authorization');
  });

  it('asks GraphQL for local branches in chunks with a token', async () => {
    const f = fakeFetch((c) => ({ body: { data: { repository: { h0: { nodes: [gqlNode({ number: 1, head: String((c.body!.variables as Record<string, string>).h0) })] } } } } }));
    const heads = Array.from({ length: 120 }, (_, i) => `b${i}`);
    const list = await fetchGitHubPullRequests(repo, [...heads, 'b0'], { token: 'tok' }, f.impl);
    expect(f.calls).toHaveLength(3);
    expect(f.calls.every((c) => c.url === 'https://api.github.com/graphql' && c.method === 'POST' && c.headers.Authorization === 'Bearer tok')).toBe(true);
    expect(f.calls.map((c) => String(c.body!.query).includes('recent:'))).toEqual([true, false, false]);
    expect(f.calls[0].body!.variables).toMatchObject({ owner: 'me', name: 'repo', h0: 'b0', h49: 'b49' });
    expect(f.calls[2].body!.variables).toMatchObject({ h0: 'b100', h19: 'b119' });
    expect(list.map((p) => p.headRef)).toEqual(['b0', 'b50', 'b100']);
  });

  it('falls back to REST with the token where GraphQL is refused', async () => {
    const f = fakeFetch((c) => (c.url.endsWith('/graphql') ? { status: 403 } : { body: [restItem({ number: 1, head: 'a' })] }));
    const list = await fetchGitHubPullRequests(repo, ['a'], { token: 'tok' }, f.impl);
    expect(list.map((p) => p.number)).toEqual([1]);
    expect(f.calls.map((c) => [c.method, c.headers.Authorization])).toEqual([
      ['POST', 'Bearer tok'],
      ['GET', 'Bearer tok'],
    ]);
  });

  it('uses the API paths of GitHub Enterprise Server', async () => {
    const f = fakeFetch(() => ({ body: [] }));
    await fetchGitHubPullRequests({ provider: 'github' as const, host: 'github.example.com', owner: 'o', name: 'r' }, [], undefined, f.impl);
    expect(f.calls[0].url).toMatch(/^https:\/\/github\.example\.com\/api\/v3\/repos\/o\/r\/pulls\?/);
    const g = fakeFetch(() => ({ body: { data: { repository: {} } } }));
    await fetchGitHubPullRequests({ provider: 'github' as const, host: 'github.example.com', owner: 'o', name: 'r' }, [], { token: 'tok' }, g.impl);
    expect(g.calls[0].url).toBe('https://github.example.com/api/graphql');
  });

  it.each([
    [{ status: 401 }, 'auth'],
    [{ status: 403, headers: { 'x-ratelimit-remaining': '0' } }, 'rateLimit'],
    [{ status: 403 }, 'auth'],
    [{ status: 404 }, 'notFound'],
    [{ status: 502 }, 'other'],
    [{ body: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] } }, 'notFound'],
    [new TypeError('fetch failed'), 'network'],
  ] as const)('classifies %j as %s', async (response, kind) => {
    const f = fakeFetch(() => (response instanceof Error ? response : { ...response }));
    const err = await fetchGitHubPullRequests(repo, [], { token: 'tok' }, f.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRequestError);
    expect((err as PullRequestError).kind).toBe(kind);
  });
});

const bbItem = (p: { id: number; head: string; state?: string; draft?: boolean; fork?: string | null }) => ({
  id: p.id,
  title: `PR ${p.id}`,
  state: p.state ?? 'OPEN',
  draft: p.draft ?? false,
  updated_on: '2026-09-02T00:00:00.123456+00:00',
  links: { html: { href: `https://bitbucket.org/team/app/pull-requests/${p.id}` } },
  source: { branch: { name: p.head }, repository: p.fork === null ? null : { full_name: p.fork ?? 'team/app' } },
  destination: { branch: { name: 'main' } },
  author: { display_name: 'Sato' },
});

describe('Bitbucket Cloud', () => {
  const repo = { provider: 'bitbucket' as const, host: 'bitbucket.org', owner: 'team', name: 'app' };

  it('asks for every state, newest first, and quotes branch names in BBQL', () => {
    const url = new URL(pullRequestsUrl(repo, branchQuery(['a', 'we"ird\\name'])));
    expect(url.origin + url.pathname).toBe('https://api.bitbucket.org/2.0/repositories/team/app/pullrequests');
    expect(url.searchParams.getAll('state')).toEqual(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']);
    expect(url.searchParams.get('sort')).toBe('-updated_on');
    expect(url.searchParams.get('pagelen')).toBe('50');
    expect(url.searchParams.get('q')).toBe('source.branch.name="a" OR source.branch.name="we\\"ird\\\\name"');
    // Encode a space as %20, not +
    expect(pullRequestsUrl(repo, 'x OR y')).toContain('q=x%20OR%20y');
  });

  it('maps states, including declined and superseded, and the fork owner', () => {
    const list = parseBitbucketPullRequests({
      values: [
        bbItem({ id: 1, head: 'a' }),
        bbItem({ id: 2, head: 'b', draft: true }),
        bbItem({ id: 3, head: 'c', state: 'MERGED' }),
        bbItem({ id: 4, head: 'd', state: 'DECLINED' }),
        bbItem({ id: 5, head: 'e', state: 'SUPERSEDED', fork: 'someone/app' }),
        bbItem({ id: 6, head: 'f', fork: null }),
      ],
    });
    expect(list.map((p) => [p.number, p.state, p.closedAs, p.headOwner])).toEqual([
      [1, 'open', undefined, 'team'],
      [2, 'draft', undefined, 'team'],
      [3, 'merged', undefined, 'team'],
      [4, 'closed', 'declined', 'team'],
      [5, 'closed', 'superseded', 'someone'],
      [6, 'open', undefined, undefined],
    ]);
    expect(list[0]).toMatchObject({ url: 'https://bitbucket.org/team/app/pull-requests/1', baseRef: 'main', headRef: 'a', author: 'Sato', updatedAt: 1788307200 });
    expect(list[0]).not.toHaveProperty('headSha');
    expect(parseBitbucketPullRequests({ type: 'error' })).toEqual([]);
  });

  it('reads only recent PRs without credentials', async () => {
    const f = fakeFetch(() => ({ body: { values: [bbItem({ id: 1, head: 'a' })] } }));
    const list = await fetchBitbucketPullRequests(repo, ['a', 'b'], undefined, f.impl);
    expect(list.map((p) => p.number)).toEqual([1]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].headers).not.toHaveProperty('Authorization');
    expect(new URL(f.calls[0].url).searchParams.has('q')).toBe(false);
  });

  it('looks up local branches by name in chunks with basic auth', async () => {
    const f = fakeFetch(() => ({ body: { values: [] } }));
    const heads = Array.from({ length: 45 }, (_, i) => `b${i}`);
    await fetchBitbucketPullRequests(repo, [...heads, 'b0'], { username: 'me@example.com', password: 'tok' }, f.impl);
    expect(f.calls).toHaveLength(4);
    const auth = `Basic ${Buffer.from('me@example.com:tok').toString('base64')}`;
    expect(f.calls.every((c) => c.method === 'GET' && c.headers.Authorization === auth)).toBe(true);
    const qs = f.calls.map((c) => new URL(c.url).searchParams.get('q'));
    expect(qs[0]).toBeNull();
    expect(qs[1]?.split(' OR ')).toHaveLength(20);
    expect(qs[3]).toBe('source.branch.name="b40" OR source.branch.name="b41" OR source.branch.name="b42" OR source.branch.name="b43" OR source.branch.name="b44"');
  });

  it('reports a private repository and bad credentials as Bitbucket errors', async () => {
    const notFound = await fetchBitbucketPullRequests(repo, [], undefined, fakeFetch(() => ({ status: 404 })).impl).catch((e: unknown) => e);
    expect(notFound).toMatchObject({ kind: 'notFound' });
    expect((notFound as Error).message).toContain('Bitbucket');
    const rejected = await fetchBitbucketPullRequests(repo, [], { username: 'u', password: 'p' }, fakeFetch(() => ({ status: 401 })).impl).catch((e: unknown) => e);
    expect(rejected).toMatchObject({ kind: 'auth' });
  });
});

describe('PullRequestService', () => {
  const repos: TempRepo[] = [];
  const models: RepoModel[] = [];
  afterEach(() => {
    for (const m of models.splice(0)) m.dispose();
    for (const r of repos.splice(0)) r.cleanup();
  });

  /** A repository where feature/a has been pushed to origin/feature/a (the remote is only a URL and nothing actually connects) */
  async function setup(opts: { url?: string; env?: Partial<HostEnv> } = {}) {
    const r = makeRepo();
    repos.push(r);
    const sha = r.commit('one');
    r.git(['remote', 'add', 'origin', opts.url ?? 'git@github.com:me/repo.git']);
    r.git(['branch', 'feature/a']);
    r.git(['update-ref', 'refs/remotes/origin/feature/a', sha]);
    r.git(['update-ref', 'refs/remotes/origin/claude/x', sha]);
    r.git(['branch', '--set-upstream-to=origin/feature/a', 'feature/a']);
    const m = await openModel(r.dir, testEnv(opts.env));
    models.push(m);
    return m;
  }

  it('matches PRs to local and remote branches and caches the result', async () => {
    const m = await setup();
    const f = fakeFetch(() => ({ body: [restItem({ number: 7, head: 'feature/a', state: 'closed', merged: true }), restItem({ number: 8, head: 'claude/x' })] }));
    m.pullRequests.fetchImpl = f.impl;
    const list = await m.pullRequests.list();
    expect(list.status).toBe('ok');
    expect(Object.fromEntries(Object.entries(list.byRef).map(([k, v]) => [k, `${v.number}:${v.state}`]))).toEqual({
      'refs/heads/feature/a': '7:merged',
      'refs/remotes/origin/feature/a': '7:merged',
      'refs/remotes/origin/claude/x': '8:open',
    });
    await m.pullRequests.list();
    expect(f.calls).toHaveLength(1);
    await m.pullRequests.list(true);
    expect(f.calls).toHaveLength(2);
    expect(m.pullRequests.last).toEqual(list);
  });

  it('uses the token from the host and GraphQL', async () => {
    const hosts: string[] = [];
    const m = await setup({
      env: {
        pullRequestCredential: async (_provider, host) => {
          hosts.push(host);
          return { token: 'tok' };
        },
      },
    });
    const f = fakeFetch(() => ({ body: { data: { repository: { h0: { nodes: [gqlNode({ number: 3, head: 'feature/a' })] } } } } }));
    m.pullRequests.fetchImpl = f.impl;
    const list = await m.pullRequests.list();
    expect(hosts).toEqual(['github.com']);
    expect(f.calls[0].body!.variables).toMatchObject({ owner: 'me', name: 'repo', h0: 'feature/a' });
    expect(list.byRef['refs/heads/feature/a']?.number).toBe(3);
  });

  it('does not return an older cached result while a forced reload is running', async () => {
    const m = await setup();
    let n = 0;
    const f = fakeFetch(() => ({ body: [restItem({ number: ++n, head: 'feature/a' })] }));
    m.pullRequests.fetchImpl = f.impl;
    await m.pullRequests.list();
    const [forced, plain] = await Promise.all([m.pullRequests.list(true), m.pullRequests.list()]);
    expect(forced.byRef['refs/heads/feature/a']?.number).toBe(2);
    expect(plain).toBe(forced);
  });

  it('asks to sign in when a private repository cannot be read, and keeps the previous PRs on errors', async () => {
    let status = 200;
    const m = await setup({ env: { pullRequestCredential: async () => undefined } });
    const f = fakeFetch(() => (status === 200 ? { body: [restItem({ number: 1, head: 'feature/a' })] } : { status }));
    m.pullRequests.fetchImpl = f.impl;
    await m.pullRequests.list();
    status = 404;
    const denied = await m.pullRequests.list(true);
    expect(denied.status).toBe('signIn');
    expect(denied.byRef['refs/heads/feature/a']?.number).toBe(1);
    status = 502;
    const failed = await m.pullRequests.list(true);
    expect(failed.status).toBe('error');
    expect(failed.message).toContain('502');
    expect(failed.byRef['refs/heads/feature/a']?.number).toBe(1);
  });

  it('reads Bitbucket Cloud with the saved API token, and asks for one for private repositories', async () => {
    const asked: string[] = [];
    let credential: { username: string; password: string } | undefined;
    const m = await setup({
      url: 'git@bitbucket.org:team/app.git',
      env: {
        pullRequestCredential: async (provider) => {
          asked.push(provider);
          return credential;
        },
      },
    });
    const f = fakeFetch((c) =>
      c.headers.Authorization ? { body: { values: [bbItem({ id: 4, head: 'feature/a', state: 'DECLINED' }), bbItem({ id: 9, head: 'claude/x' })] } } : { status: 404 },
    );
    m.pullRequests.fetchImpl = f.impl;
    const denied = await m.pullRequests.list();
    expect(denied).toMatchObject({ status: 'signIn', provider: 'bitbucket' });
    credential = { username: 'me@example.com', password: 'tok' };
    const list = await m.pullRequests.list(true);
    expect(asked).toEqual(['bitbucket', 'bitbucket']);
    expect(list.status).toBe('ok');
    expect(Object.fromEntries(Object.entries(list.byRef).map(([k, v]) => [k, `${v.number}:${v.state}:${v.closedAs ?? ''}`]))).toEqual({
      'refs/heads/feature/a': '4:closed:declined',
      'refs/remotes/origin/feature/a': '4:closed:declined',
      'refs/remotes/origin/claude/x': '9:open:',
    });
    // The recent PRs, and a query by the name of the local branch feature/a
    expect(f.calls.slice(1).map((c) => new URL(c.url).searchParams.get('q'))).toEqual([null, 'source.branch.name="feature/a"']);
  });

  it('reports an error instead of sign-in where the host cannot sign in', async () => {
    const m = await setup();
    m.pullRequests.fetchImpl = fakeFetch(() => ({ status: 404 })).impl;
    expect((await m.pullRequests.list()).status).toBe('error');
  });

  it('does nothing for other hosts or when turned off', async () => {
    const other = await setup({ url: 'git@gitlab.com:me/repo.git' });
    other.pullRequests.fetchImpl = () => Promise.reject(new Error('should not fetch'));
    expect(await other.pullRequests.list()).toEqual({ status: 'unsupported', byRef: {} });
    const off = await setup({ env: { config: () => ({ ...TEST_CONFIG, pullRequests: false }) } });
    off.pullRequests.fetchImpl = () => Promise.reject(new Error('should not fetch'));
    expect(await off.pullRequests.list()).toEqual({ status: 'disabled', byRef: {} });
  });
});
