/** `path` with the home folder written as `~`, when it is inside it. */
export function tildePath(path: string, home: string): string {
  if (!home || !(path === home || path.startsWith(home + '/') || path.startsWith(home + '\\'))) return path;
  return '~' + path.slice(home.length);
}

/** Splits a path into its folder (with the trailing separator) and its last segment. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  return { dir: path.slice(0, cut), name: path.slice(cut) };
}

/** The folder containing `path`: "/" or a drive root ("C:\\") at the top, never a bare "C:". */
export function parentDir(path: string): string {
  const parent = path.replace(/[\\/][^\\/]+[\\/]?$/, '');
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || '/';
}
