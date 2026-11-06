import { describe, expect, it } from 'vitest';
import { diffLines, type DiffBlock } from '../../src/engine';
import { mergeOp, mergeTitle } from '../../src/renderer/src/model/merge';
import { buildRows, patchRows, RowKind, type RowModel } from '../../src/renderer/src/model/rowModel';
import {
  applyOp,
  colAtVisual,
  composeOps,
  invertOp,
  replaceRange,
  textInRange,
  transformPos,
  visualColumn,
  wordAt,
  wordLeft,
  wordRight,
  type EditOp,
} from '../../src/renderer/src/model/textEdit';
import { UndoHistory } from '../../src/renderer/src/model/undo';

const caret = (line: number, col: number) => ({ anchor: { line, col }, head: { line, col } });

describe('replaceRange', () => {
  it('inserts a character', () => {
    const lines = ['hello'];
    const { op, end } = replaceRange(lines, { line: 0, col: 5 }, { line: 0, col: 5 }, '!');
    expect(op).toEqual({ start: 0, removed: ['hello'], inserted: ['hello!'] });
    expect(end).toEqual({ line: 0, col: 6 });
  });

  it('splits a line on Enter', () => {
    const { op, end } = replaceRange(['abcd'], { line: 0, col: 2 }, { line: 0, col: 2 }, '\n');
    expect(op.inserted).toEqual(['ab', 'cd']);
    expect(end).toEqual({ line: 1, col: 0 });
  });

  it('joins lines when deleting across a line break', () => {
    const { op, end } = replaceRange(['ab', 'cd', 'ef'], { line: 0, col: 1 }, { line: 2, col: 1 }, '');
    expect(op).toEqual({ start: 0, removed: ['ab', 'cd', 'ef'], inserted: ['af'] });
    expect(end).toEqual({ line: 0, col: 1 });
  });

  it('pastes multi-line text with any line endings', () => {
    const { op, end } = replaceRange(['[]'], { line: 0, col: 1 }, { line: 0, col: 1 }, 'x\r\ny\rz');
    expect(op.inserted).toEqual(['[x', 'y', 'z]']);
    expect(end).toEqual({ line: 2, col: 1 });
  });

  it('types into an empty document', () => {
    const { op } = replaceRange([], { line: 0, col: 0 }, { line: 0, col: 0 }, 'hi');
    expect(op).toEqual({ start: 0, removed: [], inserted: ['hi'] });
  });

  it('round-trips through apply and invert', () => {
    const lines = ['one', 'two', 'three'];
    const { op } = replaceRange(lines, { line: 0, col: 1 }, { line: 1, col: 2 }, 'X\nY');
    applyOp(lines, op);
    expect(lines).toEqual(['oX', 'Yo', 'three']);
    applyOp(lines, invertOp(op));
    expect(lines).toEqual(['one', 'two', 'three']);
  });
});

describe('positions and text', () => {
  it('extracts text across lines', () => {
    expect(textInRange(['abc', 'def', 'ghi'], { line: 0, col: 1 }, { line: 2, col: 2 })).toBe('bc\ndef\ngh');
  });

  it('moves positions past another edit', () => {
    const op: EditOp = { start: 2, removed: ['x'], inserted: ['a', 'b', 'c'] };
    expect(transformPos({ line: 1, col: 3 }, op)).toEqual({ line: 1, col: 3 });
    expect(transformPos({ line: 5, col: 3 }, op)).toEqual({ line: 7, col: 3 });
    expect(transformPos({ line: 2, col: 1 }, op)).toEqual({ line: 2, col: 1 });
  });

  it('maps between offsets and display columns with tabs', () => {
    expect(visualColumn('\tab', 1, 4)).toBe(4);
    expect(visualColumn('a\tb', 2, 4)).toBe(4);
    expect(colAtVisual('\tab', 4, 4)).toBe(1);
    expect(colAtVisual('\tab', 1, 4)).toBe(0);
    expect(colAtVisual('\tab', 3, 4)).toBe(1);
    expect(colAtVisual('abc', 99, 4)).toBe(3);
  });

  it('finds word boundaries', () => {
    const t = 'let total = sum(items);';
    expect(wordRight(t, 0)).toBe(3);
    expect(wordRight(t, 3)).toBe(9);
    expect(wordLeft(t, 9)).toBe(4);
    expect(wordLeft(t, 16)).toBe(15);
    expect(wordAt(t, 6)).toEqual([4, 9]);
  });
});

