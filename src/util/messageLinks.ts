// Links in a commit message: URLs, the issue trackers the user sets (twigline.issueLinks.trackers: Jira, Backlog, ...),
// and references to issues and pull requests by the conventions of the hosting service of the remote (twigline.issueLinks.builtIn).
// Only builds URLs; nothing is read from the services.

import type { IssueLinkSettings, IssueTrackerSetting, IssueTrackerType, MessageLink, RemoteInfo } from '../../shared/protocol';
import { parseRemoteUrl } from './hosting';

/** Where `#123` and the like point to, decided from a remote URL */
export type RemoteTracker =
  | { kind: 'github' | 'gitlab' | 'bitbucket'; /** https://host */ base: string; /** owner/repo (GitLab: group/subgroup/project) */ path: string }
  | { kind: 'azure'; base: string; org: string; project: string; repo: string };

/** Only the first part of a long message is scanned, and only so many links are made (a user's pattern could be slow) */
const MAX_SCAN = 20_000;
const MAX_LINKS = 200;

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function remoteTrackerOf(url: string | undefined): RemoteTracker | undefined {
  if (!url) return undefined;
  const loc = parseRemoteUrl(url);
  if (!loc) return undefined;
  const host = loc.host.toLowerCase();
  const parts = loc.path.split('/').filter(Boolean);
  if (host === 'dev.azure.com') {
    // org/project/_git/repo
    if (parts.length !== 4 || parts[2] !== '_git') return undefined;
    return { kind: 'azure', base: 'https://dev.azure.com', org: parts[0], project: parts[1], repo: parts[3] };
  }
  // ssh.github.com and altssh.bitbucket.org are the hosts used to connect SSH over port 443
  if (host === 'github.com' || host === 'www.github.com' || host === 'ssh.github.com' || host.startsWith('github.')) {
    if (parts.length !== 2) return undefined;
    const web = host.startsWith('github.') ? host : 'github.com';
    return { kind: 'github', base: `https://${web}`, path: parts.join('/') };
  }
  if (host === 'bitbucket.org' || host === 'www.bitbucket.org' || host === 'altssh.bitbucket.org') {
    if (parts.length !== 2) return undefined;
    return { kind: 'bitbucket', base: 'https://bitbucket.org', path: parts.join('/') };
  }
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) {
    if (parts.length < 2) return undefined;
    return { kind: 'gitlab', base: `https://${host}`, path: parts.join('/') };
  }
  return undefined;
}

/**
 * The tracker of the repository: `upstream` first (in a fork, the issues are usually there), then `origin`, then the other remotes in order.
 * Remotes whose service is not known are skipped.
 */
export function remoteTrackerOfRemotes(remotes: readonly RemoteInfo[]): { remote: string; tracker: RemoteTracker } | undefined {
  const rank = (name: string) => (name === 'upstream' ? 0 : name === 'origin' ? 1 : 2);
  const ordered = [...remotes].sort((a, b) => rank(a.name) - rank(b.name));
  for (const r of ordered) {
    const tracker = remoteTrackerOf(r.fetchUrl ?? r.pushUrl);
    if (tracker) return { remote: r.name, tracker };
  }
  return undefined;
}

interface Rule {
  re: RegExp;
  url: (m: RegExpExecArray) => string | undefined;
}

// A reference starts after a space, punctuation or a non-ASCII character (so `修正#12` and `（#12）` are links),
// but not inside a word, a path, a URL fragment or an HTML entity (`a#1`, `x/#1`, `&#123;`), and does not run into a word (`#12abc`)
const B = '(?<![A-Za-z0-9_&/#!@.\\-])';
const E = '(?![A-Za-z0-9_])';

