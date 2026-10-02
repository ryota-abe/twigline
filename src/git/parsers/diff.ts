// Parses the output of git diff (for one file) as bytes.
// Decoding to display text is done separately; patches are built from the bytes kept here.

export type RawLineKind = ' ' | '+' | '-';

export interface RawDiffLine {
  id: number;
  kind: RawLineKind;
  /** Content without the leading marker and the trailing \n. Includes the \r of CRLF */
  content: Buffer;
  /** Followed by "\ No newline at end of file" */
  noEol: boolean;
  oldNo?: number;
  newNo?: number;
}

export interface RawHunk {
  index: number;
  header: string;
  /** Raw bytes of the hunk header (to decode context such as function names with the file's encoding) */
  headerBytes: Buffer;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: RawDiffLine[];
}

export interface RawFileDiff {
  headerLines: Buffer[];
  hunks: RawHunk[];
  binary: boolean;
  newFile: boolean;
  deletedFile: boolean;
  modeChange: boolean;
  submodule: boolean;
  totalLines: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function splitLines(buf: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let from = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(from, i));
      from = i + 1;
    }
  }
  if (from < buf.length) lines.push(buf.subarray(from));
  return lines;
}

export function parseRawDiff(output: Buffer): RawFileDiff {
  const result: RawFileDiff = {
    headerLines: [],
    hunks: [],
    binary: false,
    newFile: false,
    deletedFile: false,
    modeChange: false,
    submodule: false,
    totalLines: 0,
  };
  const lines = splitLines(output);
  let hunk: RawHunk | undefined;
  let nextId = 0;
  let oldNo = 0;
  let newNo = 0;
  let seenFile = false;

  for (const line of lines) {
    const first = line[0];
    if (!hunk) {
      const text = line.toString('latin1');
      if (text.startsWith('diff --git ') || text.startsWith('diff --cc ')) {
        if (seenFile) break; // Ignore the second and later files
        seenFile = true;
      }
      if (text.startsWith('@@ ')) {
        hunk = startHunk(line, result.hunks.length);
        if (!hunk) continue;
        result.hunks.push(hunk);
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        continue;
      }
      result.headerLines.push(line);
      if (text.startsWith('Binary files ') || text.startsWith('GIT binary patch')) result.binary = true;
      else if (text.startsWith('new file mode ')) result.newFile = true;
      else if (text.startsWith('deleted file mode ')) result.deletedFile = true;
      else if (text.startsWith('old mode ') || text.startsWith('new mode ')) result.modeChange = true;
      else if (/^index [0-9a-f]+\.\.[0-9a-f]+ 160000/.test(text) || / 160000$/.test(text)) result.submodule = true;
      continue;
    }
    if (first === 0x40 /* @ */ && line.toString('latin1').startsWith('@@ ')) {
      const h = startHunk(line, result.hunks.length);
      if (h) {
        hunk = h;
        result.hunks.push(h);
        oldNo = h.oldStart;
        newNo = h.newStart;
      }
      continue;
    }
    if (first === 0x5c /* \ */) {
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noEol = true;
      continue;
    }
    if (first === 0x20 || first === 0x2b || first === 0x2d) {
      const kind = String.fromCharCode(first) as RawLineKind;
      const l: RawDiffLine = { id: nextId++, kind, content: line.subarray(1), noEol: false };
      if (kind === ' ') {
        l.oldNo = oldNo++;
        l.newNo = newNo++;
      } else if (kind === '-') {
        l.oldNo = oldNo++;
      } else {
        l.newNo = newNo++;
      }
      hunk.lines.push(l);
      continue;
    }
    if (line.toString('latin1').startsWith('diff --git ')) break;
    // Ignore everything else (blank lines, etc.)
  }
  result.totalLines = nextId;
  if (result.hunks.some((h) => h.lines.some((l) => /^Subproject commit /.test(l.content.toString('latin1'))))) {
    result.submodule = true;
  }
  return result;
}

function startHunk(line: Buffer, index: number): RawHunk | undefined {
  const header = line.toString('utf8');
  const m = HUNK_RE.exec(header);
  if (!m) return undefined;
  return {
    index,
    header,
    headerBytes: line,
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    lines: [],
  };
}
