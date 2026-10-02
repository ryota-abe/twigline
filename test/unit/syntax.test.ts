import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiffHunk, FileDiff } from '../../shared/protocol';
import { SyntaxRegistry, externalScopes, globToRegExp } from '../../src/syntax/SyntaxRegistry';
import { SyntaxEngine } from '../../webview/src/syntax/engine';
import { diffBlocks, mergeHighlights, tokensByLine, type Tok } from '../../webview/src/syntax/tokens';

// Syntax highlighting: collecting grammars and themes from extensions' contributes, coloring in the Worker, and overlaying on diffs.

let root: string;

function writeJson(file: string, v: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(v));
}

/** Create folders that stand in for built-in extensions */
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'twigline-syntax-'));
  writeJson(path.join(root, 'demo/package.json'), {
    contributes: {
      languages: [
        { id: 'demo', extensions: ['.demo'], filenames: ['Demofile'] },
        { id: 'demo-test', extensions: ['.test.demo'] },
        { id: 'inner', extensions: ['.inner'] },
      ],
      grammars: [
        { language: 'demo', scopeName: 'source.demo', path: './demo.json' },
        { language: 'inner', scopeName: 'source.inner', path: './inner.json' },
        { scopeName: 'demo.injection', path: './injection.json', injectTo: ['source.demo'] },
        { language: 'demo-test', scopeName: 'source.demo-test', path: './demo.tmLanguage' },
      ],
    },
  });
  writeJson(path.join(root, 'demo/demo.json'), {
    scopeName: 'source.demo',
    patterns: [
      { match: '\\b(let|if)\\b', name: 'keyword.control.demo' },
      { begin: '"', end: '"', name: 'string.quoted.demo' },
      { begin: '/\\*', end: '\\*/', name: 'comment.block.demo' },
      { begin: '<<', end: '>>', patterns: [{ include: 'source.inner#value' }] },
    ],
  });
  writeJson(path.join(root, 'demo/inner.json'), {
    scopeName: 'source.inner',
    patterns: [{ include: '#value' }],
    repository: { value: { match: '\\d+', name: 'constant.numeric.inner' } },
  });
  writeJson(path.join(root, 'demo/injection.json'), { scopeName: 'demo.injection', injectionSelector: 'L:source.demo', patterns: [{ match: 'TODO', name: 'keyword.todo' }] });
  writeFileSync(path.join(root, 'demo/demo.tmLanguage'), '<plist></plist>');

  // When an extension installed by the user (registered later) takes over .demo
  writeJson(path.join(root, 'zz-user/package.json'), {
    contributes: { languages: [{ id: 'demo2', filenamePatterns: ['**/special/*.demo'] }] },
  });

  writeJson(path.join(root, 'themes/package.json'), {
    contributes: {
      themes: [
        { id: 'Dark Modern', label: '%dark%', uiTheme: 'vs-dark', path: './dark_modern.json' },
        { id: 'Light Modern', label: 'Light Modern', uiTheme: 'vs', path: './light.json' },
        { label: 'Old', uiTheme: 'vs-dark', path: './old.json' },
      ],
    },
  });
  writeJson(path.join(root, 'themes/package.nls.json'), { dark: 'Dark Modern Label' });
  writeJson(path.join(root, 'themes/dark_plus.json'), {
    colors: { 'editor.foreground': '#D4D4D4' },
    tokenColors: [
      { scope: 'keyword.control', settings: { foreground: '#C586C0' } },
      { scope: 'string', settings: { foreground: '#CE9178' } },
    ],
  });
  // A theme written in JSONC (comments, trailing commas) that follows include
  mkdirSync(path.join(root, 'themes'), { recursive: true });
  writeFileSync(
    path.join(root, 'themes/dark_modern.json'),
    `{
      // comment
      "include": "./dark_plus.json",
      "colors": { "editor.background": "#1F1F1F", },
      "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#6A9955", "fontStyle": "italic" } }],
    }`,
  );
  writeJson(path.join(root, 'themes/light.json'), { tokenColors: [{ scope: 'keyword', settings: { foreground: '#0000FF' } }] });
  writeJson(path.join(root, 'themes/old.json'), { tokenColors: './old.tmTheme' });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const registry = () => new SyntaxRegistry(SyntaxRegistry.scanDirectory(root, (d) => readdirSync(d)));

describe('SyntaxRegistry: language detection', () => {
  it('decides in the order file name -> pattern -> extension (longer match wins)', () => {
    const r = registry();
    expect(r.languageId('/repo/src/a.demo')).toBe('demo');
    expect(r.languageId('C:\\repo\\src\\A.DEMO')).toBe('demo');
    expect(r.languageId('/repo/a.test.demo')).toBe('demo-test');
    expect(r.languageId('/repo/Demofile')).toBe('demo');
    expect(r.languageId('/repo/special/a.demo')).toBe('demo2');
    expect(r.languageId('/repo/readme.txt')).toBeUndefined();
  });

  it('gives files.associations the highest priority', () => {
    const r = registry();
    expect(r.languageId('/repo/a.txt', { '*.txt': 'inner' })).toBe('inner');
    expect(r.languageId('/repo/cfg/a.demo', { '**/cfg/*.demo': 'inner' })).toBe('inner');
  });

  it('turns a glob into a regular expression', () => {
    expect(globToRegExp('**/*.{ts,tsx}').test('src/a/b.tsx')).toBe(true);
    expect(globToRegExp('**/*.{ts,tsx}').test('b.ts')).toBe(true);
    expect(globToRegExp('*.md').test('a/b.md')).toBe(false);
    expect(globToRegExp('a?.md').test('ab.md')).toBe(true);
  });
});

