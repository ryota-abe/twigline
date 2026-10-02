import type { LogQuery } from '../../../shared/protocol';

// One search box in history, with a prefix choosing the kind of search (author:, content:, path:, sha:).
// Without a prefix it searches messages; a hex number of 7 or more digits alone jumps to that commit.

export type SearchInput =
  | { kind: 'clear' }
  | { kind: 'jump'; rev: string }
  | { kind: 'path'; path: string }
  | { kind: 'search'; search: NonNullable<LogQuery['search']> };

const PREFIX = /^(message|author|content|path|sha)\s*[:：]\s*(.*)$/is;

export function parseSearch(input: string): SearchInput {
  const text = input.trim();
  if (!text) return { kind: 'clear' };
  const m = PREFIX.exec(text);
  if (m) {
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) return { kind: 'clear' };
    if (key === 'sha') return { kind: 'jump', rev: value };
    if (key === 'path') return { kind: 'path', path: value.replace(/\\/g, '/') };
    return { kind: 'search', search: { mode: key as 'message' | 'author' | 'content', text: value } };
  }
  if (/^[0-9a-f]{7,64}$/i.test(text)) return { kind: 'jump', rev: text };
  return { kind: 'search', search: { mode: 'message', text } };
}

/** Turn the search conditions back into the text of the search box */
export function formatSearch(search: LogQuery['search']): string {
  if (!search) return '';
  return search.mode === 'message' ? search.text : `${search.mode}:${search.text}`;
}