describe('UndoHistory', () => {
  it('merges consecutive typing into one step and restores selections', () => {
    const h = new UndoHistory();
    const lines = ['ab'];
    let t = 0;
    for (const ch of ['c', 'd', 'e']) {
      const col = lines[0].length;
      const { op, end } = replaceRange(lines, { line: 0, col }, { line: 0, col }, ch);
      applyOp(lines, op);
      h.push({ side: 'a', op, before: caret(0, col), after: caret(end.line, end.col), group: 'type', time: (t += 100) });
    }
    expect(lines).toEqual(['abcde']);
    const e = h.undo()!;
    applyOp(lines, invertOp(e.op));
    expect(lines).toEqual(['ab']);
    expect(e.before).toEqual(caret(0, 2));
    expect(h.undo()).toBeNull();
    applyOp(lines, h.redo()!.op);
    expect(lines).toEqual(['abcde']);
  });

  it('keeps separate steps across sides, pauses and seals', () => {
    const h = new UndoHistory();
    const op = (s: string, t: string): EditOp => ({ start: 0, removed: [s], inserted: [t] });
    h.push({ side: 'a', op: op('a', 'ab'), before: caret(0, 1), after: caret(0, 2), group: 'type', time: 0 });
    h.push({ side: 'b', op: op('a', 'ab'), before: caret(0, 1), after: caret(0, 2), group: 'type', time: 10 });
    h.push({ side: 'b', op: op('ab', 'abc'), before: caret(0, 2), after: caret(0, 3), group: 'type', time: 5000 });
    h.seal();
    h.push({ side: 'b', op: op('abc', 'abcd'), before: caret(0, 3), after: caret(0, 4), group: 'type', time: 5010 });
    expect([h.undo(), h.undo(), h.undo(), h.undo(), h.undo()].map((e) => e?.side ?? null)).toEqual(['b', 'b', 'b', 'a', null]);
  });

  it('undoes one side without touching the other', () => {
    const h = new UndoHistory();
    const a = ['a'];
    const b = ['b'];
    const edit = (side: 'a' | 'b', lines: string[], text: string) => {
      const op = { start: 0, removed: [lines[0]], inserted: [text] };
      applyOp(lines, op);
      h.push({ side, op, before: caret(0, 0), after: caret(0, 0), time: 0 });
    };
    edit('a', a, 'a1');
    edit('b', b, 'b1');
    edit('a', a, 'a2');
    edit('b', b, 'b2');
    expect([h.canUndo('a'), h.canUndo('b')]).toEqual([true, true]);
    applyOp(a, invertOp(h.undoSide('a')!.op));
    applyOp(a, invertOp(h.undoSide('a')!.op));
    expect(a).toEqual(['a']);
    expect(b).toEqual(['b2']);
    expect(h.canUndo('a')).toBe(false);
    expect(h.undoSide('a')).toBeNull();
    // Global undo continues with the other side's history.
    applyOp(b, invertOp(h.undo()!.op));
    expect(b).toEqual(['b1']);
  });

  it('composes only ops that chain exactly', () => {
    expect(composeOps({ start: 0, removed: ['a'], inserted: ['ab'] }, { start: 0, removed: ['ab'], inserted: ['abc'] })).toEqual({
      start: 0,
      removed: ['a'],
      inserted: ['abc'],
    });
    expect(composeOps({ start: 0, removed: ['a'], inserted: ['ab'] }, { start: 1, removed: ['x'], inserted: [] })).toBeNull();
  });
});

describe('mergeOp', () => {
  const a = ['same', 'left only', 'old', 'end'];
  const b = ['same', 'new', 'end', 'right only'];
  const result = diffLines(a, b);

  it('copies a block in either direction and makes the sides match', () => {
    for (const [i, blk] of result.blocks.entries()) {
      if (blk.kind === 'equal') continue;
      for (const from of ['a', 'b'] as const) {
        const src = from === 'a' ? a.slice() : b.slice();
        const dst = from === 'a' ? b.slice() : a.slice();
        applyOp(dst, mergeOp(result.blocks[i], from, src, dst));
        const after = from === 'a' ? diffLines(src, dst) : diffLines(dst, src);
        const before = result.stats.changeBlocks;
        expect(after.stats.changeBlocks, `block ${i} from ${from}`).toBe(before - 1);
      }
    }
  });
});

