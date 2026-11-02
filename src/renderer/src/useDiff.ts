import { useEffect, useRef, useState } from 'react';
import type { Anchor, LineDiffOptions, LineDiffResult } from '../../engine';
import type { DiffRequest, DiffResponse } from './diff.worker';
import { log } from './log';
import type { RowModel } from './model/rowModel';

export interface DiffInput {
  left: string;
  right: string;
  /** Manual alignments, in the line numbers of these texts. */
  anchors: Anchor[];
  /** Identifies the document versions these texts came from; echoed back with the result. */
  tag: string;
}

export interface DiffState {
  result: LineDiffResult | null;
  rows: RowModel | null;
  /** The `DiffInput.tag` that `result` was computed for. */
  tag: string | null;
  /** A comparison is running; `result` still holds the previous one. */
  busy: boolean;
  elapsedMs: number;
  error: string | null;
}

/** A diff taking this long is logged even when debug logging is off. */
const SLOW_DIFF_MS = 1000;

/** Diffs two texts in a Web Worker. Only the latest request's answer is kept. */
export function useDiff(input: DiffInput, options: Omit<LineDiffOptions, 'anchors'>): DiffState {
  const workerRef = useRef<Worker | null>(null);
  const latest = useRef({ id: 0, tag: '' });
  const [state, setState] = useState<DiffState>({
    result: null,
    rows: null,
    tag: null,
    busy: true,
    elapsedMs: 0,
    error: null,
  });

  useEffect(() => {
    const worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<DiffResponse>) => {
      const msg = e.data;
      if (msg.id !== latest.current.id) return;
      if (msg.ok) {
        // Every diff in the debug log; one slow enough to notice in the normal log too.
        const fields = { ms: Math.round(msg.elapsedMs), rows: msg.rows.count, blocks: msg.result.blocks.length };
        if (msg.elapsedMs >= SLOW_DIFF_MS) log.info('diff', 'Slow comparison', fields);
        else log.debug('diff', 'Compared', fields);
        setState({ result: msg.result, rows: msg.rows, tag: latest.current.tag, busy: false, elapsedMs: msg.elapsedMs, error: null });
      } else {
        log.error('diff', 'The comparison failed', { error: msg.error });
        setState((s) => ({ ...s, busy: false, error: msg.error }));
      }
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const { whitespace, ignoreCase, minimal } = options;
  useEffect(() => {
    const id = latest.current.id + 1;
    latest.current = { id, tag: input.tag };
    setState((s) => ({ ...s, busy: true }));
    const request: DiffRequest = {
      id,
      left: input.left,
      right: input.right,
      options: { whitespace, ignoreCase, anchors: input.anchors, minimal },
    };
    workerRef.current?.postMessage(request);
  }, [input, whitespace, ignoreCase, minimal]);

  return state;
}
