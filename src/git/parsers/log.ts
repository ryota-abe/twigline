import type { CoAuthor, LogRow } from '../../../shared/protocol';

/**
 * The Co-authored-by trailers of a commit, separated by %x1e (git matches the key regardless of case).
 * Trailers folded onto several lines are joined into one.
 */
export const CO_AUTHORS_FORMAT = '%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1e)';

/** Format of git log. Fields are separated by %x1f and records by the NUL of -z. The subject is last as it is read to the end */
export const LOG_FORMAT = `%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f${CO_AUTHORS_FORMAT}%x1f%s`;

const US = 0x1f;
const FIELDS = 6;

/**
 * Turn the output of CO_AUTHORS_FORMAT into people. "Name <email>" and a bare name are accepted.
 * The author (same email, or same name when there is no email) and people already listed are left out.
 * undefined when nobody is left, so rows without co-authors carry nothing.
 */
export function parseCoAuthors(raw: string, author: string, authorEmail: string): CoAuthor[] | undefined {
  if (!raw) return undefined;
  const seen = new Set<string>([personKey(author, authorEmail)]);
  const out: CoAuthor[] = [];
  for (const part of raw.split('\x1e')) {
    const value = part.trim();
    if (!value) continue;
    const m = /^(.*?)\s*<([^<>]*)>$/.exec(value);
    const name = (m ? m[1] : value).trim();
    const email = m ? m[2].trim() : '';
    if (!name && !email) continue;
    const key = personKey(name, email);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || email, email });
  }
  return out.length > 0 ? out : undefined;
}

function personKey(name: string, email: string): string {
  return email ? `e:${email.toLowerCase()}` : `n:${name.trim().toLowerCase()}`;
}

/** Turn one record (one NUL-separated piece) into a LogRow. A broken record gives undefined. */
export function parseLogRecord(record: Buffer): LogRow | undefined {
  // Skip the leading newline (the tformat separator)
  let start = 0;
  while (start < record.length && (record[start] === 0x0a || record[start] === 0x0d)) start++;
  if (start >= record.length) return undefined;
  const fields: string[] = [];
  let from = start;
  for (let i = start; i < record.length && fields.length < FIELDS; i++) {
    if (record[i] === US) {
      fields.push(record.toString('utf8', from, i));
      from = i + 1;
    }
  }
  if (fields.length < FIELDS) return undefined;
  let end = record.length;
  while (end > from && (record[end - 1] === 0x0a || record[end - 1] === 0x0d)) end--;
  const subject = record.toString('utf8', from, end);
  const [sha, parents, author, email, time, trailers] = fields;
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
  const row: LogRow = {
    sha,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    author,
    email,
    authorTime: Number(time) || 0,
    subject,
  };
  const coAuthors = parseCoAuthors(trailers, author, email);
  if (coAuthors) row.coAuthors = coAuthors;
  return row;
}

/** Parse a whole chunk of output (for tests and small lists) */
export function parseLog(output: Buffer): LogRow[] {
  const rows: LogRow[] = [];
  let from = 0;
  for (let i = 0; i <= output.length; i++) {
    if (i === output.length || output[i] === 0) {
      if (i > from) {
        const row = parseLogRecord(output.subarray(from, i));
        if (row) rows.push(row);
      }
      from = i + 1;
    }
  }
  return rows;
}

/**
 * Split the bytes arriving from a stream into records at NUL.
 * The last incomplete record is carried over to the next chunk.
 */
export class NulRecordSplitter {
  private pending: Buffer[] = [];

  push(chunk: Buffer, onRecord: (record: Buffer) => void): void {
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) {
        const part = chunk.subarray(from, i);
        if (this.pending.length > 0) {
          this.pending.push(part);
          onRecord(Buffer.concat(this.pending));
          this.pending = [];
        } else {
          onRecord(part);
        }
        from = i + 1;
      }
    }
    if (from < chunk.length) this.pending.push(Buffer.from(chunk.subarray(from)));
  }

  flush(onRecord: (record: Buffer) => void): void {
    if (this.pending.length > 0) {
      onRecord(Buffer.concat(this.pending));
      this.pending = [];
    }
  }
}
