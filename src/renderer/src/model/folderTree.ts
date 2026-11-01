import type { EntryStatus, FolderNode } from '../../../shared/api';

export interface FolderRow {
  node: FolderNode;
  depth: number;
  /** Has children to expand: a folder on at least one side. */
  isDir: boolean;
  expanded: boolean;
}

/** The visible rows: children of expanded folders, optionally without identical entries. */
export function flattenTree(root: FolderNode, expanded: ReadonlySet<string>, hideSame: boolean): FolderRow[] {
  const rows: FolderRow[] = [];
  const walk = (node: FolderNode, depth: number) => {
    for (const child of node.children ?? []) {
      if (hideSame && child.status === 'same') continue;
      const isDir = !!child.children;
      const open = isDir && expanded.has(child.relPath);
      rows.push({ node: child, depth, isDir, expanded: open });
      if (open) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** How many files (not folders) fall into each status. */
export function countFiles(root: FolderNode): Record<EntryStatus, number> {
  const counts: Record<EntryStatus, number> = { same: 0, different: 0, 'left-only': 0, 'right-only': 0, 'kind-mismatch': 0 };
  const walk = (node: FolderNode) => {
    for (const c of node.children ?? []) {
      if (c.children && c.status !== 'kind-mismatch') walk(c);
      else counts[c.status]++;
    }
  };
  walk(root);
  return counts;
}

/** Every folder's path, for "expand all". */
export function folderPaths(root: FolderNode): string[] {
  const out: string[] = [];
  const walk = (node: FolderNode) => {
    for (const c of node.children ?? []) {
      if (c.children) {
        out.push(c.relPath);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}
