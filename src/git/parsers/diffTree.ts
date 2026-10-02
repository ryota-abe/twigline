import type { ChangedFile, FileStatusCode } from '../../../shared/protocol';

// Parses git diff-tree -r -z -M --raw --numstat (or git diff --raw --numstat -z).
// The output lists all the raw entries first, followed by the numstat entries in the same order.

function statusCode(s: string): FileStatusCode {
  const c = s[0];
  switch (c) {
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

export function parseRawNumstat(output: Buffer | string): ChangedFile[] {
  const text = typeof output === 'string' ? output : output.toString('utf8');
  const tokens = text.split('\0');
  const files: ChangedFile[] = [];
  const stats: { additions?: number; deletions?: number; binary: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    if (!tok) continue;
    tok = tok.replace(/^\n+/, '');
    if (!tok) continue;
    if (tok.startsWith(':')) {
      // :100644 100644 <sha> <sha> M
      const parts = tok.split(' ');
      const st = parts[4] ?? 'M';
      const status = statusCode(st);
      if (status === 'R' || status === 'C') {
        const oldPath = tokens[++i] ?? '';
        const path = tokens[++i] ?? '';
        files.push({ path, oldPath, status });
      } else {
        const path = tokens[++i] ?? '';
        files.push({ path, status });
      }
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tok);
    if (m) {
      const binary = m[1] === '-' && m[2] === '-';
      if (m[3] === '') i += 2; // Rename: the next two tokens are the old and new paths
      stats.push({
        additions: binary ? undefined : Number(m[1]),
        deletions: binary ? undefined : Number(m[2]),
        binary,
      });
    }
  }
  for (let k = 0; k < files.length; k++) {
    const s = stats[k];
    if (!s) continue;
    files[k].additions = s.additions;
    files[k].deletions = s.deletions;
    if (s.binary) files[k].binary = true;
  }
  return files;
}
