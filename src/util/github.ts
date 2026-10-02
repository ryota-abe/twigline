// Reads the pull requests linked to branches from GitHub (including GitHub Enterprise Server).
//
// One query per repository (split only when there are many local branches):
// - When signed in: read the 100 most recently updated PRs and the PRs per local branch name together with GraphQL.
//   Branches that exist only on the remote are looked for in the recent 100; for local branches, old PRs and PRs of branches deleted on the remote are also looked for
// - When not signed in: read only the 100 most recently updated PRs with REST (public repositories only, up to 60 requests per hour)
//   In environments where GraphQL is refused (403) even when signed in, read the same 100 with REST using the token

import type { PullRequestState } from '../../shared/protocol';
import type { HostedRepo } from './hosting';
import {
  PullRequestError,
  candidate,
  obj,
  requestJson,
  str,
  toUnix,
  type FetchLike,
  type PullRequestCandidate,
  type PullRequestCredential,
} from './pullRequests';

/** Number of local branches looked up by name in one GraphQL query */
export const HEADS_PER_QUERY = 50;
/** Upper limit of local branches looked up by name (per repository) */
export const MAX_LOCAL_HEADS = 200;
const RECENT = 100;

const PR_FIELDS = 'number title url state isDraft headRefName headRefOid baseRefName updatedAt headRepositoryOwner { login } author { login }';

/** GraphQL query. Branch names are passed as variables (not embedded in the string) */
export function buildPullRequestQuery(heads: readonly string[], recent: boolean): { query: string; variables: Record<string, string> } {
  const params = ['$owner: String!', '$name: String!', ...heads.map((_, i) => `$h${i}: String!`)];
  const order = 'orderBy: { field: UPDATED_AT, direction: DESC }';
  const fields = heads.map((_, i) => `h${i}: pullRequests(headRefName: $h${i}, first: 5, ${order}) { nodes { ...pr } }`);
  if (recent) fields.unshift(`recent: pullRequests(first: ${RECENT}, ${order}) { nodes { ...pr } }`);
  const variables: Record<string, string> = {};
  heads.forEach((h, i) => (variables[`h${i}`] = h));
  return {
    query: `query(${params.join(', ')}) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } } fragment pr on PullRequest { ${PR_FIELDS} }`,
    variables,
  };
}

const login = (v: unknown): string | undefined => str(obj(v)?.login);

/** Flatten the GraphQL repository { <alias>: pullRequests { nodes } ... } */
export function parseGraphQLPullRequests(host: string, repository: unknown): PullRequestCandidate[] {
  const out: PullRequestCandidate[] = [];
  for (const conn of Object.values(obj(repository) ?? {})) {
    const nodes = obj(conn)?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const raw of nodes) {
      const n = obj(raw);
      if (!n) continue;
      const state: PullRequestState = n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'closed' : n.isDraft === true ? 'draft' : 'open';
      const c = candidate(host, {
        number: typeof n.number === 'number' ? n.number : NaN,
        title: str(n.title) ?? '',
        url: str(n.url) ?? '',
        state,
        headRef: str(n.headRefName) ?? '',
        baseRef: str(n.baseRefName) ?? '',
        headSha: str(n.headRefOid),
        author: login(n.author),
        updatedAt: toUnix(n.updatedAt),
        headOwner: login(n.headRepositoryOwner),
      });
      if (c) out.push(c);
    }
  }
  return out;
}

/** Response of REST GET /repos/{owner}/{repo}/pulls */
export function parseRestPullRequests(host: string, list: unknown): PullRequestCandidate[] {
  if (!Array.isArray(list)) return [];
  const out: PullRequestCandidate[] = [];
  for (const raw of list) {
    const p = obj(raw);
    if (!p) continue;
    const head = obj(p.head);
    const state: PullRequestState = p.merged_at ? 'merged' : p.state === 'open' ? (p.draft === true ? 'draft' : 'open') : 'closed';
    const c = candidate(host, {
      number: typeof p.number === 'number' ? p.number : NaN,
      title: str(p.title) ?? '',
      url: str(p.html_url) ?? '',
      state,
      headRef: str(head?.ref) ?? '',
      baseRef: str(obj(p.base)?.ref) ?? '',
      headSha: str(head?.sha),
      author: login(p.user),
      updatedAt: toUnix(p.updated_at),
      // For a fork whose original repository was deleted, repo is null, so fill in from the owner of head
      headOwner: login(obj(head?.repo)?.owner) ?? login(head?.user),
    });
    if (c) out.push(c);
  }
  return out;
}

export function apiUrl(host: string, path: string): string {
  return host === 'github.com' ? `https://api.github.com${path}` : `https://${host}/api/v3${path}`;
}

export function graphqlUrl(host: string): string {
  return host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
}

function headers(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Read the PRs filed against a repo. With a token, read the recent PRs and the PRs of the names in localHeads with GraphQL;
 * without one, read only the recent PRs with REST.
 */
export async function fetchGitHubPullRequests(
  repo: HostedRepo,
  localHeads: readonly string[],
  credential: PullRequestCredential | undefined,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<PullRequestCandidate[]> {
  const token = credential && 'token' in credential ? credential.token : undefined;
  const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const recentOverRest = async () =>
    parseRestPullRequests(
      repo.host,
      await requestJson(fetchImpl, 'GitHub', apiUrl(repo.host, `${path}/pulls?state=all&sort=updated&direction=desc&per_page=${RECENT}`), headers(token), undefined, signal),
    );
  if (!token) return recentOverRest();
  try {
    return await fetchOverGraphQL(repo, localHeads, token, fetchImpl, signal);
  } catch (e) {
    if (e instanceof PullRequestError && e.status === 403 && e.kind === 'auth') return recentOverRest();
    throw e;
  }
}

async function fetchOverGraphQL(repo: HostedRepo, localHeads: readonly string[], token: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<PullRequestCandidate[]> {
  const heads = [...new Set(localHeads)].slice(0, MAX_LOCAL_HEADS);
  const out: PullRequestCandidate[] = [];
  for (let i = 0; i === 0 || i < heads.length; i += HEADS_PER_QUERY) {
    const { query, variables } = buildPullRequestQuery(heads.slice(i, i + HEADS_PER_QUERY), i === 0);
    const body = JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name, ...variables } });
    const json = obj(await requestJson(fetchImpl, 'GitHub', graphqlUrl(repo.host), headers(token), body, signal));
    const repository = obj(obj(json?.data)?.repository);
    if (!repository) {
      const errors = Array.isArray(json?.errors) ? json.errors.map(obj) : [];
      const type = str(errors[0]?.type);
      const message = str(errors[0]?.message) ?? 'GitHub returned no data.';
      if (type === 'NOT_FOUND') throw new PullRequestError('notFound', message);
      if (type === 'FORBIDDEN') throw new PullRequestError('auth', message);
      if (type === 'RATE_LIMITED') throw new PullRequestError('rateLimit', message);
      throw new PullRequestError('other', message);
    }
    out.push(...parseGraphQLPullRequests(repo.host, repository));
  }
  return out;
}
