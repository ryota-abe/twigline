// Reads the merge requests linked to branches from GitLab (gitlab.com and self-managed GitLab on a gitlab.* host).
//
// Uses the GraphQL API (POST /api/graphql), one query per repository (split only when there are many local branches):
// - The 100 most recently updated merge requests. Branches that exist only on the remote are looked for here
// - The merge requests of the local branches by name (sourceBranches takes a list), so old merge requests and those of
//   branches deleted on the remote are also found. GitLab does not limit unauthenticated requests as tightly as GitHub and Bitbucket,
//   so this is done without a token too
// Public projects can be read without a token. A private project (or one that does not exist) gives project: null without one.
// With a personal access token (read_api scope) it is sent as a Bearer token.

import type { PullRequestState } from '../../shared/protocol';
import type { HostedRepo } from './hosting';
import { PullRequestError, candidate, obj, requestJson, str, toUnix, type FetchLike, type PullRequestCandidate, type PullRequestCredential } from './pullRequests';

/** Number of local branches looked up by name in one query */
export const HEADS_PER_QUERY = 50;
/** Upper limit of local branches looked up by name (per repository) */
export const MAX_LOCAL_HEADS = 200;
/** Merge requests per connection (the GitLab limit of one page) */
const PAGE = 100;

const MR_FIELDS = 'iid title webUrl state draft sourceBranch targetBranch diffHeadSha updatedAt author { username } sourceProject { fullPath }';

/** GraphQL query. Branch names are passed as a variable (not embedded in the string) */
export function buildMergeRequestQuery(heads: readonly string[], recent: boolean): { query: string; variables: Record<string, unknown> } {
  const params = ['$fullPath: ID!'];
  const fields: string[] = [];
  const variables: Record<string, unknown> = {};
  if (recent) fields.push(`recent: mergeRequests(first: ${PAGE}, sort: UPDATED_DESC) { nodes { ...mr } }`);
  if (heads.length > 0) {
    params.push('$heads: [String!]');
    fields.push(`heads: mergeRequests(sourceBranches: $heads, first: ${PAGE}, sort: UPDATED_DESC) { nodes { ...mr } }`);
    variables.heads = [...heads];
  }
  return {
    query: `query(${params.join(', ')}) { project(fullPath: $fullPath) { ${fields.join(' ')} } } fragment mr on MergeRequest { ${MR_FIELDS} }`,
    variables,
  };
}

/** Flatten the GraphQL project { <alias>: mergeRequests { nodes } ... } */
export function parseGitLabMergeRequests(host: string, project: unknown): PullRequestCandidate[] {
  const out: PullRequestCandidate[] = [];
  for (const conn of Object.values(obj(project) ?? {})) {
    const nodes = obj(conn)?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const raw of nodes) {
      const n = obj(raw);
      if (!n) continue;
      // locked is a short-lived state while a merge request is being merged, so it is still under review
      const state: PullRequestState = n.state === 'merged' ? 'merged' : n.state === 'closed' ? 'closed' : n.draft === true ? 'draft' : 'open';
      // The namespace of the project the source branch lives in (a fork's for a merge request from a fork).
      // It is null when the fork was deleted or cannot be seen, and then the owner is unknown and it is not matched
      const sourcePath = str(obj(n.sourceProject)?.fullPath);
      const slash = sourcePath?.lastIndexOf('/') ?? -1;
      const c = candidate(host, {
        // iid is a string in GraphQL
        number: typeof n.iid === 'string' && /^\d+$/.test(n.iid) ? Number(n.iid) : typeof n.iid === 'number' ? n.iid : NaN,
        title: str(n.title) ?? '',
        url: str(n.webUrl) ?? '',
        state,
        headRef: str(n.sourceBranch) ?? '',
        baseRef: str(n.targetBranch) ?? '',
        headSha: str(n.diffHeadSha),
        author: str(obj(n.author)?.username),
        updatedAt: toUnix(n.updatedAt),
        headOwner: slash > 0 ? sourcePath!.slice(0, slash) : undefined,
        mergeRequest: true,
      });
      if (c) out.push(c);
    }
  }
  return out;
}

export function graphqlUrl(host: string): string {
  return `https://${host}/api/graphql`;
}

/** Read the merge requests filed against a repo: the recent ones and those of the names in localHeads */
export async function fetchGitLabMergeRequests(
  repo: HostedRepo,
  localHeads: readonly string[],
  credential: PullRequestCredential | undefined,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<PullRequestCandidate[]> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = credential && 'token' in credential ? credential.token : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  const heads = [...new Set(localHeads)].slice(0, MAX_LOCAL_HEADS);
  const out: PullRequestCandidate[] = [];
  for (let i = 0; i === 0 || i < heads.length; i += HEADS_PER_QUERY) {
    const { query, variables } = buildMergeRequestQuery(heads.slice(i, i + HEADS_PER_QUERY), i === 0);
    const body = JSON.stringify({ query, variables: { fullPath: `${repo.owner}/${repo.name}`, ...variables } });
    const json = obj(await requestJson(fetchImpl, 'GitLab', graphqlUrl(repo.host), headers, body, signal));
    const data = obj(json?.data);
    const project = obj(data?.project);
    if (!project) {
      const errors = Array.isArray(json?.errors) ? json.errors.map(obj) : [];
      // A project that is private (without a token or access) or does not exist is null without an error
      if (data && 'project' in data && errors.length === 0) throw new PullRequestError('notFound', 'The project was not found on GitLab, or it is private.');
      throw new PullRequestError('other', str(errors[0]?.message) ?? 'GitLab returned no data.');
    }
    out.push(...parseGitLabMergeRequests(repo.host, project));
  }
  return out;
}