/** Built-in rules of each service. Only ASCII digits: full-width `＃１２` is not a link on the services either */
export function builtInRules(tracker: RemoteTracker): Rule[] {
  const rx = (source: string, flags = 'g') => new RegExp(source, flags);
  switch (tracker.kind) {
    case 'github': {
      const repo = `${tracker.base}/${encodePath(tracker.path)}`;
      return [
        // GitHub's merge commit; any other `#123` opens /issues/123, which GitHub forwards to the pull request when the number is one
        { re: rx(`(?<=^Merge pull request )#([0-9]+)${E}`, 'gm'), url: (m) => `${repo}/pull/${m[1]}` },
        { re: rx(`${B}([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)#([0-9]+)${E}`), url: (m) => `${tracker.base}/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}/issues/${m[3]}` },
        { re: rx(`${B}GH-([0-9]+)${E}`), url: (m) => `${repo}/issues/${m[1]}` },
        { re: rx(`${B}#([0-9]+)${E}`), url: (m) => `${repo}/issues/${m[1]}` },
      ];
    }
    case 'gitlab': {
      // Issues (#) and merge requests (!) are numbered separately
      const page = (kind: string) => (kind === '!' ? 'merge_requests' : 'issues');
      return [
        // Another project, as in GitLab's merge commit ("See merge request group/project!12")
        { re: rx(`${B}((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+)([#!])([0-9]+)${E}`), url: (m) => `${tracker.base}/${encodePath(m[1])}/-/${page(m[2])}/${m[3]}` },
        { re: rx(`${B}([#!])([0-9]+)${E}`), url: (m) => `${tracker.base}/${encodePath(tracker.path)}/-/${page(m[1])}/${m[2]}` },
      ];
    }
    case 'bitbucket': {
      // Issues and pull requests are numbered separately. Bitbucket's merge commit says "(pull request #12)"
      const repo = `${tracker.base}/${encodePath(tracker.path)}`;
      return [
        { re: rx(`(?<=\\bpull request )#([0-9]+)${E}`, 'gi'), url: (m) => `${repo}/pull-requests/${m[1]}` },
        { re: rx(`${B}#([0-9]+)${E}`), url: (m) => `${repo}/issues/${m[1]}` },
      ];
    }
    case 'azure': {
      // `#123` is a work item (numbered across the organization), `!123` a pull request; Azure Repos' merge commit starts with "Merged PR 123:"
      const project = `${tracker.base}/${encodeURIComponent(tracker.org)}/${encodeURIComponent(tracker.project)}`;
      const pr = (n: string) => `${project}/_git/${encodeURIComponent(tracker.repo)}/pullrequest/${n}`;
      return [
        { re: rx(`(?<=^Merged )PR ([0-9]+)${E}`, 'gm'), url: (m) => pr(m[1]) },
        { re: rx(`${B}!([0-9]+)${E}`), url: (m) => pr(m[1]) },
        { re: rx(`${B}#([0-9]+)${E}`), url: (m) => `${project}/_workitems/edit/${m[1]}` },
      ];
    }
  }
}

/** http(s) URLs written in the message. Trailing punctuation and an unbalanced closing parenthesis are not part of the URL */
const URL_RULE: Rule = {
  re: /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g,
  url: (m) => m[0],
};

function trimUrl(text: string): string {
  let s = text;
  for (;;) {
    const last = s.at(-1);
    if (last && '.,:;!?\'*'.includes(last)) s = s.slice(0, -1);
    else if (last === ')' && count(s, '(') < count(s, ')')) s = s.slice(0, -1);
    else if (last === ']' && count(s, '[') < count(s, ']')) s = s.slice(0, -1);
    else return s;
  }
}

const count = (s: string, c: string) => s.split(c).length - 1;

/** A URL that may be opened: http or https only (no command:, file:, javascript: and the like). Returns it normalized */
export function safeUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const TRACKER_TYPES: readonly IssueTrackerType[] = ['jira', 'backlog', 'redmine', 'youtrack', 'linear', 'azureBoards', 'github', 'custom'];

/** Keys of Jira, Backlog, YouTrack and Linear: an upper-case letter, then upper-case letters, digits or _ */
const KEY = /^[A-Z][A-Z0-9_]*$/;
/** Any key, when none is given (two characters or more, like Jira) */
const ANY_KEY = '[A-Z][A-Z0-9_]+';
// A key reference does not start inside a word, a path, a branch name or a URL fragment (`xPROJ-1`, `feature/PROJ-1`, `#PROJ-1`)
const KB = '(?<![A-Za-z0-9_&/#!@.\\-])';

/** The well-formed entries of twigline.issueLinks.trackers (keys upper-cased, unknown keys and fields dropped) */
export function issueTrackerSettings(value: unknown): IssueTrackerSetting[] {
  if (!Array.isArray(value)) return [];
  const out: IssueTrackerSetting[] = [];
  for (const v of value as unknown[]) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (!TRACKER_TYPES.includes(r.type as IssueTrackerType)) continue;
    const t: IssueTrackerSetting = { type: r.type as IssueTrackerType };
    for (const f of ['url', 'workspace', 'org', 'project', 'repo', 'host', 'pattern'] as const) if (typeof r[f] === 'string') t[f] = (r[f] as string).trim();
    if (Array.isArray(r.keys)) t.keys = r.keys.filter((k): k is string => typeof k === 'string').map((k) => k.trim().toUpperCase()).filter((k) => KEY.test(k));
    out.push(t);
  }
  return out;
}

/** An http(s) URL without a trailing slash, or undefined */
function baseUrl(url: string | undefined): string | undefined {
  const u = url && safeUrl(url.trim());
  return u?.replace(/\/+$/, '');
}

function keyRule(keys: string[] | undefined, url: (key: string) => string): Rule {
  const list = (keys ?? []).filter((k) => KEY.test(k));
  const alt = list.length > 0 ? `(?:${list.join('|')})` : ANY_KEY;
  return { re: new RegExp(`${KB}(${alt}-[0-9]+)${E}`, 'g'), url: (m) => url(m[1]) };
}

