import type { LogRow } from '../../../shared/protocol';

/** Format of git log. Fields are separated by %x1f and records by the NUL of -z. */
export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s';

const US = 0x1f;

/** Turn one record (one NUL-separated piece) into a LogRow. A broken record gives undefined. */
export function parseLogRecord(record: Buffer): LogRow | undefined {
  // Skip the leading newline (the tformat separator)
  let start = 0;
  while (start < record.length && (record[start] === 0x0a || record[start] === 0x0d)) start++;
  if (start >= record.length) return undefined;
  const fields: string[] = [];
  let from = start;
  for (let i = start; i < record.length && fields.length < 5; i++) {
    if (record[i] === US) {
      fields.push(record.toString('utf8', from, i));
      from = i + 1;
    }
  }
  if (fields.length < 5) return undefined;
  let end = record.length;
  while (end > from && (record[end - 1] === 0x0a || record[end - 1] === 0x0d)) end--;
  const subject = record.toString('utf8', from, end);
  const [sha, parents, author, email, time] = fields;
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
  return {
    sha,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    author,
    email,
    authorTime: Number(time) || 0,
    subject,
  };
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
