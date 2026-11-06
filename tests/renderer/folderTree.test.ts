import { describe, expect, it } from 'vitest';
import { countFiles, entriesToRecompare, flattenTree, folderPaths, patchTree } from '../../src/renderer/src/model/folderTree';
import type { EntryStatus, FolderNode } from '../../src/shared/api';

const file = (relPath: string, status: FolderNode['status']): FolderNode => ({
  name: relPath.split('/').pop()!,
  relPath,
  status,
  left: status === 'right-only' ? undefined : { kind: 'file', size: 1, mtimeMs: 0 },
  right: status === 'left-only' ? undefined : { kind: 'file', size: 1, mtimeMs: 0 },
});
const dir = (relPath: string, status: FolderNode['status'], children: FolderNode[]): FolderNode => ({
  name: relPath.split('/').pop()!,
  relPath,
  status,
  left: { kind: 'dir', size: 0, mtimeMs: 0 },
  right: { kind: 'dir', size: 0, mtimeMs: 0 },
  children,
});

const root = dir('', 'different', [
  dir('src', 'different', [file('src/a.ts', 'same'), file('src/b.ts', 'different'), dir('src/lib', 'same', [file('src/lib/x.ts', 'same')])]),
  file('README.md', 'same'),
  file('new.txt', 'right-only'),
]);

describe('flattenTree', () => {
  it('shows only expanded folders', () => {
    expect(flattenTree(root, new Set(), false).map((r) => r.node.relPath)).toEqual(['src', 'README.md', 'new.txt']);
    const rows = flattenTree(root, new Set(['src']), false);
    expect(rows.map((r) => [r.node.relPath, r.depth])).toEqual([
      ['src', 0],
      ['src/a.ts', 1],
      ['src/b.ts', 1],
      ['src/lib', 1],
      ['README.md', 0],
      ['new.txt', 0],
    ]);
    expect(rows[0]).toMatchObject({ isDir: true, expanded: true });
  });

  it('can hide identical entries', () => {
    expect(flattenTree(root, new Set(['src']), true).map((r) => r.node.relPath)).toEqual(['src', 'src/b.ts', 'new.txt']);
  });
});

describe('summaries', () => {
  it('counts files by status and lists folders', () => {
    expect(countFiles(root)).toEqual({ same: 3, different: 1, 'left-only': 0, 'right-only': 1, 'kind-mismatch': 0 });
    expect(folderPaths(root)).toEqual(['src', 'src/lib']);
  });
});

describe('updating after outside changes', () => {
  const file = (relPath: string, status: EntryStatus, sides: 'both' | 'left' | 'right' = 'both'): FolderNode => ({
    name: relPath.split('/').pop()!,
    relPath,
    status,
    ...(sides !== 'right' && { left: { kind: 'file' as const, size: 1, mtimeMs: 1 } }),
    ...(sides !== 'left' && { right: { kind: 'file' as const, size: 1, mtimeMs: 1 } }),
  });
  const dir = (relPath: string, children: FolderNode[], status?: EntryStatus): FolderNode => ({
    name: relPath.split('/').pop() ?? '',
    relPath,
    left: { kind: 'dir', size: 0, mtimeMs: 1 },
    right: { kind: 'dir', size: 0, mtimeMs: 1 },
    status: status ?? (children.every((c) => c.status === 'same') ? 'same' : 'different'),
    children,
  });
  const tree = () => dir('', [dir('src', [file('src/a.ts', 'same'), file('src/c.ts', 'same')]), file('readme.md', 'different')]);

  it('re-compares each changed entry once, and nothing inside a changed folder', () => {
    expect(entriesToRecompare(['src/a.ts', 'src/a.ts', 'readme.md'])).toEqual(['readme.md', 'src/a.ts']);
    expect(entriesToRecompare(['a/x', 'a', 'a-b', 'a-b/y', 'b/c/d', 'b/c'])).toEqual(['a', 'a-b', 'b/c']);
    expect(entriesToRecompare(['src/a.ts', ''])).toEqual(['']);
  });

  it('replaces an entry and re-judges the folders above it', () => {
    const original = tree();
    const t = patchTree(original, [{ relPath: 'src/a.ts', node: file('src/a.ts', 'different') }])!;
    expect(t.children![0].status).toBe('different');
    expect(t.children![0].children![0].status).toBe('different');
    // Entries off the changed path are the same objects, so their rows aren't redrawn.
    expect(t.children![1]).toBe(original.children![1]);
    expect(t.children![0].children![1]).toBe(original.children![0].children![1]);
    const back = patchTree(t, [{ relPath: 'src/a.ts', node: file('src/a.ts', 'same') }])!;
    expect(back.children![0].status).toBe('same');
  });

  it('adds new entries in order and removes ones gone from both sides', () => {
    const added = patchTree(tree(), [{ relPath: 'src/b.ts', node: file('src/b.ts', 'left-only', 'left') }])!;
    expect(added.children![0].children!.map((c) => c.name)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(added.children![0].status).toBe('different');
    const newDir = patchTree(tree(), [{ relPath: 'lib', node: dir('lib', [file('lib/x.ts', 'same')]) }])!;
    expect(newDir.children!.map((c) => c.name)).toEqual(['lib', 'src', 'readme.md']);
    const removed = patchTree(added, [{ relPath: 'src/b.ts', node: null }])!;
    expect(removed.children![0].children!.map((c) => c.name)).toEqual(['a.ts', 'c.ts']);
    expect(removed.children![0].status).toBe('same');
    const gone = patchTree(tree(), [{ relPath: 'readme.md', node: null }])!;
    expect(gone.status).toBe('same');
  });

  it('gives up (null) when an entry’s folder is not in the tree', () => {
    expect(patchTree(tree(), [{ relPath: 'nowhere/x.ts', node: file('nowhere/x.ts', 'left-only', 'left') }])).toBeNull();
  });

  it('leaves a folder that is only on one side as it is', () => {
    const t = dir('', [{ ...dir('only', [file('only/a', 'left-only', 'left')]), right: undefined, status: 'left-only' }]);
    const p = patchTree(t, [{ relPath: 'only/b', node: file('only/b', 'left-only', 'left') }])!;
    expect(p.children![0].status).toBe('left-only');
    expect(p.children![0].children!.length).toBe(2);
  });
});
