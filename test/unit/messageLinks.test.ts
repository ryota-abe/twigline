import { afterEach, describe, expect, it } from 'vitest';
import type { IssueLinkSettings, RemoteInfo } from '../../shared/protocol';
import { issueLinkRules, issueTrackerOf, issueTrackerOfRemotes, messageLinks, safeUrl } from '../../src/util/messageLinks';
import { TEST_CONFIG, makeRepo, openModel, testEnv, type TempRepo } from './helpers';

// Links in commit messages: URLs, references by the conventions of each hosting service, and the user's patterns

const BUILT_IN: IssueLinkSettings = { builtIn: true, rules: [] };
const origin = (url: string): RemoteInfo[] => [{ name: 'origin', fetchUrl: url }];

/** [link text, url] of each link */
function links(message: string, remotes: RemoteInfo[], settings: IssueLinkSettings = BUILT_IN): [string, string][] {
  return messageLinks(message, remotes, settings).map((l) => [message.slice(l.start, l.end), l.url]);
}

describe('issueTrackerOf', () => {
  it('recognizes the hosting service and the repository from https, ssh and scp URLs', () => {
    expect(issueTrackerOf('git@github.com:me/repo.git')).toEqual({ kind: 'github', base: 'https://github.com', path: 'me/repo' });
    expect(issueTrackerOf('ssh://git@ssh.github.com:443/me/repo.git')).toEqual({ kind: 'github', base: 'https://github.com', path: 'me/repo' });
    expect(issueTrackerOf('https://github.example.com/me/repo')).toEqual({ kind: 'github', base: 'https://github.example.com', path: 'me/repo' });
    expect(issueTrackerOf('git@gitlab.com:group/sub/project.git')).toEqual({ kind: 'gitlab', base: 'https://gitlab.com', path: 'group/sub/project' });
    expect(issueTrackerOf('git@altssh.bitbucket.org:team/repo.git')).toEqual({ kind: 'bitbucket', base: 'https://bitbucket.org', path: 'team/repo' });
    expect(issueTrackerOf('https://org@dev.azure.com/org/My Project/_git/repo')).toEqual({ kind: 'azure', base: 'https://dev.azure.com', org: 'org', project: 'My Project', repo: 'repo' });
    expect(issueTrackerOf('git@ssh.dev.azure.com:v3/org/proj/repo')).toEqual({ kind: 'azure', base: 'https://dev.azure.com', org: 'org', project: 'proj', repo: 'repo' });
  });

  it('does not guess a service it cannot tell from the host name', () => {
    expect(issueTrackerOf('https://git.example.com/me/repo.git')).toBeUndefined();
    expect(issueTrackerOf('/srv/git/repo.git')).toBeUndefined();
    expect(issueTrackerOf('https://github.com/me')).toBeUndefined();
    expect(issueTrackerOf(undefined)).toBeUndefined();
  });

  it('takes upstream first, then origin, then the other remotes, skipping unknown services', () => {
    const remotes: RemoteInfo[] = [
      { name: 'mine', fetchUrl: 'https://github.com/someone/repo' },
      { name: 'origin', fetchUrl: 'https://github.com/me/repo' },
      { name: 'upstream', fetchUrl: 'https://github.com/project/repo' },
    ];
    expect(issueTrackerOfRemotes(remotes)).toMatchObject({ path: 'project/repo' });
    expect(issueTrackerOfRemotes(remotes.slice(0, 2))).toMatchObject({ path: 'me/repo' });
    expect(issueTrackerOfRemotes([{ name: 'origin', fetchUrl: '/srv/repo.git' }, remotes[0]])).toMatchObject({ path: 'someone/repo' });
    expect(issueTrackerOfRemotes([])).toBeUndefined();
  });
});

