// The parts of branch-linked pull requests that do not depend on the service (GitHub, Bitbucket):
// deciding which branches to look PRs up for, matching fetched PRs with branches, and HTTP requests and failure classification.
// Does not import vscode. Credentials come from the caller (HostEnv.pullRequestCredential), and fetch can be replaced (for tests).

import type { PullRequestInfo, PullRequestState, RefInfo, RemoteInfo } from '../../shared/protocol';
import { hostedRemotes, type HostedRepo } from './hosting';

/** Credentials passed to a service (a token for GitHub, an email address and API token for Bitbucket) */
export type PullRequestCredential = { token: string } | { username: string; password: string };

/** A branch to look a PR up for */
export interface PullRequestTarget {
  /** Full ref name (refs/heads/x, refs/remotes/origin/x) */
  ref: string;
  /** Repository where the PR's source branch lives (the fork, for a PR from a fork) */
  repo: HostedRepo;
  /** Branch name on the remote */
  headRef: string;
  /** Local branch (looked up individually by name) */
  local: boolean;
}

/**
 * The list of branches to look PRs up for. For a local branch, the upstream remote and branch name;
 * without an upstream, a remote branch with the same name (origin first) is taken as the PR's source.
 */
export function pullRequestTargets(refs: readonly RefInfo[], remotes: readonly RemoteInfo[]): PullRequestTarget[] {
  const hosted = hostedRemotes(remotes);
  if (hosted.size === 0) return [];
  // A remote name may contain slashes, so decide the upstream remote by longest match
  const names = remotes.map((r) => r.name).sort((a, b) => b.length - a.length);
  const remoteBranches = new Set(refs.filter((r) => r.kind === 'remote').map((r) => r.name));
  const out: PullRequestTarget[] = [];
  for (const ref of refs) {
    if (ref.kind === 'head') {
      let remote: string | undefined;
      let headRef: string | undefined;
      if (ref.upstream) {
        remote = names.find((n) => ref.upstream!.startsWith(`${n}/`));
        headRef = remote ? ref.upstream.slice(remote.length + 1) : undefined;
      } else {
        remote = [...hosted.keys()].find((n) => remoteBranches.has(`${n}/${ref.name}`));
        headRef = ref.name;
      }
      const repo = remote ? hosted.get(remote) : undefined;
      if (repo && headRef) out.push({ ref: ref.fullName, repo, headRef, local: true });
    } else if (ref.kind === 'remote' && ref.remote) {
      const repo = hosted.get(ref.remote);
      if (repo) out.push({ ref: ref.fullName, repo, headRef: ref.name.slice(ref.remote.length + 1), local: false });
    }
  }
  return out;
}

/** A fetched PR and the information used to match it with a branch */
export interface PullRequestCandidate extends PullRequestInfo {
  /** Host and owner of the repository where the PR's source branch lives (tells PRs from forks apart) */
  headHost: string;
  headOwner?: string;
}

export function candidate(host: string, base: Omit<PullRequestCandidate, 'headHost'>): PullRequestCandidate | undefined {
  // This URL is opened in a browser, so accept only https
  if (!Number.isInteger(base.number) || !/^https:\/\//i.test(base.url) || !base.headRef) return undefined;
  return { ...base, headHost: host };
}

/**
 * Pick one PR per branch. Among PRs with the same host, owner and branch name,
 * prefer one under review (open, draft), otherwise the most recently updated.
 */
export function matchPullRequests(targets: readonly PullRequestTarget[], candidates: readonly PullRequestCandidate[]): Record<string, PullRequestInfo> {
  const key = (host: string, owner: string, head: string) => `${host}\0${owner.toLowerCase()}\0${head}`;
  const groups = new Map<string, PullRequestCandidate[]>();
  for (const c of candidates) {
    if (!c.headOwner) continue;
    const k = key(c.headHost, c.headOwner, c.headRef);
    const list = groups.get(k) ?? [];
    if (!list.some((x) => x.url === c.url)) list.push(c);
    groups.set(k, list);
  }
  const active = (s: PullRequestState) => s === 'open' || s === 'draft';
  const out: Record<string, PullRequestInfo> = {};
  for (const t of targets) {
    const list = groups.get(key(t.repo.host, t.repo.owner, t.headRef));
    if (!list?.length) continue;
    const best = list.reduce((a, b) => {
      if (active(a.state) !== active(b.state)) return active(a.state) ? a : b;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
      return a.number >= b.number ? a : b;
    });
    const { headHost: _h, headOwner: _o, ...info } = best;
    out[t.ref] = info;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the response
// ---------------------------------------------------------------------------

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' ? (v as Json) : undefined);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function toUnix(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

/**
 * auth: authentication required, invalid credentials or insufficient permission / notFound: the repository is not visible (private and not signed in) /
 * rateLimit: rate limited / network: cannot connect / other: anything else
 */
export type PullRequestErrorKind = 'auth' | 'notFound' | 'rateLimit' | 'network' | 'other';

export class PullRequestError extends Error {
  constructor(
    readonly kind: PullRequestErrorKind,
    message: string,
    /** HTTP status code */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PullRequestError';
  }
}

/** Call a JSON API. service is the service name shown in the failure message */
export async function requestJson(
  fetchImpl: FetchLike,
  service: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  const h: Record<string, string> = { 'User-Agent': 'Twigline', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res: FetchResponse;
  try {
    res = await fetchImpl(url, { method: body !== undefined ? 'POST' : 'GET', headers: h, body, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
    throw new PullRequestError('network', `${e instanceof Error ? e.message : String(e)}${cause}`);
  }
  if (res.status === 401) throw new PullRequestError('auth', `${service} rejected the credentials (401).`, 401);
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    throw new PullRequestError('rateLimit', `${service} API rate limit exceeded.`, res.status);
  }
  if (res.status === 403) throw new PullRequestError('auth', `${service} denied access (403).`, 403);
  if (res.status === 404) throw new PullRequestError('notFound', `The repository was not found on ${service}, or it is private.`, 404);
  if (!res.ok) throw new PullRequestError('other', `${service} returned HTTP ${res.status}.`, res.status);
  try {
    return await res.json();
  } catch {
    throw new PullRequestError('other', `${service} returned a response that is not JSON.`);
  }
}
