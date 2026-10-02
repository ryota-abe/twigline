// Group slash-separated names (branch names, file paths) into a tree of folders

export interface TreeNode<T> {
  name: string;
  /** Full path for a folder */
  path: string;
  children: TreeNode<T>[];
  item?: T;
}

export function buildTree<T>(items: T[], pathOf: (item: T) => string): TreeNode<T>[] {
  const root: TreeNode<T> = { name: '', path: '', children: [] };
  for (const item of items) {
    const parts = pathOf(item).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.item === undefined && c.name === name);
      if (!child) {
        child = { name, path, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ name: parts[parts.length - 1], path: pathOf(item), children: [], item });
  }
  sortTree(root);
  return compact(root.children);
}

function sortTree<T>(node: TreeNode<T>): void {
  node.children.sort((a, b) => {
    const af = a.item === undefined ? 0 : 1;
    const bf = b.item === undefined ? 0 : 1;
    return af - bf || a.name.localeCompare(b.name);
  });
  for (const c of node.children) sortTree(c);
}

/** Merge folders that have only one child (shown like src/auth) */
function compact<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return nodes.map((n) => {
    if (n.item !== undefined) return n;
    let cur = n;
    while (cur.children.length === 1 && cur.children[0].item === undefined) {
      const only = cur.children[0];
      cur = { name: `${cur.name}/${only.name}`, path: only.path, children: only.children };
    }
    return { ...cur, children: compact(cur.children) };
  });
}

/** List of leaves in display order (taking collapsing into account) */
export function flattenTree<T>(nodes: TreeNode<T>[], collapsed: ReadonlySet<string>, depth = 0, out: { node: TreeNode<T>; depth: number }[] = []) {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.item === undefined && !collapsed.has(n.path)) flattenTree(n.children, collapsed, depth + 1, out);
  }
  return out;
}
