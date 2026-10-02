// Sidebar filter. Keeps only names that contain all words separated by spaces (case-insensitive).

export function parseFilter(input: string): string[] {
  return input.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesFilter(name: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const lower = name.toLowerCase();
  return terms.every((term) => lower.includes(term));
}
