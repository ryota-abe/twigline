// Reads the pull requests linked to branches from Bitbucket Cloud (bitbucket.org). Bitbucket Data Center (self-hosted) has a different API and is not supported.
//
// Uses GET /repositories/{workspace}/{repo}/pullrequests of REST API 2.0:
// - The 50 most recently updated PRs (the limit of one page). Branches that exist only on the remote are looked for here
// - With credentials (an Atlassian email address and API token), local branches are also looked up by name.
//   A BBQL query, q=source.branch.name="a" OR source.branch.name="b", can look up several branches at once
// Public repositories can be read without authentication (up to 60 requests per hour). Private repositories give 404 without it.

import type { PullRequestState } from '../../shared/protocol';
import type { HostedRepo } from './hosting';
import { candidate, obj, requestJson, str, toUnix, type FetchLike, type PullRequestCandidate, type PullRequestCredential } from './pullRequests';

const API = 'https://api.bitbucket.org/2.0';
/** Number of local branches looked up by name in one query (keeps the URL short) */
export const BRANCHES_PER_QUERY = 20;
/** Upper limit of local branches looked up by name (per repository) */
export const MAX_LOCAL_HEADS = 200;
/** Items per page (the Bitbucket limit) */
const PAGE = 50;

/** Only OPEN is returned by default, so specify all states */
const STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];
const FIELDS = [
  'id',
  'title',
  'state',
  'draft',
  'updated_on',
  'links.html.href',
  'source.branch.name',
  'source.repository.full_name',
  'destination.branch.name',
  'author.display_name',
]
  .map((f) => `values.${f}`)
  .join(',');

/** BBQL that filters by branch name. The branch name is quoted as a string, escaping " and \ */
export function branchQuery(heads: readonly string[]): string {
  return heads.map((h) => `source.branch.name="${h.replace(/["\\]/g, '\\$&')}"`).join(' OR ');
}

export function pullRequestsUrl(repo: HostedRepo, q?: string): string {
  const params: [string, string][] = [...STATES.map((s): [string, string] => ['state', s]), ['sort', '-updated_on'], ['pagelen', String(PAGE)], ['fields', FIELDS]];
  if (q) params.push(['q', q]);
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${API}/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pullrequests?${query}`;
}

/** Response of GET .../pullrequests ({ values: [...] }) */
export function parseBitbucketPullRequests(page: unknown): PullRequestCandidate[] {
  const values = obj(page)?.values;
  if (!Array.isArray(values)) return [];
  const out: PullRequestCandidate[] = [];
  for (const raw of values) {
    const p = obj(raw);
    if (!p) continue;
    const source = obj(p.source);
    let state: PullRequestState = 'open';
    let closedAs: 'declined' | 'superseded' | undefined;
    if (p.state === 'MERGED') state = 'merged';
    else if (p.state === 'DECLINED' || p.state === 'SUPERSEDED') {
      state = 'closed';
      closedAs = p.state === 'DECLINED' ? 'declined' : 'superseded';
    } else if (p.draft === true) state = 'draft';
    // A PR whose fork was deleted has a null source.repository and the owner is unknown, so it is not matched
    const fullName = str(obj(source?.repository)?.full_name);
    const c = candidate('bitbucket.org', {
      number: typeof p.id === 'number' ? p.id : NaN,
      title: str(p.title) ?? '',
      url: str(obj(obj(p.links)?.html)?.href) ?? '',
      state,
      ...(closedAs ? { closedAs } : {}),
      headRef: str(obj(source?.branch)?.name) ?? '',
      baseRef: str(obj(obj(p.destination)?.branch)?.name) ?? '',
      // source.commit.hash is a 12-digit abbreviation, so do not include it
      author: str(obj(p.author)?.display_name),
      updatedAt: toUnix(p.updated_on),
      headOwner: fullName?.split('/')[0] || undefined,
    });
    if (c) out.push(c);
  }
  return out;
}

/** Read the PRs filed against a repo. With credentials, besides recent PRs, also read the PRs of the names in localHeads */
export async function fetchBitbucketPullRequests(
  repo: HostedRepo,
  localHeads: readonly string[],
  credential: PullRequestCredential | undefined,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<PullRequestCandidate[]> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const basic = credential && 'username' in credential ? credential : undefined;
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic.username}:${basic.password}`, 'utf8').toString('base64')}`;
  const get = async (q?: string) => parseBitbucketPullRequests(await requestJson(fetchImpl, 'Bitbucket', pullRequestsUrl(repo, q), headers, undefined, signal));
  const out = await get();
  // Without authentication the limit is 60 requests per hour, so read only recent PRs
  if (!basic) return out;
  const heads = [...new Set(localHeads)].slice(0, MAX_LOCAL_HEADS);
  for (let i = 0; i < heads.length; i += BRANCHES_PER_QUERY) out.push(...(await get(branchQuery(heads.slice(i, i + BRANCHES_PER_QUERY)))));
  return out;
}