describe('messageLinks: GitHub', () => {
  const gh = origin('git@github.com:me/repo.git');

  it('links #123, GH-123 and owner/repo#123', () => {
    expect(links('Fix the crash (#12), see GH-3 and other/lib#4', gh)).toEqual([
      ['#12', 'https://github.com/me/repo/issues/12'],
      ['GH-3', 'https://github.com/me/repo/issues/3'],
      ['other/lib#4', 'https://github.com/other/lib/issues/4'],
    ]);
  });

  it('opens the pull request of a merge commit made by GitHub', () => {
    expect(links('Merge pull request #33 from me/topic\n\nFixes #7', gh)).toEqual([
      ['#33', 'https://github.com/me/repo/pull/33'],
      ['#7', 'https://github.com/me/repo/issues/7'],
    ]);
  });

  it('links references next to Japanese text but not inside words, paths, fragments or entities', () => {
    expect(links('ログイン修正#12、（#13）', gh).map(([text]) => text)).toEqual(['#12', '#13']);
    expect(links('a#1 x/#2 &#123; #4abc #5_ issue#6 ＃１２ #', gh)).toEqual([]);
  });

  it('uses the host of GitHub Enterprise Server', () => {
    expect(links('#1', origin('https://github.example.com/me/repo.git'))).toEqual([['#1', 'https://github.example.com/me/repo/issues/1']]);
  });
});

describe('messageLinks: other services', () => {
  it('GitLab: issues with #, merge requests with !, and references to other projects', () => {
    expect(links('Closes #5 and !6\n\nSee merge request group/sub/proj!7', origin('git@gitlab.com:group/app.git'))).toEqual([
      ['#5', 'https://gitlab.com/group/app/-/issues/5'],
      ['!6', 'https://gitlab.com/group/app/-/merge_requests/6'],
      ['group/sub/proj!7', 'https://gitlab.com/group/sub/proj/-/merge_requests/7'],
    ]);
  });

  it('Bitbucket Cloud: "pull request #12" is a pull request, any other #12 an issue', () => {
    expect(links('Merged in topic (pull request #12)\n\nFixes #3', origin('git@bitbucket.org:team/repo.git'))).toEqual([
      ['#12', 'https://bitbucket.org/team/repo/pull-requests/12'],
      ['#3', 'https://bitbucket.org/team/repo/issues/3'],
    ]);
  });

  it('Azure DevOps: #123 is a work item, !123 and "Merged PR 123" a pull request', () => {
    expect(links('Merged PR 45: Add login\n\nRelated work items: #67, !8', origin('https://dev.azure.com/org/My Project/_git/web'))).toEqual([
      ['PR 45', 'https://dev.azure.com/org/My%20Project/_git/web/pullrequest/45'],
      ['#67', 'https://dev.azure.com/org/My%20Project/_workitems/edit/67'],
      ['!8', 'https://dev.azure.com/org/My%20Project/_git/web/pullrequest/8'],
    ]);
  });

  it('links nothing but URLs for a remote of an unknown service, or with no remote', () => {
    expect(links('Fix #1', origin('https://git.example.com/me/repo.git'))).toEqual([]);
    expect(links('Fix #1', [])).toEqual([]);
  });
});

describe('messageLinks: URLs', () => {
  it('links http(s) URLs without trailing punctuation or an unbalanced parenthesis, and does not link references inside them', () => {
    expect(links('See https://example.com/a#12. (https://example.com/b_(c)) and https://example.com/d?x=1,', origin('git@github.com:me/repo.git'))).toEqual([
      ['https://example.com/a#12', 'https://example.com/a#12'],
      ['https://example.com/b_(c)', 'https://example.com/b_(c)'],
      ['https://example.com/d?x=1', 'https://example.com/d?x=1'],
    ]);
  });

  it('stops a URL at Japanese text and links URLs even when the built-in references are off', () => {
    expect(links('詳細はhttps://example.com/xを参照', [], { builtIn: false, rules: [] })).toEqual([['https://example.com/x', 'https://example.com/x']]);
  });
});

