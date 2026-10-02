import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemeRegistrationAny } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import type { SyntaxLanguage, SyntaxTheme } from '../../../shared/protocol';
import type { Tok } from './tokens';

// A thin wrapper around Shiki that runs inside the Worker. It does not use the DOM, so it can also run in Node unit tests.
// Regular expressions use the JavaScript engine (WASM Oniguruma needs 'wasm-unsafe-eval' in the CSP).
// Patterns it cannot handle are skipped with forgiving, and only that part is left uncolored.

/** Lines longer than this are not colored (so minified JS and the like do not take too long) */
const MAX_LINE_LENGTH = 2000;
/** Time limit for coloring one line (milliseconds) */
const LINE_TIME_LIMIT = 300;

export class SyntaxEngine {
  private highlighter?: Promise<HighlighterCore>;
  private readonly themeFg = new Map<string, string>();
  private readonly langs = new Set<string>();

  private core(): Promise<HighlighterCore> {
    this.highlighter ??= createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
    return this.highlighter;
  }

  async loadTheme(theme: SyntaxTheme): Promise<void> {
    if (this.themeFg.has(theme.key)) return;
    const h = await this.core();
    const reg: ThemeRegistrationAny = {
      name: theme.key,
      type: theme.type,
      fg: theme.fg,
      bg: theme.bg,
      colors: {
        ...(theme.fg ? { 'editor.foreground': theme.fg } : {}),
        ...(theme.bg ? { 'editor.background': theme.bg } : {}),
      },
      tokenColors: theme.tokenColors as ThemeRegistrationAny['tokenColors'],
    };
    await h.loadTheme(reg);
    this.themeFg.set(theme.key, normalizeColor(h.getTheme(theme.key).fg));
  }

  /** Load the set of grammars for a language. Register include targets and injection grammars first and the main one last */
  async loadLanguage(lang: SyntaxLanguage): Promise<void> {
    const name = langName(lang.id);
    if (this.langs.has(name)) return;
    const h = await this.core();
    const regs: LanguageRegistration[] = lang.grammars.map((g) => ({
      ...(g.grammar as object),
      name: g.scopeName === lang.scopeName ? name : g.scopeName,
      scopeName: g.scopeName,
      injectTo: g.injectTo,
    })) as LanguageRegistration[];
    const main = regs.filter((r) => r.scopeName === lang.scopeName);
    const deps = regs.filter((r) => r.scopeName !== lang.scopeName && !h.getLoadedLanguages().includes(r.name));
    await h.loadLanguage(...deps, ...main);
    this.langs.add(name);
  }

  /**
   * Color per chunk (a run of consecutive lines). The result is chunk -> line -> token.
   * Colors equal to the theme's default foreground are not applied (the webview uses VS Code's text color as it is).
   */
  async tokenize(langId: string, themeKey: string, blocks: string[][]): Promise<Tok[][][]> {
    const h = await this.core();
    const fg = this.themeFg.get(themeKey);
    return blocks.map((lines) => {
      if (lines.length === 0) return [];
      const result = h.codeToTokensBase(lines.join('\n'), {
        lang: langName(langId),
        theme: themeKey,
        tokenizeMaxLineLength: MAX_LINE_LENGTH,
        tokenizeTimeLimit: LINE_TIME_LIMIT,
      });
      return result.map((line) =>
        line.map((t) => {
          const tok: Tok = { len: t.content.length };
          const color = t.color ? normalizeColor(t.color) : undefined;
          if (color && color !== fg) tok.color = color;
          if (t.fontStyle && t.fontStyle > 0) tok.style = t.fontStyle;
          return tok;
        }),
      );
    });
  }

  /** Drop what was loaded when the theme or extensions change */
  reset(): void {
    const old = this.highlighter;
    this.highlighter = undefined;
    this.themeFg.clear();
    this.langs.clear();
    void old?.then((h) => h.dispose()).catch(() => undefined);
  }
}

/** Shiki language name. Include targets of grammars are registered by scope name, so a prefix is added to avoid collisions */
function langName(id: string): string {
  return `lang:${id}`;
}

function normalizeColor(c: string | undefined): string {
  return (c ?? '').toLowerCase();
}