describe('SyntaxRegistry: grammars', () => {
  it('returns include targets and injection grammars together', async () => {
    const lang = await registry().language('demo');
    expect(lang?.scopeName).toBe('source.demo');
    expect(lang?.grammars.map((g) => g.scopeName).sort()).toEqual(['demo.injection', 'source.demo', 'source.inner']);
    expect(lang?.grammars.find((g) => g.scopeName === 'demo.injection')?.injectTo).toEqual(['source.demo']);
  });

  it('omits dependencies beyond the total limit (the main grammar is always included)', async () => {
    const small = new SyntaxRegistry(SyntaxRegistry.scanDirectory(root, (d) => readdirSync(d)), { maxBytes: 10 });
    const lang = await small.language('demo');
    expect(lang?.grammars.map((g) => g.scopeName)).toEqual(['source.demo']);
  });

  it('returns null for plist grammars and languages without a grammar', async () => {
    const r = registry();
    expect(await r.language('demo-test')).toBeNull();
    expect(await r.language('demo2')).toBeNull();
  });

  it('omits grammars for languages already loaded', async () => {
    const r = registry();
    const full = await r.resolve('/repo/a.demo', []);
    expect(full?.grammars.length).toBe(3);
    const known = await r.resolve('/repo/a.demo', ['demo']);
    expect(known).toEqual({ id: 'demo', scopeName: 'source.demo', grammars: [] });
  });

  it('collects includes of external scopes', () => {
    const scopes = externalScopes({ patterns: [{ include: '#x' }, { include: '$self' }, { include: 'source.js' }, { include: 'source.css#rule' }] });
    expect([...scopes].sort()).toEqual(['source.css', 'source.js']);
  });
});

describe('SyntaxRegistry: color themes', () => {
  it('follows include, reads JSONC, and puts the colors of the include target first', async () => {
    const theme = await registry().theme(['Default Dark Modern'], 'dark');
    expect(theme?.name).toBe('Dark Modern');
    expect(theme?.type).toBe('dark');
    expect(theme?.fg).toBe('#D4D4D4');
    expect(theme?.bg).toBe('#1F1F1F');
    expect(theme?.tokenColors.map((t) => t.scope)).toEqual(['keyword.control', 'string', 'comment']);
  });

  it('also finds a theme by its nls label', async () => {
    expect((await registry().theme(['Dark Modern Label'], 'dark'))?.name).toBe('Dark Modern');
  });

  it('prefers a candidate matching the current kind, and uses the default theme if it cannot be read', async () => {
    const r = registry();
    expect((await r.theme(['Dark Modern', 'Light Modern'], 'light'))?.name).toBe('Light Modern');
    // A theme that points to a tmTheme, or a theme that does not exist -> the default theme
    expect((await r.theme(['Old'], 'dark'))?.name).toBe('Dark Modern');
    expect((await r.theme(['Nope'], 'light'))?.name).toBe('Light Modern');
  });

  it('adds editor.tokenColorCustomizations at the end, and the key changes when the content changes', async () => {
    const r = registry();
    const plain = await r.theme(['Dark Modern'], 'dark');
    const custom = await r.theme(['Dark Modern'], 'dark', {
      comments: '#00FF00',
      textMateRules: [{ scope: 'keyword', settings: { foreground: '#FF0000' } }],
      '[Light Modern]': { strings: '#000000' },
      '[Dark Modern]': { numbers: { foreground: '#123456', fontStyle: 'bold' } },
    });
    const extra = custom!.tokenColors.slice(plain!.tokenColors.length);
    expect(extra).toEqual([
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#00FF00' } },
      { scope: 'keyword', settings: { foreground: '#FF0000' } },
      { scope: ['constant.numeric'], settings: { foreground: '#123456', fontStyle: 'bold' } },
    ]);
    expect(custom!.key).not.toBe(plain!.key);
  });
});

// ---------------------------------------------------------------------------
// Overlaying on diffs
// ---------------------------------------------------------------------------

function makeDiff(lines: [kind: ' ' | '-' | '+', text: string][]): FileDiff {
  let id = 0;
  const hunk: DiffHunk = {
    index: 0,
    header: '@@',
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: 0,
    lines: lines.map(([kind, text]) => ({ id: id++, kind, text })),
  };
  return {
    diffId: 'd',
    fingerprint: 'f',
    path: 'a.demo',
    target: { kind: 'worktree' },
    binary: false,
    truncated: false,
    totalLines: lines.length,
    encoding: 'utf8',
    fileMode: 'modified',
    lineOps: true,
    hunks: [hunk],
  };
}

