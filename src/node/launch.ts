import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LaunchRequest } from '../shared/api';

/**
 * What to open, from paths given at launch: two folders compare as folders; one or two files
 * compare as files (the missing side is asked for); anything else opens the start screen.
 * Options (arguments starting with "-") are ignored.
 */
export function launchRequest(args: readonly string[]): LaunchRequest {
  const kinds = args
    .filter((a) => !a.startsWith('-'))
    .slice(0, 2)
    .map((a) => {
      try {
        return { path: resolve(a), dir: statSync(a).isDirectory() };
      } catch {
        return null;
      }
    });
  const [l, r] = kinds;
  if (l && r && l.dir && r.dir) return { kind: 'folders', left: l.path, right: r.path };
  if ((l && !l.dir) || (r && !r.dir)) {
    return { kind: 'files', left: l && !l.dir ? l.path : undefined, right: r && !r.dir ? r.path : undefined };
  }
  return { kind: 'none' };
}
