import type { FileStatusCode, StatusFile, WorkingTreeStatus } from '../../../shared/protocol';

// Parses git status --porcelain=v2 --branch -z --untracked-files=all --no-renames

export interface BranchStatus {
  oid: string | null; // null for (initial)
  head: string | null; // null for (detached)
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface ParsedStatus extends WorkingTreeStatus {
  branch: BranchStatus;
}

function code(c: string): FileStatusCode | null {
  switch (c) {
    case '.':
      return null;
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
      return c;
    default:
      return 'M';
  }
}

/** Take n space-separated fields and return the rest as the path */
function splitFields(entry: string, n: number): { fields: string[]; rest: string } {
  const fields: string[] = [];
  let from = 0;
  for (let k = 0; k < n; k++) {
    const sp = entry.indexOf(' ', from);
    if (sp < 0) return { fields, rest: '' };
    fields.push(entry.slice(from, sp));
    from = sp + 1;
  }
  return { fields, rest: entry.slice(from) };
}

export function parseStatusV2(output: Buffer | string): ParsedStatus {
  const text = typeof output === 'string' ? output : output.toString('utf8');
  const entries = text.split('\0');
  const branch: BranchStatus = { oid: null, head: null, ahead: 0, behind: 0 };
  const staged: StatusFile[] = [];
  const unstaged: StatusFile[] = [];
  const conflicted: StatusFile[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const kind = e[0];
    if (kind === '#') {
      const { fields, rest } = splitFields(e, 2);
      const key = fields[1];
      if (key === 'branch.oid') branch.oid = rest === '(initial)' ? null : rest;
      else if (key === 'branch.head') branch.head = rest === '(detached)' ? null : rest;
      else if (key === 'branch.upstream') branch.upstream = rest;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(rest);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath (handled even with --no-renames, just in case)
      const { fields, rest } = splitFields(e, kind === '1' ? 8 : 9);
      const xy = fields[1] ?? '..';
      const submodule = (fields[2] ?? 'N').startsWith('S');
      const path = rest;
      if (kind === '2') i++; // Skip origPath
      const x = code(xy[0]);
      const y = code(xy[1]);
      if (x) staged.push({ path, status: x, submodule: submodule || undefined });
      if (y) unstaged.push({ path, status: y, submodule: submodule || undefined });
      continue;
    }
    if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const { fields, rest } = splitFields(e, 10);
      conflicted.push({ path: rest, status: 'U', conflict: fields[1] });
      continue;
    }
    if (kind === '?') {
      unstaged.push({ path: e.slice(2), status: '?' });
      continue;
    }
    // Do not show '!' (ignored files)
  }
  const byPath = (a: StatusFile, b: StatusFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  staged.sort(byPath);
  unstaged.sort(byPath);
  conflicted.sort(byPath);
  return { branch, staged, unstaged, conflicted };
}