/** The rule of an issue tracker, or undefined while a field it needs is missing or invalid */
export function trackerRule(t: IssueTrackerSetting): Rule | undefined {
  const enc = encodeURIComponent;
  switch (t.type) {
    case 'jira':
    case 'backlog':
    case 'youtrack': {
      const base = baseUrl(t.url);
      if (!base) return undefined;
      const page = t.type === 'jira' ? 'browse' : t.type === 'backlog' ? 'view' : 'issue';
      return keyRule(t.keys, (key) => `${base}/${page}/${key}`);
    }
    case 'linear': {
      const ws = t.workspace?.trim();
      if (!ws || !/^[A-Za-z0-9_-]+$/.test(ws)) return undefined;
      return keyRule(t.keys, (key) => `https://linear.app/${ws}/issue/${key}`);
    }
    case 'redmine': {
      const base = baseUrl(t.url);
      if (!base) return undefined;
      return { re: new RegExp(`${B}#([0-9]+)${E}`, 'g'), url: (m) => `${base}/issues/${m[1]}` };
    }
    case 'azureBoards': {
      const org = t.org?.trim();
      const project = t.project?.trim();
      if (!org || !project) return undefined;
      // AB#123, as GitHub repositories connected to Azure Boards write work items
      return { re: new RegExp(`${B}AB#([0-9]+)${E}`, 'g'), url: (m) => `https://dev.azure.com/${enc(org)}/${enc(project)}/_workitems/edit/${m[1]}` };
    }
    case 'github': {
      const repo = t.repo?.trim();
      const host = (t.host?.trim() || 'github.com').toLowerCase();
      if (!repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || !/^[a-z0-9.-]+(:[0-9]+)?$/.test(host)) return undefined;
      return { re: new RegExp(`${B}(?:#|GH-)([0-9]+)${E}`, 'g'), url: (m) => `https://${host}/${repo}/issues/${m[1]}` };
    }
    case 'custom':
      return t.pattern && t.url ? customRule(t.pattern, t.url) : undefined;
  }
}

/**
 * A rule of your own: `pattern` is a regular expression and `url` a URL in which `$0` (the whole match) and `$1`...`$9` (groups)
 * are replaced by the matched text, URL-encoded. undefined for an invalid pattern or a URL that is not http(s)
 */
export function customRule(pattern: string, url: string): Rule | undefined {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    return undefined;
  }
  if (!safeUrl(url.replace(/\$[0-9]/g, 'x'))) return undefined;
  return { re, url: (m) => url.replace(/\$([0-9])/g, (_, n: string) => encodeURIComponent(m[Number(n)] ?? '')) };
}

/** A link and what made it: a URL in the text, a tracker (its index in settings.trackers), or the built-in references */
export interface FoundLink extends MessageLink {
  source: 'url' | 'builtIn' | number;
}

/** The links in a message, in order, with what made each. Offsets are UTF-16 indexes into message (as JavaScript strings count) */
export function findLinks(message: string, remotes: readonly RemoteInfo[], settings: IssueLinkSettings): FoundLink[] {
  const text = message.length > MAX_SCAN ? message.slice(0, MAX_SCAN) : message;
  const rules: { rule: Rule; source: FoundLink['source'] }[] = [{ rule: URL_RULE, source: 'url' }];
  settings.trackers.forEach((t, i) => {
    const rule = trackerRule(t);
    if (rule) rules.push({ rule, source: i });
  });
  const found = settings.builtIn ? remoteTrackerOfRemotes(remotes) : undefined;
  if (found) for (const rule of builtInRules(found.tracker)) rules.push({ rule, source: 'builtIn' });

  // Earlier rules win where matches overlap: a URL over a reference inside it, the trackers over the built-in references
  const links: FoundLink[] = [];
  const overlaps = (start: number, end: number) => links.some((l) => start < l.end && l.start < end);
  for (const { rule, source } of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    for (let m = re.exec(text); m && links.length < MAX_LINKS; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const matched = source === 'url' ? trimUrl(m[0]) : m[0];
      const start = m.index;
      const end = start + matched.length;
      if (matched.length === 0 || overlaps(start, end)) continue;
      const url = safeUrl(source === 'url' ? matched : rule.url(m) ?? '');
      if (url) links.push({ start, end, url, source });
    }
  }
  return links.sort((a, b) => a.start - b.start);
}

/** The links in a message, in order */
export function messageLinks(message: string, remotes: readonly RemoteInfo[], settings: IssueLinkSettings): MessageLink[] {
  return findLinks(message, remotes, settings).map(({ start, end, url }) => ({ start, end, url }));
}

/** Keys like PROJ in PROJ-123 in messages, most used first (counted once per message) */
export function keyCandidates(messages: readonly string[], limit = 12): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  const re = new RegExp(`${KB}(${ANY_KEY})-[0-9]+${E}`, 'g');
  for (const message of messages) {
    const keys = new Set<string>();
    for (const m of message.slice(0, MAX_SCAN).matchAll(re)) keys.add(m[1]);
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}
