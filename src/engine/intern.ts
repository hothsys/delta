import type { KeyFn } from './normalize';

/** Assigns dense integer ids to strings so the diff core compares numbers, not strings. */
export class Interner {
  private readonly ids = new Map<string, number>();

  id(s: string): number {
    let v = this.ids.get(s);
    if (v === undefined) {
      v = this.ids.size;
      this.ids.set(s, v);
    }
    return v;
  }

  get size(): number {
    return this.ids.size;
  }
}

export function internAll(lines: readonly string[], interner: Interner, key: KeyFn | null): Int32Array {
  const out = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    out[i] = interner.id(key ? key(lines[i]) : lines[i]);
  }
  return out;
}