describe('diff chunks', () => {
  it('splits into before (context + deleted) and after (context + added), and context lines use the "after" side', () => {
    const diff = makeDiff([
      [' ', 'a'],
      ['-', 'b'],
      ['+', 'B'],
      [' ', 'c'],
    ]);
    const { blocks, where } = diffBlocks(diff);
    expect(blocks).toEqual([
      ['a', 'b', 'c'],
      ['a', 'B', 'c'],
    ]);
    expect([...where.entries()]).toEqual([
      [0, [1, 0]],
      [1, [0, 1]],
      [2, [1, 1]],
      [3, [1, 2]],
    ]);
  });

  it('drops tokens whose length does not match', () => {
    const diff = makeDiff([['+', 'abc']]);
    const { where } = diffBlocks(diff);
    expect(tokensByLine(diff, where, [[], [[{ len: 3 }]]]).get(0)).toEqual([{ len: 3 }]);
    expect(tokensByLine(diff, where, [[], [[{ len: 2 }]]]).has(0)).toBe(false);
  });
});

describe('mergeHighlights', () => {
  const toks: Tok[] = [{ len: 3, color: '#f00' }, { len: 1 }, { len: 5, color: '#0f0', style: 2 }];
  const text = 'let x=12;';

  it('tokens only', () => {
    expect(mergeHighlights(text, toks, undefined)).toEqual([
      {
        changed: false,
        pieces: [
          { text: 'let', color: '#f00', style: undefined },
          { text: ' ', color: undefined, style: undefined },
          { text: 'x=12;', color: '#0f0', style: 2 },
        ],
      },
    ]);
  });

  it('splits tokens at the boundaries of word highlights', () => {
    const groups = mergeHighlights(text, toks, [
      { text: 'let x', changed: false },
      { text: '=12', changed: true },
      { text: ';', changed: false },
    ]);
    expect(groups.map((g) => [g.changed, g.pieces.map((p) => `${p.text}|${p.color ?? ''}`)])).toEqual([
      [false, ['let|#f00', ' |', 'x|#0f0']],
      [true, ['=12|#0f0']],
      [false, [';|#0f0']],
    ]);
  });

  it('highlights only', () => {
    expect(mergeHighlights('ab', undefined, [{ text: 'a', changed: true }, { text: 'b', changed: false }])).toEqual([
      { changed: true, pieces: [{ text: 'a' }] },
      { changed: false, pieces: [{ text: 'b' }] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Coloring in the Worker (Shiki)
// ---------------------------------------------------------------------------

describe('SyntaxEngine', () => {
  it('loads the theme and grammars and colors per chunk (state across lines, include targets, injection grammars)', async () => {
    const r = registry();
    const engine = new SyntaxEngine();
    const theme = (await r.theme(['Dark Modern'], 'dark'))!;
    const custom = { ...theme, key: 'k2', tokenColors: [...theme.tokenColors, { scope: ['constant.numeric', 'keyword.todo'], settings: { foreground: '#B5CEA8' } }] };
    await engine.loadTheme(custom);
    await engine.loadLanguage((await r.language('demo'))!);

    const [block] = await engine.tokenize('demo', 'k2', [['let x = "s"', '/* a', 'b */ if <<42>> TODO']]);
    const colored = (line: number, s: string) => {
      const src = ['let x = "s"', '/* a', 'b */ if <<42>> TODO'][line];
      let pos = 0;
      for (const t of block[line]) {
        const piece = src.slice(pos, pos + t.len);
        if (piece === s) return t;
        pos += t.len;
      }
      throw new Error(`no token ${s} in ${JSON.stringify(block[line])}`);
    };
    expect(colored(0, 'let').color).toBe('#c586c0');
    // Does not color when it equals the default text color
    expect(colored(0, ' x = ').color).toBeUndefined();
    expect(colored(0, '"s"').color).toBe('#ce9178');
    // A comment continuing from the previous line
    expect(colored(1, '/* a')).toMatchObject({ color: '#6a9955', style: 1 });
    expect(colored(2, 'b */')).toMatchObject({ color: '#6a9955', style: 1 });
    expect(colored(2, 'if').color).toBe('#c586c0');
    // Include targets (source.inner#value) and injection grammars
    expect(colored(2, '42').color).toBe('#b5cea8');
    expect(colored(2, 'TODO').color).toBe('#b5cea8');
    engine.reset();
  });

  it('empty chunks and languages that are not loaded', async () => {
    const r = registry();
    const engine = new SyntaxEngine();
    const theme = (await r.theme(['Dark Modern'], 'dark'))!;
    await engine.loadTheme(theme);
    expect(await engine.tokenize('demo', theme.key, [[]])).toEqual([[]]);
    await expect(engine.tokenize('nope', theme.key, [['x']])).rejects.toThrow();
  });
});
