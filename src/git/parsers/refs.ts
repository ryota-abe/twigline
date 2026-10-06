import type { RefInfo, RemoteInfo, StashInfo } from '../../../shared/protocol';

export const FOR_EACH_REF_FORMAT_NO_WORKTREE =
  '%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(objecttype)';
/** With the worktree a branch is checked out in (%(worktreepath), git 2.23+) */
export const FOR_EACH_REF_FORMAT = `${FOR_EACH_REF_FORMAT_NO_WORKTREE}%1f%(worktreepath)`;

export function shortRefName(full: string): string {
  if (full.startsWith('refs/heads/')) return full.slice('refs/heads/'.length);
  if (full.startsWith('refs/remotes/')) return full.slice('refs/remotes/'.length);
  if (full.startsWith('refs/tags/')) return full.slice('refs/tags/'.length);
  return full;
}

/** git for-each-ref --format=FOR_EACH_REF_FORMAT (or FOR_EACH_REF_FORMAT_NO_WORKTREE) refs/heads refs/remotes refs/tags */
export function parseForEachRef(output: string, remoteNames: readonly string[] = []): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [fullName, objectName, peeled, upstream, track, head, objectType, worktree] = line.split('\x1f');
    if (!fullName || !objectName) continue;
    let kind: RefInfo['kind'];
    if (fullName.startsWith('refs/heads/')) kind = 'head';
    else if (fullName.startsWith('refs/remotes/')) kind = 'remote';
    else if (fullName.startsWith('refs/tags/')) kind = 'tag';
    else continue;
    const name = shortRefName(fullName);
    // Do not list symbolic refs such as origin/HEAD
    if (kind === 'remote' && /\/HEAD$/.test(name)) continue;
    const ref: RefInfo = { kind, name, fullName, sha: peeled || objectName };
    if (kind === 'tag') ref.annotated = objectType === 'tag';
    if (kind === 'head') {
      if (upstream) ref.upstream = shortRefName(upstream);
      if (head === '*') ref.isHead = true;
      // Checked out in another worktree (the current one is told by %(HEAD))
      else if (worktree) ref.worktree = worktree;
      if (track) {
        if (track === 'gone') ref.gone = true;
        const a = /ahead (\d+)/.exec(track);
        const b = /behind (\d+)/.exec(track);
        ref.ahead = a ? Number(a[1]) : 0;
        ref.behind = b ? Number(b[1]) : 0;
      } else if (upstream) {
        ref.ahead = 0;
        ref.behind = 0;
      }
    }
    if (kind === 'remote') {
      // A remote name may contain slashes, so take the longest match among known remote names
      const remote = [...remoteNames].sort((a, b) => b.length - a.length).find((r) => name.startsWith(r + '/'));
      ref.remote = remote ?? name.split('/')[0];
    }
    refs.push(ref);
  }
  return refs;
}

/** Output of git config -z --get-regexp (key\nvalue\0) */
export function parseConfigZ(output: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of output.split('\0')) {
    if (!entry) continue;
    const nl = entry.indexOf('\n');
    // git lowercases section and key names in its output but leaves subsections (such as remote names) as they are
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? '' : entry.slice(nl + 1);
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  }
  return map;
}

export function remotesFromConfig(config: Map<string, string[]>): RemoteInfo[] {
  const remotes = new Map<string, RemoteInfo>();
  for (const [key, values] of config) {
    const m = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
    if (!m) continue;
    const name = m[1];
    const r = remotes.get(name) ?? { name };
    if (m[2] === 'url') r.fetchUrl = values[0];
    else r.pushUrl = values[0];
    remotes.set(name, r);
  }
  return [...remotes.values()].sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : a.name.localeCompare(b.name)));
}

export const STASH_FORMAT = '%H%x1f%P%x1f%gd%x1f%ct%x1f%gs';

/** git stash list -z --format=STASH_FORMAT */
export function parseStashList(output: string): StashInfo[] {
  const list: StashInfo[] = [];
  for (const rec of output.split('\0')) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const [sha, parents, selector, time, subject] = r.split('\x1f');
    const m = /stash@\{(\d+)\}/.exec(selector ?? '');
    if (!sha || !m) continue;
    list.push({
      index: Number(m[1]),
      sha,
      base: (parents ?? '').split(' ')[0] ?? '',
      message: subject ?? '',
      time: Number(time) || 0,
    });
  }
  return list;
}
