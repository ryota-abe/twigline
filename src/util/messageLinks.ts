// Links in a commit message: URLs, references to issues and pull requests by the conventions of the hosting service of the remote,
// and patterns the user defines (twigline.issueLinks.rules, e.g. Jira or Backlog keys).
// Only builds URLs; nothing is read from the hosting service.

import type { IssueLinkSettings, MessageLink, RemoteInfo } from '../../shared/protocol';
import { parseRemoteUrl } from './hosting';

/** Where `#123` and the like point to, decided from a remote URL */
export type IssueTracker =
  | { kind: 'github' | 'gitlab' | 'bitbucket'; /** https://host */ base: string; /** owner/repo (GitLab: group/subgroup/project) */ path: string }
  | { kind: 'azure'; base: string; org: string; project: string; repo: string };

/** Only the first part of a long message is scanned, and only so many links are made (a user's pattern could be slow) */
const MAX_SCAN = 20_000;
const MAX_LINKS = 200;

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function issueTrackerOf(url: string | undefined): IssueTracker | undefined {
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
export function issueTrackerOfRemotes(remotes: readonly RemoteInfo[]): IssueTracker | undefined {
  const rank = (name: string) => (name === 'upstream' ? 0 : name === 'origin' ? 1 : 2);
  const ordered = [...remotes].sort((a, b) => rank(a.name) - rank(b.name));
  for (const r of ordered) {
    const tracker = issueTrackerOf(r.fetchUrl ?? r.pushUrl);
    if (tracker) return tracker;
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
export function builtInRules(tracker: IssueTracker): Rule[] {
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

/**
 * A user's rule: `pattern` is a regular expression and `url` a URL in which `$0` (the whole match) and `$1`...`$9` (groups) are replaced
 * by the matched text, URL-encoded. An invalid pattern is skipped
 */
export function userRule(rule: { pattern: string; url: string }): Rule | undefined {
  if (typeof rule?.pattern !== 'string' || typeof rule.url !== 'string' || !rule.pattern) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern, 'g');
  } catch {
    return undefined;
  }
  return { re, url: (m) => rule.url.replace(/\$([0-9])/g, (_, n: string) => encodeURIComponent(m[Number(n)] ?? '')) };
}

/** The well-formed entries of twigline.issueLinks.rules */
export function issueLinkRules(value: unknown): { pattern: string; url: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((r): r is { pattern: string; url: string } => !!r && typeof r.pattern === 'string' && typeof r.url === 'string' && r.pattern !== '')
    .map((r) => ({ pattern: r.pattern, url: r.url }));
}

/** The links in a message, in order. Offsets are UTF-16 indexes into message (as JavaScript strings count) */
export function messageLinks(message: string, remotes: readonly RemoteInfo[], settings: IssueLinkSettings): MessageLink[] {
  const text = message.length > MAX_SCAN ? message.slice(0, MAX_SCAN) : message;
  const rules: { rule: Rule; trim?: boolean }[] = [{ rule: URL_RULE, trim: true }];
  for (const r of settings.rules) {
    const rule = userRule(r);
    if (rule) rules.push({ rule });
  }
  const tracker = settings.builtIn ? issueTrackerOfRemotes(remotes) : undefined;
  if (tracker) for (const rule of builtInRules(tracker)) rules.push({ rule });

  // Earlier rules win where matches overlap: a URL over a reference inside it, the user's rules over the built-in ones
  const links: MessageLink[] = [];
  const overlaps = (start: number, end: number) => links.some((l) => start < l.end && l.start < end);
  for (const { rule, trim } of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    for (let m = re.exec(text); m && links.length < MAX_LINKS; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const matched = trim ? trimUrl(m[0]) : m[0];
      const start = m.index;
      const end = start + matched.length;
      if (matched.length === 0 || overlaps(start, end)) continue;
      const raw = trim ? matched : rule.url(m);
      const url = raw === undefined ? undefined : safeUrl(raw);
      if (url) links.push({ start, end, url });
    }
  }
  return links.sort((a, b) => a.start - b.start);
}
