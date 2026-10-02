import type { PullRequestList, PullRequestProvider } from '../../shared/protocol';
import type { RepoModel } from '../repo/RepoModel';
import { fetchBitbucketPullRequests } from '../util/bitbucket';
import { fetchGitHubPullRequests } from '../util/github';
import { hostedRemotes, repoKey, type HostedRepo } from '../util/hosting';
import {
  PullRequestError,
  matchPullRequests,
  pullRequestTargets,
  type FetchLike,
  type PullRequestCandidate,
  type PullRequestCredential,
  type PullRequestTarget,
} from '../util/pullRequests';

/** Time before re-fetching (longer without authentication because of the 60-requests-per-hour limit) */
const TTL_SIGNED_IN = 30_000;
const TTL_ANONYMOUS = 120_000;
const TTL_FAILED = 60_000;
const TIMEOUT = 20_000;

const FETCHERS = { github: fetchGitHubPullRequests, bitbucket: fetchBitbucketPullRequests };

/**
 * Pull requests linked to branches (GitHub, Bitbucket Cloud). Reads the PRs per remote and matches them with local and remote branches.
 * Results are cached for a short time and re-fetched when the combination of branches changes or on force.
 * The previous result is kept even if fetching fails (it is also used for the open-PR action).
 */
export class PullRequestService {
  /** Replaced in tests */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  private cache?: { key: string; at: number; ttl: number; value: PullRequestList };
  private inflight?: { key: string; promise: Promise<PullRequestList> };

  constructor(private readonly repo: RepoModel) {}

  /** The most recently fetched result */
  get last(): PullRequestList | undefined {
    return this.cache?.value;
  }

  /** Re-fetch on the next list (the previous result is kept) */
  invalidate(): void {
    if (this.cache) this.cache.at = 0;
  }

  async list(force = false): Promise<PullRequestList> {
    if (!this.repo.env.config().pullRequests) return { status: 'disabled', byRef: {} };
    const snap = await this.repo.snapshot.get();
    const repos = uniqueRepos([...hostedRemotes(snap.remotes).values()]);
    if (repos.length === 0) return { status: 'unsupported', byRef: {} };
    const targets = pullRequestTargets(snap.refs, snap.remotes);
    const key = JSON.stringify([repos.map(repoKey), targets.map((t) => [t.ref, repoKey(t.repo), t.headRef])]);
    // A fetch in flight is newer than the cache (so a request that arrives during a forced fetch is not given a stale result)
    if (this.inflight?.key === key) return this.inflight.promise;
    const c = this.cache;
    if (!force && c && c.key === key && Date.now() - c.at < c.ttl) return c.value;

    const promise = this.load(repos, targets).then(
      ({ value, ttl }) => {
        this.cache = { key, at: Date.now(), ttl, value };
        return value;
      },
      (e: unknown) => {
        const value: PullRequestList = { status: 'error', message: e instanceof Error ? e.message : String(e), byRef: this.cache?.value.byRef ?? {} };
        this.cache = { key, at: Date.now(), ttl: TTL_FAILED, value };
        return value;
      },
    );
    this.inflight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.inflight?.promise === promise) this.inflight = undefined;
    }
  }

  private async load(repos: HostedRepo[], targets: PullRequestTarget[]): Promise<{ value: PullRequestList; ttl: number }> {
    const env = this.repo.env;
    const credentials = new Map<string, PullRequestCredential | undefined>();
    const service = (r: { provider: PullRequestProvider; host: string }) => `${r.provider}:${r.host}`;
    for (const r of repos) {
      if (credentials.has(service(r))) continue;
      credentials.set(service(r), await env.pullRequestCredential?.(r.provider, r.host, { interactive: false }).catch(() => undefined));
    }
    const candidates: PullRequestCandidate[] = [];
    const failures: { error: PullRequestError; signedIn: boolean; provider: PullRequestProvider }[] = [];
    await Promise.all(
      repos.map(async (r) => {
        const credential = credentials.get(service(r));
        // Even when the PR's source is another repository (a fork), check local branches of the same service by name
        const heads = targets.filter((t) => t.local && service(t.repo) === service(r)).map((t) => t.headRef);
        try {
          candidates.push(...(await FETCHERS[r.provider](r, heads, credential, this.fetchImpl, AbortSignal.timeout(TIMEOUT))));
        } catch (e) {
          const error = e instanceof PullRequestError ? e : new PullRequestError('network', e instanceof Error ? e.message : String(e));
          failures.push({ error, signedIn: !!credential, provider: r.provider });
        }
      }),
    );
    const signedIn = [...credentials.values()].some(Boolean);
    const previous = this.cache?.value.byRef ?? {};
    // If other remotes (such as upstream) could be read, skip the ones that could not
    if (failures.length > 0 && failures.length === repos.length) {
      const { error, signedIn: withCredential, provider } = failures[0];
      // Signing in makes it readable (private repository, unauthenticated rate limit, invalidated credentials)
      const needsSignIn = !!env.pullRequestCredential && (withCredential ? error.kind === 'auth' : error.kind !== 'network' && error.kind !== 'other');
      return {
        value: { status: needsSignIn ? 'signIn' : 'error', provider, message: error.message, byRef: previous },
        ttl: needsSignIn ? TTL_ANONYMOUS : TTL_FAILED,
      };
    }
    return { value: { status: 'ok', byRef: matchPullRequests(targets, candidates) }, ttl: signedIn ? TTL_SIGNED_IN : TTL_ANONYMOUS };
  }
}

function uniqueRepos(list: HostedRepo[]): HostedRepo[] {
  const seen = new Map<string, HostedRepo>();
  for (const r of list) if (!seen.has(repoKey(r))) seen.set(repoKey(r), r);
  return [...seen.values()];
}
