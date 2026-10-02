import { describe, expect, it } from 'vitest';
import { matchesFilter, parseFilter } from '../../webview/src/util/sidebarFilter';

describe('sidebar filter', () => {
  it('matches case-insensitively and requires every word', () => {
    const terms = parseFilter('  Feat  login ');
    expect(terms).toEqual(['feat', 'login']);
    expect(matchesFilter('feature/user-Login', terms)).toBe(true);
    expect(matchesFilter('feature/signup', terms)).toBe(false);
  });

  it('keeps everything when the input is blank', () => {
    expect(parseFilter('   ')).toEqual([]);
    expect(matchesFilter('main', parseFilter(''))).toBe(true);
  });
});
