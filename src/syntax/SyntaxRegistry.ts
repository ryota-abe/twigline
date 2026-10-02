import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import type { SyntaxGrammar, SyntaxLanguage, SyntaxTheme, SyntaxTokenColor } from '../../shared/protocol';

// Collects grammars and color themes for syntax highlighting from the contributes of the extensions installed in VS Code.
// The VS Code API has no direct way to get a file's language or the theme JSON,
// so contributes.languages, grammars and themes are read here. It does not import vscode (the development server uses it too).

/** One extension (an element of vscode.extensions.all, or one read from an extension folder) */
export interface ExtensionSource {
  extensionPath: string;
  packageJSON: unknown;
}

export type ThemeKind = 'dark' | 'light' | 'hcDark' | 'hcLight';

/** editor.tokenColorCustomizations */
export type TokenColorCustomizations = Record<string, unknown>;

interface LanguageEntry {
  id: string;
  extensions: string[];
  filenames: string[];
  filenamePatterns: RegExp[];
}

interface GrammarEntry {
  language?: string;
  scopeName: string;
  file: string;
  injectTo?: string[];
}

interface ThemeEntry {
  id?: string;
  label: string;
  uiTheme: string;
  file: string;
}

/** Upper limit of the total grammars sent for one language. Keeps grammars that embed many languages, such as Markdown, from growing too large */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Default theme (when the configured theme is not found or cannot be read) */
const DEFAULT_THEMES: Record<ThemeKind, string> = {
  dark: 'Dark Modern',
  light: 'Light Modern',
  hcDark: 'Default High Contrast',
  hcLight: 'Default High Contrast Light',
};

/** The shorthand keys of tokenColorCustomizations and the scopes they refer to (tokenGroupToScopesMap of VS Code) */
const TOKEN_GROUPS: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

export class SyntaxRegistry {
  private readonly languages: LanguageEntry[] = [];
  private readonly grammars: GrammarEntry[] = [];
  private readonly themes: ThemeEntry[] = [];
  private readonly files = new Map<string, Promise<Record<string, unknown> | null>>();
  private readonly maxBytes: number;

  constructor(extensions: readonly ExtensionSource[], opts: { maxBytes?: number } = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    for (const ext of extensions) this.add(ext);
  }

  /** Read an extensions folder (such as resources/app/extensions of VS Code) */
  static scanDirectory(dir: string, readdir: (d: string) => string[]): ExtensionSource[] {
    const out: ExtensionSource[] = [];
    for (const name of readdir(dir)) {
      const extensionPath = path.join(dir, name);
      try {
        out.push({ extensionPath, packageJSON: JSON.parse(readFileSync(path.join(extensionPath, 'package.json'), 'utf8')) });
      } catch {
        // Skip folders without package.json (node_modules, etc.)
      }
    }
    return out;
  }

