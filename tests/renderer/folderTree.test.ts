import { describe, expect, it } from 'vitest';
import { countFiles, flattenTree, folderPaths } from '../../src/renderer/src/model/folderTree';
import type { FolderNode } from '../../src/shared/api';

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
