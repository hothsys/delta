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

// ---- Updating after outside changes ---------------------------------------------------------

/**
 * The entries to re-compare for a batch of changed paths: each path once, and none inside
 * another that's already listed (re-comparing a folder covers everything in it). An empty
 * path (a compared folder itself) means scanning everything again.
 */
export function entriesToRecompare(paths: readonly string[]): string[] {
  const clean = [...new Set(paths.map((p) => p.split('/').filter(Boolean).join('/')))].sort();
  if (clean.includes('')) return [''];
  const listed = new Set(clean);
  return clean.filter((p) => {
    const parts = p.split('/');
    for (let k = 1; k < parts.length; k++) if (listed.has(parts.slice(0, k).join('/'))) return false;
    return true;
  });
}

/**
 * The tree with re-compared entries put in: replaced, added in order, or removed when gone
 * from both sides, then every folder above them re-judged (same only if everything inside is
 * the same). Nodes off the changed paths are kept as they are. Null if an entry's parent isn't
 * in the tree (it changed too, unseen): the caller scans everything again.
 */
export function patchTree(root: FolderNode, updates: readonly { relPath: string; node: FolderNode | null }[]): FolderNode | null {
  let next = root;
  for (const u of updates) {
    const patched = patchOne(next, u.relPath.split('/'), 0, u.node);
    if (!patched) return null;
    next = patched;
  }
  return next;
}

function patchOne(dir: FolderNode, parts: string[], depth: number, node: FolderNode | null): FolderNode | null {
  if (!dir.children) return null;
  const name = parts[depth];
  const i = dir.children.findIndex((c) => c.name === name);
  let children: FolderNode[];
  if (depth === parts.length - 1) {
    children = dir.children.filter((_, k) => k !== i);
    if (node) children = insertSorted(children, node);
  } else {
    if (i < 0) return null;
    const child = patchOne(dir.children[i], parts, depth + 1, node);
    if (!child) return null;
    children = dir.children.map((c, k) => (k === i ? child : c));
  }
  return rejudge({ ...dir, children });
}

/** A folder's status from its children, when it's a folder on both sides. */
function rejudge(dir: FolderNode): FolderNode {
  if (!dir.left || !dir.right || dir.status === 'kind-mismatch') return dir;
  const status: EntryStatus = !dir.error && dir.children!.every((c) => c.status === 'same') ? 'same' : 'different';
  return status === dir.status ? dir : { ...dir, status };
}

/** Folders (on either side) before files, then by name: the order the comparison produces. */
function insertSorted(children: FolderNode[], node: FolderNode): FolderNode[] {
  const before = (a: FolderNode, b: FolderNode) =>
    (a.children ? 0 : 1) - (b.children ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const at = children.findIndex((c) => before(node, c) < 0);
  return at < 0 ? [...children, node] : [...children.slice(0, at), node, ...children.slice(at)];
}
