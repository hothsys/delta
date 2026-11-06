import { useEffect, useRef, useState } from 'react';
import { log } from './log';
import type { Side } from './model/rowModel';
import type { PrettyKind } from './prettify/kinds';
import type { PrettifyRequest, PrettifyResponse } from './prettify/prettify.worker';
import { newSourceId, type Source } from './useComparison';

export interface PrettifyState {
  /** `working` while either side is being formatted. */
  status: 'off' | 'working' | 'ready';
  /** The formatted sides (a side that couldn't be formatted keeps its own text). */
  sources: Record<Side, Source> | null;
  /** Why a side couldn't be formatted. */
  errors: Partial<Record<Side, string>>;
}

interface Formatted {
  source: Source;
  error?: string;
}

/** Formatted versions kept, so turning Prettify off and on again is instant. */
const CACHE_SIZE = 6;

/**
 * Formats both sides in a worker while `on`, from the texts as read from disk. Results are
 * cached per document (a reload is a new document, so it's formatted again). `cancel` stops
 * formatting at once by terminating the worker.
 */
export function usePrettify(on: boolean, sources: Record<Side, Source>, kinds: Record<Side, PrettyKind> | null) {
  const worker = useRef<Worker | null>(null);
  const cache = useRef(new Map<string, Formatted>());
  const nextId = useRef(0);
  const pending = useRef(new Map<number, (r: PrettifyResponse) => void>());
  const [state, setState] = useState<PrettifyState>({ status: 'off', sources: null, errors: {} });

  const getWorker = () => {
    if (!worker.current) {
      const w = new Worker(new URL('./prettify/prettify.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<PrettifyResponse>) => {
        pending.current.get(e.data.id)?.(e.data);
        pending.current.delete(e.data.id);
      };
      worker.current = w;
    }
    return worker.current;
  };

  const format = (side: Side, source: Source, kind: PrettyKind): Promise<Formatted> => {
    // A save changes the text without changing the document's id.
    const key = `${source.id}.${source.saved ?? 0}:${kind}`;
    const hit = cache.current.get(key);
    if (hit) return Promise.resolve(hit);
    const id = ++nextId.current;
    return new Promise((resolve) => {
      pending.current.set(id, ({ result, elapsedMs }) => {
        const fields = { side: side === 'a' ? 'left' : 'right', kind, chars: source.text.length, ms: Math.round(elapsedMs) };
        if (result.ok) log.info('prettify', 'Prettified', fields);
        else log.warn('prettify', 'Could not prettify', { ...fields, error: result.message });
        const formatted: Formatted = {
          source: { ...source, id: newSourceId(), saved: undefined, text: result.ok ? result.text : source.text },
          error: result.ok ? undefined : result.message,
        };
        cache.current.set(key, formatted);
        if (cache.current.size > CACHE_SIZE) cache.current.delete(cache.current.keys().next().value!);
        resolve(formatted);
      });
      const request: PrettifyRequest = { id, text: source.text, kind };
      getWorker().postMessage(request);
    });
  };

  const generation = useRef(0);
  useEffect(() => {
    const gen = ++generation.current;
    if (!on || !kinds) {
      setState({ status: 'off', sources: null, errors: {} });
      return;
    }
    setState((s) => ({ ...s, status: 'working' }));
    void Promise.all([format('a', sources.a, kinds.a), format('b', sources.b, kinds.b)]).then(([a, b]) => {
      if (gen !== generation.current) return; // turned off, cancelled or superseded meanwhile
      setState({ status: 'ready', sources: { a: a.source, b: b.source }, errors: { a: a.error, b: b.error } });
    });
  }, [on, sources.a.id, sources.b.id, sources.a.saved, sources.b.saved, kinds?.a, kinds?.b]);

  useEffect(() => () => worker.current?.terminate(), []);

  /** Stops formatting now; the caller turns Prettify off. */
  const cancel = () => {
    generation.current++;
    worker.current?.terminate();
    worker.current = null;
    pending.current.clear();
    log.info('prettify', 'Cancelled');
  };

  return { state, cancel };
}