describe('patchRows', () => {
  /** Every line of each side appears exactly once, in order, and the inverse maps agree. */
  function expectConsistent(rows: RowModel, aLen: number, bLen: number) {
    const seen = (side: Int32Array) => Array.from(side).filter((x) => x >= 0);
    expect(seen(rows.a)).toEqual(Array.from({ length: aLen }, (_, i) => i));
    expect(seen(rows.b)).toEqual(Array.from({ length: bLen }, (_, i) => i));
    for (let r = 0; r < rows.count; r++) {
      expect(rows.a[r] >= 0 || rows.b[r] >= 0, `row ${r} is empty on both sides`).toBe(true);
      if (rows.a[r] >= 0) expect(rows.aRow[rows.a[r]]).toBe(r);
      if (rows.b[r] >= 0) expect(rows.bRow[rows.b[r]]).toBe(r);
    }
    expect(rows.aRow.length).toBe(aLen);
    expect(rows.bRow.length).toBe(bLen);
  }

  it('adds a row for a new line and fills the other side', () => {
    const rows = buildRows(diffLines(['a', 'b'], ['a', 'b']).blocks);
    const patched = patchRows(rows, 'a', 0, 1, 2); // Enter at the end of line 0 on the left
    expect(Array.from(patched.a)).toEqual([0, 1, 2]);
    expect(Array.from(patched.b)).toEqual([0, -1, 1]);
    expect(patched.kind[1]).toBe(RowKind.Deleted);
  });

  it('turns a removed line into a filler when the other side still has a line there', () => {
    const rows = buildRows(diffLines(['a', 'b', 'c'], ['a', 'b', 'c']).blocks);
    const patched = patchRows(rows, 'b', 1, 2, 1); // join right lines 1 and 2
    expect(Array.from(patched.a)).toEqual([0, 1, 2]);
    expect(Array.from(patched.b)).toEqual([0, 1, -1]);
  });

  it('drops a row that becomes empty on both sides', () => {
    const rows = buildRows(diffLines(['a', 'b'], ['a', 'x', 'b']).blocks);
    const patched = patchRows(rows, 'b', 1, 1, 0); // delete the inserted right line
    expect(patched.count).toBe(2);
    expectConsistent(patched, 2, 2);
  });

  // A merge's interim layout must already be the one the re-diff produces, or the view shifts
  // for a frame when the re-diff arrives (reported as a flicker when copying lines across).
  const settled = (a: string[], b: string[]) => {
    const r = buildRows(diffLines(a, b).blocks);
    return { a: Array.from(r.a), b: Array.from(r.b) };
  };

  it('fills the gap when lines are copied into it, instead of adding rows', () => {
    const left = ['one', 'three'];
    const right = ['one', 'two', 'three'];
    const rows = buildRows(diffLines(left, right).blocks);
    expect(Array.from(rows.a)).toEqual([0, -1, 1]);
    const patched = patchRows(rows, 'a', 1, 0, 1); // copy "two" to the left
    expect(patched.count).toBe(3);
    expect({ a: Array.from(patched.a), b: Array.from(patched.b) }).toEqual(settled(['one', 'two', 'three'], right));
    expectConsistent(patched, 3, 3);
  });

  it('uses the fillers below when copying more lines over fewer', () => {
    const left = ['s', 'x1', 'x2', 'x3', 'e'];
    const right = ['s', 'q', 'e'];
    const rows = buildRows(diffLines(left, right).blocks);
    const patched = patchRows(rows, 'b', 1, 1, 3); // copy left lines 1 to 3 over right line 1
    expect(patched.count).toBe(rows.count);
    expect({ a: Array.from(patched.a), b: Array.from(patched.b) }).toEqual(settled(left, left));
    expectConsistent(patched, 5, 5);
  });

  it('fills a gap at the end of the file', () => {
    const rows = buildRows(diffLines(['a'], ['a', 'b', 'c']).blocks);
    const patched = patchRows(rows, 'a', 1, 0, 2);
    expect(patched.count).toBe(3);
    expectConsistent(patched, 3, 3);
  });

  it('stays consistent through many random edits on both sides', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const a = Array.from({ length: 40 }, (_, i) => `line ${i % 7}`);
    const b = a.map((l, i) => (i % 5 === 0 ? `${l}!` : l)).filter((_, i) => i % 9 !== 3);
    let rows = buildRows(diffLines(a, b).blocks);
    for (let step = 0; step < 400; step++) {
      const side = rand() < 0.5 ? 'a' : 'b';
      const lines = side === 'a' ? a : b;
      const start = Math.floor(rand() * (lines.length + 1));
      const removed = Math.min(lines.length - start, Math.floor(rand() * 3));
      const inserted = Math.floor(rand() * 3);
      lines.splice(start, removed, ...Array.from({ length: inserted }, () => 'new'));
      rows = patchRows(rows, side, start, removed, inserted);
      expectConsistent(rows, a.length, b.length);
    }
  });
});

describe('mergeTitle', () => {
  const block = (kind: DiffBlock['kind'], a: [number, number], b: [number, number]): DiffBlock => ({
    kind,
    a: { start: a[0], end: a[1] },
    b: { start: b[0], end: b[1] },
  });

  it('says what will be copied and what it replaces, with line numbers', () => {
    expect(mergeTitle(block('modify', [17, 20], [18, 24]), 'a')).toBe('Copy left lines 18–20 to the right, replacing right lines 19–24');
    expect(mergeTitle(block('modify', [17, 20], [18, 19]), 'b')).toBe('Copy right line 19 to the left, replacing left lines 18–20');
  });

  it('says "copy" for lines the other side lacks, and "remove" from the side that has none', () => {
    expect(mergeTitle(block('delete', [32, 35], [36, 36]), 'a')).toBe('Copy left lines 33–35 to the right');
    expect(mergeTitle(block('delete', [32, 35], [36, 36]), 'b')).toBe('Remove left lines 33–35');
    expect(mergeTitle(block('insert', [2, 2], [2, 3]), 'a')).toBe('Remove right line 3');
  });
});
