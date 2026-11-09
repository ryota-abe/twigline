// Decides the repository on a hosting service from a remote URL.
// It gives the URL of the pull request creation page (opening GitHub, GitLab, Bitbucket and Azure DevOps URLs) and
// the repository to read PRs linked to branches from (GitHub, GitLab, Bitbucket Cloud).

import type { PullRequestProvider } from '../../shared/protocol';

export interface RepoLocation {
  host: string;
  /** owner/repo (org/project/_git/repo for Azure DevOps) */
  path: string;
}

/** Extract the host and path from a remote URL (https, ssh or scp form) */
export function parseRemoteUrl(url: string): RepoLocation | undefined {
  const u = url.trim();
  let host: string;
  let p: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      host = parsed.hostname;
      p = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
  } else if (scp) {
    host = scp[1];
    p = scp[2];
  } else {
    return undefined;
  }
  p = p.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (host === 'ssh.dev.azure.com') {
    // v3/org/project/repo → org/project/_git/repo
    const m = /^v3\/([^/]+)\/([^/]+)\/(.+)$/.exec(p);
    if (m) return { host: 'dev.azure.com', path: `${m[1]}/${m[2]}/_git/${m[3]}` };
  }
  if (/\.visualstudio\.com$/.test(host)) {
    const org = host.split('.')[0];
    return { host: 'dev.azure.com', path: `${org}/${p.replace(/^DefaultCollection\//, '')}` };
  }
  return { host, path: p };
}

/** A repository PRs can be read from */
export interface HostedRepo {
  provider: PullRequestProvider;
  /** Host name of github.com, GitHub Enterprise Server, gitlab.com, self-managed GitLab, or bitbucket.org (lowercase) */
  host: string;
  /** GitHub owner, GitLab namespace (group/subgroup) or Bitbucket workspace */
  owner: string;
  name: string;
}

/**
 * The location if the remote URL is a GitHub, GitLab or Bitbucket Cloud repository (Bitbucket Data Center is not supported).
 * Self-managed GitLab is told by a host name that starts with gitlab. (like GitHub Enterprise Server by github.)
 */
export function hostedRepoOf(url: string | undefined): HostedRepo | undefined {
  if (!url) return undefined;
  const loc = parseRemoteUrl(url);
  if (!loc) return undefined;
  const parts = loc.path.split('/');
  if (parts.length < 2 || parts.some((p) => !p)) return undefined;
  const host = loc.host.toLowerCase();
  // GitLab projects can be in nested groups (group/subgroup/project). altssh.gitlab.com is the host used to connect SSH over port 443
  const gitlab = host === 'gitlab.com' || host === 'www.gitlab.com' || host === 'altssh.gitlab.com' ? 'gitlab.com' : host.startsWith('gitlab.') ? host : undefined;
  if (gitlab) return { provider: 'gitlab', host: gitlab, owner: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts;
  // ssh.github.com and altssh.bitbucket.org are the hosts used to connect SSH over port 443
  if (host === 'github.com' || host === 'www.github.com' || host === 'ssh.github.com') return { provider: 'github', host: 'github.com', owner, name };
  if (host.startsWith('github.')) return { provider: 'github', host, owner, name };
  if (host === 'bitbucket.org' || host === 'www.bitbucket.org' || host === 'altssh.bitbucket.org') return { provider: 'bitbucket', host: 'bitbucket.org', owner, name };
  return undefined;
}

export function repoKey(r: HostedRepo): string {
  return `${r.provider}:${r.host}/${r.owner}/${r.name}`.toLowerCase();
}

/** Remotes PRs can be read from (name -> repository). Keeps the order of remotes (origin first) */
export function hostedRemotes(remotes: readonly { name: string; fetchUrl?: string; pushUrl?: string }[]): Map<string, HostedRepo> {
  const map = new Map<string, HostedRepo>();
  for (const r of remotes) {
    const repo = hostedRepoOf(r.fetchUrl ?? r.pushUrl);
    if (repo) map.set(r.name, repo);
  }
  return map;
}

export function pullRequestUrl(remoteUrl: string, branch: string): string | undefined {
  const loc = parseRemoteUrl(remoteUrl);
  if (!loc) return undefined;
  const b = encodeURIComponent(branch);
  const { host, path } = loc;
  if (host === 'github.com' || host.startsWith('github.')) return `https://${host}/${path}/compare/${encodeURIComponent(branch).replace(/%2F/g, '/')}?expand=1`;
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return `https://${host}/${path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${b}`;
  if (host === 'bitbucket.org') return `https://${host}/${path}/pull-requests/new?source=${b}`;
  if (host === 'dev.azure.com') return `https://${host}/${path}/pullrequestcreate?sourceRef=${b}`;
  return undefined;
}
