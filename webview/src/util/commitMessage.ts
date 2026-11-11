// Commit message helpers for the commit box.

/**
 * The message to commit: what was typed, without the comment lines ('#') of the commit template (commit.template).
 * git removes every '#' line of a message edited from a template; here only the lines the template itself has are removed,
 * so a line the user wrote, such as "#123 Fix login", stays. Blank lines left at either end are dropped.
 */
export function effectiveCommitMessage(message: string, template: string | undefined): string {
  if (!template) return message;
  const comments = new Set(
    template
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.startsWith('#')),
  );
  if (comments.size === 0) return message;
  return message
    .split('\n')
    .filter((l) => !comments.has(l.trimEnd()))
    .join('\n')
    .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
}

/** Escape a path so that a .gitignore line matches exactly that path (wildcards, brackets, backslashes and trailing spaces) */
export function escapeGitignore(path: string): string {
  return path.replace(/[\\*?[]/g, '\\$&').replace(/ +$/, (sp) => '\\ '.repeat(sp.length));
}
