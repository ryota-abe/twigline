import type { IssueLinkSettings, IssueLinksPreview, IssueLinksState, MessageLink, SettingsTarget, Sha } from '../../shared/protocol';
import type { RepoModel } from '../repo/RepoModel';
import { findLinks, issueTrackerSettings, keyCandidates, messageLinks, remoteTrackerOfRemotes, trackerRule } from '../util/messageLinks';

/** Commits looked at for key candidates and the preview */
const RECENT = 300;
const EXAMPLES = 3;

/** Links in commit messages (twigline.issueLinks.*): finding them, and the settings dialog */
export class LinkService {
  private recent?: { head: string; messages: string[] };

  constructor(private readonly repo: RepoModel) {}

  private settings(): IssueLinkSettings {
    return this.repo.env.issueLinks(this.repo.root).settings;
  }

  async linksIn(message: string, settings = this.settings()): Promise<MessageLink[]> {
    const snap = await this.repo.snapshot.get();
    return messageLinks(message, snap.remotes, settings);
  }

  /** Links in the message of a commit, found again from the commit itself (the webview's copy is not trusted for what to open) */
  async linksOf(sha: Sha): Promise<MessageLink[]> {
    return this.linksIn(await this.message(sha));
  }

  async state(): Promise<IssueLinksState> {
    const snap = await this.repo.snapshot.get();
    const found = remoteTrackerOfRemotes(snap.remotes);
    const remote = found && {
      name: found.remote,
      service: found.tracker.kind,
      path: found.tracker.kind === 'azure' ? `${found.tracker.org}/${found.tracker.project}/${found.tracker.repo}` : found.tracker.path,
    };
    return { ...this.repo.env.issueLinks(this.repo.root), remote, keys: keyCandidates(await this.recentMessages()) };
  }

  async preview(settings: IssueLinkSettings, sha?: Sha): Promise<IssueLinksPreview> {
    const s: IssueLinkSettings = { builtIn: settings.builtIn, trackers: issueTrackerSettings(settings.trackers) };
    const snap = await this.repo.snapshot.get();
    const messages = await this.recentMessages();
    const groups: IssueLinksPreview['groups'] = s.trackers.map((t, i) => ({ tracker: i, valid: !!trackerRule(t), count: 0, examples: [] }));
    const builtIn = { tracker: null, valid: !!remoteTrackerOfRemotes(snap.remotes), count: 0, examples: [] as { text: string; url: string }[] };
    if (s.builtIn) groups.push(builtIn);
    for (const message of messages) {
      for (const l of findLinks(message, snap.remotes, s)) {
        const g = l.source === 'builtIn' ? builtIn : typeof l.source === 'number' ? groups[l.source] : undefined;
        if (!g) continue;
        g.count++;
        const text = message.slice(l.start, l.end);
        if (g.examples.length < EXAMPLES && !g.examples.some((e) => e.text === text)) g.examples.push({ text, url: l.url });
      }
    }
    let selected: IssueLinksPreview['selected'];
    if (sha) {
      const message = await this.message(sha);
      selected = { message, links: messageLinks(message, snap.remotes, s) };
    }
    return { commits: messages.length, groups, selected };
  }

  async save(settings: IssueLinkSettings, target: SettingsTarget): Promise<void> {
    await this.repo.env.saveIssueLinks(this.repo.root, { builtIn: settings.builtIn, trackers: issueTrackerSettings(settings.trackers) }, target);
  }

  private async message(sha: Sha): Promise<string> {
    const show = await this.repo.runner.run(['show', '-s', '--encoding=UTF-8', '--format=%B', '--end-of-options', sha]);
    return show.stdout.toString('utf8').replace(/\n+$/, '');
  }

  /** Messages of the most recent commits on HEAD (none before the first commit). Read again when HEAD moves */
  private async recentMessages(): Promise<string[]> {
    const head = (await this.repo.snapshot.get()).head.sha;
    if (!head) return [];
    if (this.recent?.head === head) return this.recent.messages;
    const res = await this.repo.runner.run(['log', '-n', String(RECENT), '--encoding=UTF-8', '--format=%B%x00', head, '--'], { noThrow: true });
    const messages = res.exitCode === 0 ? res.stdout.toString('utf8').split('\0').map((m) => m.trim()).filter(Boolean) : [];
    this.recent = { head, messages };
    return messages;
  }
}
