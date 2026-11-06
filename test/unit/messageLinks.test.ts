import { afterEach, describe, expect, it } from 'vitest';
import type { IssueLinkSettings, IssueTrackerSetting, RemoteInfo } from '../../shared/protocol';
import { issueTrackerSettings, keyCandidates, messageLinks, remoteTrackerOf, remoteTrackerOfRemotes, safeUrl } from '../../src/util/messageLinks';
import { makeRepo, openModel, testEnv, type TempRepo } from './helpers';

// Links in commit messages: URLs, issue trackers the user sets, and references by the conventions of each hosting service

const BUILT_IN: IssueLinkSettings = { builtIn: true, trackers: [] };
const origin = (url: string): RemoteInfo[] => [{ name: 'origin', fetchUrl: url }];

/** [link text, url] of each link */
function links(message: string, remotes: RemoteInfo[], settings: IssueLinkSettings = BUILT_IN): [string, string][] {
  return messageLinks(message, remotes, settings).map((l) => [message.slice(l.start, l.end), l.url]);
}

describe('remoteTrackerOf', () => {
  it('recognizes the hosting service and the repository from https, ssh and scp URLs', () => {
    expect(remoteTrackerOf('git@github.com:me/repo.git')).toEqual({ kind: 'github', base: 'https://github.com', path: 'me/repo' });
    expect(remoteTrackerOf('ssh://git@ssh.github.com:443/me/repo.git')).toEqual({ kind: 'github', base: 'https://github.com', path: 'me/repo' });
    expect(remoteTrackerOf('https://github.example.com/me/repo')).toEqual({ kind: 'github', base: 'https://github.example.com', path: 'me/repo' });
    expect(remoteTrackerOf('git@gitlab.com:group/sub/project.git')).toEqual({ kind: 'gitlab', base: 'https://gitlab.com', path: 'group/sub/project' });
    expect(remoteTrackerOf('git@altssh.bitbucket.org:team/repo.git')).toEqual({ kind: 'bitbucket', base: 'https://bitbucket.org', path: 'team/repo' });
    expect(remoteTrackerOf('https://org@dev.azure.com/org/My Project/_git/repo')).toEqual({ kind: 'azure', base: 'https://dev.azure.com', org: 'org', project: 'My Project', repo: 'repo' });
    expect(remoteTrackerOf('git@ssh.dev.azure.com:v3/org/proj/repo')).toEqual({ kind: 'azure', base: 'https://dev.azure.com', org: 'org', project: 'proj', repo: 'repo' });
  });

  it('does not guess a service it cannot tell from the host name', () => {
    expect(remoteTrackerOf('https://git.example.com/me/repo.git')).toBeUndefined();
    expect(remoteTrackerOf('/srv/git/repo.git')).toBeUndefined();
    expect(remoteTrackerOf('https://github.com/me')).toBeUndefined();
    expect(remoteTrackerOf(undefined)).toBeUndefined();
  });

  it('takes upstream first, then origin, then the other remotes, skipping unknown services', () => {
    const remotes: RemoteInfo[] = [
      { name: 'mine', fetchUrl: 'https://github.com/someone/repo' },
      { name: 'origin', fetchUrl: 'https://github.com/me/repo' },
      { name: 'upstream', fetchUrl: 'https://github.com/project/repo' },
    ];
    expect(remoteTrackerOfRemotes(remotes)).toMatchObject({ remote: 'upstream', tracker: { path: 'project/repo' } });
    expect(remoteTrackerOfRemotes(remotes.slice(0, 2))).toMatchObject({ remote: 'origin', tracker: { path: 'me/repo' } });
    expect(remoteTrackerOfRemotes([{ name: 'origin', fetchUrl: '/srv/repo.git' }, remotes[0]])).toMatchObject({ remote: 'mine', tracker: { path: 'someone/repo' } });
    expect(remoteTrackerOfRemotes([])).toBeUndefined();
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
    expect(links('詳細はhttps://example.com/xを参照', [], { builtIn: false, trackers: [] })).toEqual([['https://example.com/x', 'https://example.com/x']]);
  });
});