describe('messageLinks: the user rules', () => {
  const jira = { pattern: '\\b([A-Z][A-Z0-9_]+-[0-9]+)\\b', url: 'https://example.atlassian.net/browse/$1' };

  it('links matches of the pattern, with $0 and $1-$9 replaced by URL-encoded text', () => {
    expect(links('PROJ-12: fix (see UI-3)', [], { builtIn: true, rules: [jira] })).toEqual([
      ['PROJ-12', 'https://example.atlassian.net/browse/PROJ-12'],
      ['UI-3', 'https://example.atlassian.net/browse/UI-3'],
    ]);
    expect(links('wiki:a b/c', [], { builtIn: true, rules: [{ pattern: 'wiki:(\\S+ \\S+)', url: 'https://wiki.example.com/$1?from=$0' }] })).toEqual([
      ['wiki:a b/c', 'https://wiki.example.com/a%20b%2Fc?from=wiki%3Aa%20b%2Fc'],
    ]);
  });

  it('is tried before the built-in references, which can be turned off', () => {
    const redmine = { pattern: '#([0-9]+)', url: 'https://redmine.example.com/issues/$1' };
    const gh = origin('git@github.com:me/repo.git');
    expect(links('refs #9, GH-2', gh, { builtIn: true, rules: [redmine] })).toEqual([
      ['#9', 'https://redmine.example.com/issues/9'],
      ['GH-2', 'https://github.com/me/repo/issues/2'],
    ]);
    expect(links('refs #9, GH-2', gh, { builtIn: false, rules: [redmine] })).toEqual([['#9', 'https://redmine.example.com/issues/9']]);
  });

  it('skips invalid patterns, patterns that match nothing, and URLs that are not http(s)', () => {
    const settings: IssueLinkSettings = {
      builtIn: false,
      rules: [
        { pattern: '(', url: 'https://example.com/$0' },
        { pattern: 'x*', url: 'https://example.com/$0' },
        { pattern: 'RUN-([0-9]+)', url: 'command:workbench.action.terminal.new?$1' },
        { pattern: 'JS-([0-9]+)', url: 'javascript:alert($1)' },
        { pattern: 'REL-([0-9]+)', url: '/issues/$1' },
      ],
    };
    expect(links('RUN-1 JS-2 REL-3 yyy', [], settings)).toEqual([]);
  });

  it('reads only well-formed rules from the setting', () => {
    expect(issueLinkRules([jira, { pattern: '', url: 'https://x' }, { pattern: 'a' }, null, 'x'])).toEqual([jira]);
    expect(issueLinkRules({})).toEqual([]);
  });
});

describe('safeUrl', () => {
  it('accepts http and https only', () => {
    expect(safeUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeUrl('http://example.com')).toBe('http://example.com/');
    for (const u of ['file:///etc/passwd', 'command:foo', 'vscode://x', 'javascript:alert(1)', 'example.com', '']) expect(safeUrl(u)).toBeUndefined();
  });
});

describe('commit details', () => {
  let repo: TempRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('carry the links of the message, which the host finds again from the commit by its sha', async () => {
    repo = makeRepo();
    repo.git(['remote', 'add', 'origin', 'git@github.com:me/repo.git']);
    const sha = repo.commit('Fix login (#12)\n\nSee PROJ-3 and https://example.com/x.');
    const env = testEnv({ config: () => ({ ...TEST_CONFIG, issueLinks: { builtIn: true, rules: [{ pattern: 'PROJ-([0-9]+)', url: 'https://jira.example.com/browse/PROJ-$1' }] } }) });
    const model = await openModel(repo.dir, env);
    try {
      const detail = await model.diff.commitDetail(sha, undefined, undefined);
      expect(detail.links.map((l) => [detail.message.slice(l.start, l.end), l.url])).toEqual([
        ['#12', 'https://github.com/me/repo/issues/12'],
        ['PROJ-3', 'https://jira.example.com/browse/PROJ-3'],
        ['https://example.com/x', 'https://example.com/x'],
      ]);
      expect(await model.diff.messageLinks(sha)).toEqual(detail.links);
    } finally {
      model.dispose();
    }
  });
});
