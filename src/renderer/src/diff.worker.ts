import { diffText, type LineDiffOptions, type LineDiffResult } from '../../engine';
import { buildRows, type RowModel } from './model/rowModel';

export interface DiffRequest {
  id: number;
  left: string;
  right: string;
  options: LineDiffOptions;
}

export type DiffResponse =
  | { id: number; ok: true; result: LineDiffResult; rows: RowModel; elapsedMs: number }
  | { id: number; ok: false; error: string };

// Runs the engine off the UI thread so even very large files never freeze scrolling or typing.
self.onmessage = (e: MessageEvent<DiffRequest>) => {
  const { id, left, right, options } = e.data;
  try {
    const t0 = performance.now();
    const { blocks, stats, anchors } = diffText(left, right, options);
    const rows = buildRows(blocks);
    const response: DiffResponse = {
      id,
      ok: true,
      result: { blocks, stats, anchors },
      rows,
      elapsedMs: performance.now() - t0,
    };
    // Typed arrays are transferred rather than copied.
    const { a, b, kind, blockStart, aRowStart, aRowEnd, bRowStart, bRowEnd, aRow, bRow } = rows;
    const transfer = [a, b, kind, blockStart, aRowStart, aRowEnd, bRowStart, bRowEnd, aRow, bRow].map((t) => t.buffer);
    self.postMessage(response, { transfer });
  } catch (err) {
    const response: DiffResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
};