describe('messageLinks: issue trackers', () => {
  const only = (...trackers: IssueTrackerSetting[]): IssueLinkSettings => ({ builtIn: false, trackers });

  it('Jira, Backlog and YouTrack link the given keys only, or any key when none is given', () => {
    const jira: IssueTrackerSetting = { type: 'jira', url: 'https://example.atlassian.net/', keys: ['PROJ', 'UI'] };
    expect(links('PROJ-12: fix UI-3 (not OTHER-4, UTF-8, xPROJ-5 or feature/PROJ-6)', [], only(jira))).toEqual([
      ['PROJ-12', 'https://example.atlassian.net/browse/PROJ-12'],
      ['UI-3', 'https://example.atlassian.net/browse/UI-3'],
    ]);
    expect(links('APP-1 and UTF-8', [], only({ type: 'backlog', url: 'https://example.backlog.jp' }))).toEqual([
      ['APP-1', 'https://example.backlog.jp/view/APP-1'],
      ['UTF-8', 'https://example.backlog.jp/view/UTF-8'],
    ]);
    expect(links('DEV-7', [], only({ type: 'youtrack', url: 'https://yt.example.com', keys: ['DEV'] }))).toEqual([['DEV-7', 'https://yt.example.com/issue/DEV-7']]);
  });

  it('Linear, Redmine, Azure Boards and another GitHub repository', () => {
    expect(links('ENG-5', [], only({ type: 'linear', workspace: 'acme', keys: ['ENG'] }))).toEqual([['ENG-5', 'https://linear.app/acme/issue/ENG-5']]);
    expect(links('refs #9', [], only({ type: 'redmine', url: 'https://redmine.example.com/' }))).toEqual([['#9', 'https://redmine.example.com/issues/9']]);
    expect(links('Fixes AB#42, not XAB#1', [], only({ type: 'azureBoards', org: 'org', project: 'My Project' }))).toEqual([
      ['AB#42', 'https://dev.azure.com/org/My%20Project/_workitems/edit/42'],
    ]);
    expect(links('#3 and GH-4', [], only({ type: 'github', repo: 'project/issues', host: 'github.example.com' }))).toEqual([
      ['#3', 'https://github.example.com/project/issues/issues/3'],
      ['GH-4', 'https://github.example.com/project/issues/issues/4'],
    ]);
  });

  it('custom: a pattern and a URL with $0 and $1-$9 replaced by URL-encoded text', () => {
    expect(links('wiki:a b/c', [], only({ type: 'custom', pattern: 'wiki:(\\S+ \\S+)', url: 'https://wiki.example.com/$1?from=$0' }))).toEqual([
      ['wiki:a b/c', 'https://wiki.example.com/a%20b%2Fc?from=wiki%3Aa%20b%2Fc'],
    ]);
  });

  it('are tried in order before the built-in references', () => {
    const gh = origin('git@github.com:me/repo.git');
    const redmine: IssueTrackerSetting = { type: 'redmine', url: 'https://redmine.example.com' };
    expect(links('refs #9, GH-2', gh, { builtIn: true, trackers: [redmine] })).toEqual([
      ['#9', 'https://redmine.example.com/issues/9'],
      ['GH-2', 'https://github.com/me/repo/issues/2'],
    ]);
    const any: IssueTrackerSetting = { type: 'jira', url: 'https://a.example.com' };
    const ui: IssueTrackerSetting = { type: 'backlog', url: 'https://b.example.com', keys: ['UI'] };
    expect(links('UI-1', [], only(ui, any))).toEqual([['UI-1', 'https://b.example.com/view/UI-1']]);
  });

  it('skip a tracker while a field it needs is missing or invalid, and never make non-http(s) URLs', () => {
    const bad: IssueTrackerSetting[] = [
      { type: 'jira' },
      { type: 'jira', url: 'example.atlassian.net' },
      { type: 'backlog', url: 'javascript:alert(1)' },
      { type: 'linear', workspace: 'a/b' },
      { type: 'azureBoards', org: 'org' },
      { type: 'github', repo: 'not a repo' },
      { type: 'custom', pattern: '(', url: 'https://example.com/$0' },
      { type: 'custom', pattern: 'x*', url: 'https://example.com/$0' },
      { type: 'custom', pattern: 'RUN-([0-9]+)', url: 'command:workbench.action.terminal.new?$1' },
      { type: 'custom', pattern: 'REL-([0-9]+)', url: '/issues/$1' },
    ];
    expect(links('PROJ-1 ENG-2 AB#3 #4 RUN-5 REL-6 yyy', [], only(...bad))).toEqual([]);
  });

  it('reads only well-formed entries from the setting, with keys upper-cased', () => {
    expect(
      issueTrackerSettings([
        { type: 'jira', url: ' https://x ', keys: ['proj', 'ui', 'bad key', 1], extra: true },
        { type: 'unknown', url: 'https://x' },
        { url: 'https://x' },
        null,
        'x',
      ]),
    ).toEqual([{ type: 'jira', url: 'https://x', keys: ['PROJ', 'UI'] }]);
    expect(issueTrackerSettings({})).toEqual([]);
  });
});

describe('keyCandidates', () => {
  it('counts keys like PROJ in PROJ-123 once per message, most used first', () => {
    expect(keyCandidates(['PROJ-1 PROJ-2', 'PROJ-3, UI-1', 'UTF-8', 'feature/ABC-1 xDEF-2 GH-3 #4'])).toEqual([
      { key: 'PROJ', count: 2 },
      { key: 'GH', count: 1 },
      { key: 'UI', count: 1 },
      { key: 'UTF', count: 1 },
    ]);
  });
});

