/** A file of the repository as a path of the OS: with the separator the root uses (git's paths always have '/') */
export function absolutePath(root: string, rel: string): string {
  const windows = root.includes('\\') && !root.startsWith('/');
  const base = root.replace(/[\\/]+$/, '');
  return windows ? `${base}\\${rel.replace(/\//g, '\\')}` : `${base}/${rel}`;
}
