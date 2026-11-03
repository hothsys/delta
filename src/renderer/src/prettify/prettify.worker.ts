import { prettify, type PrettifyResult } from '.';
import type { PrettyKind } from './kinds';

export interface PrettifyRequest {
  id: number;
  text: string;
  kind: PrettyKind;
}

export interface PrettifyResponse {
  id: number;
  result: PrettifyResult;
  elapsedMs: number;
}

// Formatting a large minified bundle can take seconds; off the UI thread it never freezes the
// interface, and Cancel ends it by terminating the worker.
self.onmessage = async (e: MessageEvent<PrettifyRequest>) => {
  const { id, text, kind } = e.data;
  const t0 = performance.now();
  const result = await prettify(text, kind);
  const response: PrettifyResponse = { id, result, elapsedMs: performance.now() - t0 };
  self.postMessage(response);
};