describe('safeUrl', () => {
  it('accepts http and https only', () => {
    expect(safeUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeUrl('http://example.com')).toBe('http://example.com/');
    for (const u of ['file:///etc/passwd', 'command:foo', 'vscode://x', 'javascript:alert(1)', 'example.com', '']) expect(safeUrl(u)).toBeUndefined();
  });
});

describe('LinkService', () => {
  let repo: TempRepo | undefined;
  afterEach(() => repo?.cleanup());

  const jira: IssueTrackerSetting = { type: 'jira', url: 'https://jira.example.com', keys: ['PROJ'] };

  it('gives the commit details the links of the message, which the host finds again from the commit by its sha', async () => {
    repo = makeRepo();
    repo.git(['remote', 'add', 'origin', 'git@github.com:me/repo.git']);
    const sha = repo.commit('Fix login (#12)\n\nSee PROJ-3 and https://example.com/x.');
    const env = testEnv({ issueLinks: () => ({ settings: { builtIn: true, trackers: [jira] }, source: 'workspace', targets: ['workspace', 'user'] }) });
    const model = await openModel(repo.dir, env);
    try {
      const detail = await model.diff.commitDetail(sha, undefined, undefined);
      expect(detail.links.map((l) => [detail.message.slice(l.start, l.end), l.url])).toEqual([
        ['#12', 'https://github.com/me/repo/issues/12'],
        ['PROJ-3', 'https://jira.example.com/browse/PROJ-3'],
        ['https://example.com/x', 'https://example.com/x'],
      ]);
      expect(await model.links.linksOf(sha)).toEqual(detail.links);
    } finally {
      model.dispose();
    }
  });

  it('links only URLs by default', async () => {
    repo = makeRepo();
    repo.git(['remote', 'add', 'origin', 'git@github.com:me/repo.git']);
    const sha = repo.commit('Fix #1, see https://example.com');
    const model = await openModel(repo.dir);
    try {
      expect((await model.diff.commitDetail(sha, undefined, undefined)).links.map((l) => l.url)).toEqual(['https://example.com/']);
    } finally {
      model.dispose();
    }
  });

  it('tells the dialog the remote, the keys used in recent commits, and where the settings are', async () => {
    repo = makeRepo();
    repo.git(['remote', 'add', 'upstream', 'https://dev.azure.com/org/proj/_git/web']);
    repo.commit('PROJ-1 first');
    repo.commit('PROJ-2 second, UTF-8');
    const model = await openModel(repo.dir);
    try {
      expect(await model.links.state()).toEqual({
        settings: { builtIn: false, trackers: [] },
        source: 'default',
        targets: ['user'],
        remote: { name: 'upstream', service: 'azure', path: 'org/proj/web' },
        keys: [
          { key: 'PROJ', count: 2 },
          { key: 'UTF', count: 1 },
        ],
      });
    } finally {
      model.dispose();
    }
  });

  it('previews settings being edited on recent commits and on the selected one, and saves them cleaned up', async () => {
    repo = makeRepo();
    repo.git(['remote', 'add', 'origin', 'git@github.com:me/repo.git']);
    repo.commit('PROJ-1 first (#5)');
    repo.commit('PROJ-2 second');
    const sha = repo.commit('PROJ-3 third, PROJ-3 again');
    const saved: unknown[] = [];
    const model = await openModel(repo.dir, testEnv({ saveIssueLinks: async (...args) => void saved.push(args) }));
    try {
      const preview = await model.links.preview({ builtIn: true, trackers: [jira, { type: 'backlog' }] }, sha);
      expect(preview.commits).toBe(3);
      expect(preview.groups).toEqual([
        {
          tracker: 0,
          valid: true,
          count: 4,
          examples: [
            { text: 'PROJ-3', url: 'https://jira.example.com/browse/PROJ-3' },
            { text: 'PROJ-2', url: 'https://jira.example.com/browse/PROJ-2' },
            { text: 'PROJ-1', url: 'https://jira.example.com/browse/PROJ-1' },
          ],
        },
        { tracker: 1, valid: false, count: 0, examples: [] },
        { tracker: null, valid: true, count: 1, examples: [{ text: '#5', url: 'https://github.com/me/repo/issues/5' }] },
      ]);
      expect(preview.selected?.message).toBe('PROJ-3 third, PROJ-3 again');
      expect(preview.selected?.links.map((l) => [l.start, l.end])).toEqual([
        [0, 6],
        [14, 20],
      ]);

      await model.links.save({ builtIn: false, trackers: [{ type: 'jira', url: 'https://jira.example.com', keys: ['proj'] }] }, 'user');
      expect(saved).toEqual([[repo.dir, { builtIn: false, trackers: [{ type: 'jira', url: 'https://jira.example.com', keys: ['PROJ'] }] }, 'user']]);
    } finally {
      model.dispose();
    }
  });
});
