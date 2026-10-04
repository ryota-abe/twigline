import { describe, expect, it } from 'vitest';
import type { RefInfo } from '../../shared/protocol';
import { deleteInfo, safeToDelete } from '../../webview/src/util/branchDelete';

const head = (extra: Partial<RefInfo> = {}): RefInfo => ({ kind: 'head', name: 'x', fullName: 'refs/heads/x', sha: 'a'.repeat(40), ...extra });

describe('deleteInfo', () => {
  it('checks a branch without an upstream against HEAD, like git branch -d', () => {
    expect(deleteInfo(head(), 0)).toEqual({ unmerged: 0, unpushed: undefined, forceRequired: false, atRisk: 0 });
    expect(deleteInfo(head(), 3)).toEqual({ unmerged: 3, unpushed: undefined, forceRequired: true, atRisk: 3 });
    // A deleted upstream counts as none
    expect(deleteInfo(head({ upstream: 'origin/x', gone: true }), 2)).toMatchObject({ unpushed: undefined, forceRequired: true, atRisk: 2 });
    // Not known yet: nothing is required
    expect(deleteInfo(head(), undefined)).toMatchObject({ forceRequired: false, atRisk: 0 });
  });

  it('checks a branch with an upstream against the upstream, even when HEAD has merged it', () => {
    // Merged into HEAD but 1 commit not pushed: git branch -d refuses it
    expect(deleteInfo(head({ upstream: 'origin/x', ahead: 1 }), 0)).toEqual({ unmerged: 0, unpushed: 1, forceRequired: true, atRisk: 0 });
    // Pushed but not merged into HEAD: -d deletes it, and the commits remain on the remote
    expect(deleteInfo(head({ upstream: 'origin/x', ahead: 0 }), 4)).toEqual({ unmerged: 4, unpushed: 0, forceRequired: false, atRisk: 0 });
    // Neither: the unpushed ones that HEAD lacks may be lost
    expect(deleteInfo(head({ upstream: 'origin/x', ahead: 2 }), 5)).toMatchObject({ forceRequired: true, atRisk: 2 });
  });

  it('selects as merged only what -d deletes and HEAD has', () => {
    expect(safeToDelete(deleteInfo(head(), 0))).toBe(true);
    expect(safeToDelete(deleteInfo(head({ upstream: 'origin/x', ahead: 1 }), 0))).toBe(false);
    expect(safeToDelete(deleteInfo(head({ upstream: 'origin/x', ahead: 0 }), 4))).toBe(false);
    expect(safeToDelete(deleteInfo(head(), undefined))).toBe(false);
  });
});