  private add(ext: ExtensionSource): void {
    const pkg = ext.packageJSON as { contributes?: Record<string, unknown> } | undefined;
    const c = pkg?.contributes;
    if (!c || typeof c !== 'object') return;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

    for (const l of arrayOf(c.languages)) {
      if (typeof l.id !== 'string') continue;
      this.languages.push({
        id: l.id,
        extensions: strings(l.extensions).map((e) => e.toLowerCase()),
        filenames: strings(l.filenames).map((f) => f.toLowerCase()),
        filenamePatterns: strings(l.filenamePatterns).map((pt) => globToRegExp(pt.includes('/') ? pt : `**/${pt}`)),
      });
    }
    for (const g of arrayOf(c.grammars)) {
      if (typeof g.scopeName !== 'string' || typeof g.path !== 'string') continue;
      this.grammars.push({
        language: typeof g.language === 'string' ? g.language : undefined,
        scopeName: g.scopeName,
        file: path.join(ext.extensionPath, g.path),
        injectTo: strings(g.injectTo).length > 0 ? strings(g.injectTo) : undefined,
      });
    }
    for (const t of arrayOf(c.themes)) {
      if (typeof t.path !== 'string') continue;
      const label = typeof t.label === 'string' ? localize(ext.extensionPath, t.label) : path.basename(t.path);
      this.themes.push({
        id: typeof t.id === 'string' ? t.id : undefined,
        label,
        uiTheme: typeof t.uiTheme === 'string' ? t.uiTheme : 'vs-dark',
        file: path.join(ext.extensionPath, t.path),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Language detection
  // -------------------------------------------------------------------------

  /**
   * Decide the language ID from a file path. The priority is the same as in VS Code:
   * files.associations -> filenames -> filenamePatterns -> extensions (longer match wins).
   * When several extensions claim it with the same strength, the one registered later (an extension the user installed) is used.
   */
  languageId(filePath: string, associations: Record<string, string> = {}): string | undefined {
    const full = filePath.replace(/\\/g, '/').toLowerCase();
    const base = full.slice(full.lastIndexOf('/') + 1);

    let assoc: string | undefined;
    for (const [pattern, id] of Object.entries(associations)) {
      if (typeof id !== 'string') continue;
      const re = globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`);
      if (re.test(full)) assoc = id;
    }
    if (assoc) return assoc;

    let byName: string | undefined;
    let byPattern: string | undefined;
    let byExt: string | undefined;
    let extLen = 0;
    for (const l of this.languages) {
      if (l.filenames.includes(base)) byName = l.id;
      if (l.filenamePatterns.some((re) => re.test(full))) byPattern = l.id;
      for (const e of l.extensions) {
        if (base.endsWith(e) && e.length >= extLen) {
          byExt = l.id;
          extLen = e.length;
        }
      }
    }
    return byName ?? byPattern ?? byExt;
  }

  // -------------------------------------------------------------------------
  // Grammars
  // -------------------------------------------------------------------------

  /** Detect the language of a file and return the set of grammars. For a language in loaded (already loaded by the webview), grammars are omitted */
  async resolve(filePath: string, loaded: readonly string[] = [], associations: Record<string, string> = {}): Promise<SyntaxLanguage | null> {
    const id = this.languageId(filePath, associations);
    if (!id) return null;
    if (loaded.includes(id)) {
      const main = findLast(this.grammars, (g) => g.language === id);
      return main ? { id, scopeName: main.scopeName, grammars: [] } : null;
    }
    return this.language(id);
  }

  /**
   * Return the grammar of a language together with the grammars of other languages it includes and injection grammars (injectTo).
   * Dependencies beyond maxBytes in total are omitted (only that part is not colored).
   */
  async language(languageId: string): Promise<SyntaxLanguage | null> {
    const main = findLast(this.grammars, (g) => g.language === languageId);
    if (!main) return null;
    const mainJson = await this.readJson(main.file);
    if (!mainJson) return null;

    const out: SyntaxGrammar[] = [{ scopeName: main.scopeName, grammar: mainJson }];
    const seen = new Set([main.scopeName]);
    let bytes = jsonSize(mainJson);
    const queue = [...externalScopes(mainJson)];

    const tryAdd = async (entry: GrammarEntry): Promise<boolean> => {
      const json = await this.readJson(entry.file);
      if (!json) return false;
      const size = jsonSize(json);
      if (bytes + size > this.maxBytes) return false;
      bytes += size;
      out.push({ scopeName: entry.scopeName, injectTo: entry.injectTo, grammar: json });
      queue.push(...externalScopes(json));
      return true;
    };

    // Collect include targets breadth-first, then add injection grammars for the scopes that were loaded (also follow their include targets)
    for (;;) {
      while (queue.length > 0) {
        const scope = queue.shift()!;
        if (seen.has(scope)) continue;
        seen.add(scope);
        const entry = findLast(this.grammars, (g) => g.scopeName === scope);
        if (entry) await tryAdd(entry);
      }
      const injections = this.grammars.filter((g) => g.injectTo?.some((s) => seen.has(s)) && !seen.has(g.scopeName));
      if (injections.length === 0) break;
      for (const g of injections) {
        seen.add(g.scopeName);
        await tryAdd(g);
      }
    }
    return { id: languageId, scopeName: main.scopeName, grammars: out };
  }

  // -------------------------------------------------------------------------
  // Color themes
  // -------------------------------------------------------------------------

  /**
   * Extract token colors from theme names in settings (workbench.colorTheme etc., in order of candidates).
   * Among the candidates, prefer one matching the current kind; if none can be read, use the default theme of that kind.
   */
  async theme(candidates: (string | undefined)[], kind: ThemeKind, customizations?: TokenColorCustomizations): Promise<SyntaxTheme | null> {
    const found = candidates.filter((c): c is string => !!c).map((c) => this.findTheme(c)).filter((t): t is ThemeEntry => !!t);
    const ordered = [...found.filter((t) => themeKind(t.uiTheme) === kind), ...found];
    const fallback = this.findTheme(DEFAULT_THEMES[kind]);
    if (fallback) ordered.push(fallback);
    for (const entry of ordered) {
      const loaded = await this.loadTheme(entry.file, new Set());
      if (!loaded || loaded.tokenColors.length === 0) continue;
      const tokenColors = [...loaded.tokenColors, ...customRules(customizations, entry)];
      const type = themeKind(entry.uiTheme) === 'light' || themeKind(entry.uiTheme) === 'hcLight' ? 'light' : 'dark';
      const body = { name: entry.id ?? entry.label, type, fg: loaded.fg, bg: loaded.bg, tokenColors } as const;
      const key = createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
      return { key, ...body };
    }
    return null;
  }

  private findTheme(settingsId: string): ThemeEntry | undefined {
    const want = settingsId.trim();
    // A default theme may appear in settings with a "Default " prefix, as in "Default Dark Modern"
    const alt = want.replace(/^Default /, '');
    return (
      findLast(this.themes, (t) => t.id === want || t.label === want) ??
      findLast(this.themes, (t) => t.id === alt || t.label === alt)
    );
  }

  /** Read a theme's JSON following include. The tokenColors of the included file come first, then its own */
  private async loadTheme(file: string, visiting: Set<string>): Promise<{ tokenColors: SyntaxTokenColor[]; fg?: string; bg?: string } | null> {
    if (visiting.has(file)) return null;
    visiting.add(file);
    const json = await this.readJson(file);
    if (!json) return null;
    let tokenColors: SyntaxTokenColor[] = [];
    let fg: string | undefined;
    let bg: string | undefined;
    if (typeof json.include === 'string') {
      const inc = await this.loadTheme(path.join(path.dirname(file), json.include), visiting);
      if (inc) ({ tokenColors, fg, bg } = inc);
    }
    let own: unknown = json.tokenColors ?? json.settings;
    if (typeof own === 'string') {
      // A theme that points tokenColors to another file. .tmTheme (plist) is not read
      const sub = /\.json$/i.test(own) ? await this.readJson(path.join(path.dirname(file), own)) : null;
      own = sub ? (sub.tokenColors ?? sub.settings) : undefined;
    }
    tokenColors = [...tokenColors, ...arrayOf(own).filter(isTokenColor)];
    const colors = (json.colors ?? {}) as Record<string, unknown>;
    if (typeof colors['editor.foreground'] === 'string') fg = colors['editor.foreground'];
    if (typeof colors['editor.background'] === 'string') bg = colors['editor.background'];
    return { tokenColors, fg, bg };
  }

  private readJson(file: string): Promise<Record<string, unknown> | null> {
    let p = this.files.get(file);
    if (!p) {
      p = (async () => {
        // plist formats (.tmLanguage, .tmTheme) are not supported
        if (!/\.json$/i.test(file)) return null;
        try {
          const v = parseJsonc(await readFile(file, 'utf8'), [], { allowTrailingComma: true });
          return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      })();
      this.files.set(file, p);
    }
    return p;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLast<T>(list: readonly T[], pred: (v: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i];
  return undefined;
}

function arrayOf(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

function isTokenColor(v: Record<string, unknown>): v is Record<string, unknown> & SyntaxTokenColor {
  return !!v.settings && typeof v.settings === 'object';
}

function jsonSize(v: unknown): number {
  return JSON.stringify(v).length;
}

/** Turn uiTheme (vs, vs-dark, hc-black, hc-light) into a theme kind */
export function themeKind(uiTheme: string): ThemeKind {
  if (uiTheme === 'vs') return 'light';
  if (uiTheme === 'hc-light') return 'hcLight';
  if (uiTheme === 'hc-black') return 'hcDark';
  return 'dark';
}

/** Replace %key% from package.nls.json (the packageJSON of vscode.extensions may be unreplaced) */
function localize(extensionPath: string, value: string): string {
  const m = /^%(.+)%$/.exec(value);
  if (!m) return value;
  try {
    const nls = JSON.parse(readFileSync(path.join(extensionPath, 'package.nls.json'), 'utf8')) as Record<string, unknown>;
    const v = nls[m[1]];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string') return (v as { message: string }).message;
  } catch {
    // Without nls, keep the key as is
  }
  return value;
}

/** Collect the scopes of other grammars a grammar refers to (include: "source.js" or "source.css#rule") */
export function externalScopes(grammar: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'include' && typeof x === 'string') {
        if (x.startsWith('#') || x === '$self' || x === '$base') continue;
        const scope = x.split('#')[0];
        if (scope) out.add(scope);
      } else {
        walk(x);
      }
    }
  };
  walk(grammar);
  return out;
}

/** Turn editor.tokenColorCustomizations into a list of textMateRules. A [name] block in a theme name applies only to that theme */
function customRules(custom: TokenColorCustomizations | undefined, theme: ThemeEntry): SyntaxTokenColor[] {
  if (!custom || typeof custom !== 'object') return [];
  const out: SyntaxTokenColor[] = [];
  const apply = (block: Record<string, unknown>) => {
    for (const [group, scopes] of Object.entries(TOKEN_GROUPS)) {
      const v = block[group];
      if (typeof v === 'string') out.push({ scope: scopes, settings: { foreground: v } });
      else if (v && typeof v === 'object') {
        const s = v as { foreground?: unknown; fontStyle?: unknown };
        out.push({
          scope: scopes,
          settings: {
            foreground: typeof s.foreground === 'string' ? s.foreground : undefined,
            fontStyle: typeof s.fontStyle === 'string' ? s.fontStyle : undefined,
          },
        });
      }
    }
    out.push(...arrayOf(block.textMateRules).filter(isTokenColor));
  };
  apply(custom);
  for (const [k, v] of Object.entries(custom)) {
    const m = /^\[(.+)\]$/.exec(k);
    if (!m || !v || typeof v !== 'object') continue;
    const names = m[1].split(/\]\s*\[/).map((s) => s.trim());
    if (names.some((n) => n === theme.id || n === theme.label || n === `Default ${theme.id}`)) apply(v as Record<string, unknown>);
  }
  return out;
}

/** Turn a VS Code glob (**, *, ?, {a,b}) into a regular expression. Case-insensitive */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inBrace = false;
  const g = glob.replace(/\\/g, '/').toLowerCase();
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      inBrace = true;
      re += '(?:';
    } else if (ch === '}' && inBrace) {
      inBrace = false;
      re += ')';
    } else if (ch === ',' && inBrace) re += '|';
    else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
