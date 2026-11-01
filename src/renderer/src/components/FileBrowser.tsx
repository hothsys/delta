import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DirEntry, DirectoryListing, Location } from '../../../shared/api';
import { parentDir } from '../model/paths';
import { api } from '../platform';
import { confirmInPage, type PickRequest } from '../platform/dialogs';

const LAST_FOLDER_KEY = 'delta.browse.last';
const RECENT_FOLDERS_KEY = 'delta.browse.recent';
const MAX_RECENT_FOLDERS = 6;

interface TreeNode {
  open: boolean;
  loading?: boolean;
  entries?: DirEntry[];
  error?: string;
}

interface Row {
  entry: DirEntry;
  /** Nesting under the current folder (0 = its direct entries). */
  depth: number;
}

interface FileBrowserProps {
  request: PickRequest;
  onDone: (path: string | null) => void;
}

/**
 * The browser version's file and folder picker (the desktop app uses native dialogs). Lists
 * folders through Delta's local server, so it can reach any path, drive or share.
 */
export function FileBrowser({ request, onDone }: FileBrowserProps) {
  const [listing, setListing] = useState<Extract<DirectoryListing, { ok: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [name, setName] = useState('');
  /** Folders expanded in place (▾), with their contents once loaded. */
  const [tree, setTree] = useState<Record<string, TreeNode>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const recentFolders = useMemo(() => readRecentFolders(), []);

  /** Counts listings, so a slow one can't overwrite a newer one. */
  const listingId = useRef(0);
  const navigate = async (path: string, hidden = showHidden, listed?: DirectoryListing) => {
    const id = ++listingId.current;
    const r = listed ?? (await api.listDirectory(path, hidden));
    if (id !== listingId.current) return;
    if (!r.ok) {
      setError(`Can't open ${r.path}: ${r.message}`);
      return;
    }
    setError(null);
    setListing(r);
    setPathInput(r.path);
    setSelected(null);
    setFilter('');
    setTree({});
    localStorage.setItem(LAST_FOLDER_KEY, r.path);
    listRef.current?.focus();
  };

  // Start in the folder of a suggested path, the last folder browsed, or home.
  useEffect(() => {
    void (async () => {
      const locs = await api.locations();
      setLocations(locs);
      const suggested = request.defaultName ?? '';
      const suggestedDir = /[\\/]/.test(suggested) ? parentDir(suggested) : null;
      if (request.mode === 'save') setName(suggested.split(/[\\/]/).pop() ?? '');
      const start = suggestedDir ?? localStorage.getItem(LAST_FOLDER_KEY) ?? locs[0]?.path ?? '/';
      const r = await api.listDirectory(start, false);
      if (r.ok) await navigate(start, false, r);
      else await navigate(locs[0]?.path ?? '/', false);
    })();
  }, []);

  const entries = useMemo(() => {
    const all = listing?.entries ?? [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((e) => e.name.toLowerCase().includes(f)) : all;
  }, [listing, filter]);

  /** The visible rows: the folder's entries, with expanded folders' contents nested under them. */
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (list: DirEntry[], depth: number) => {
      for (const entry of list) {
        out.push({ entry, depth });
        const node = tree[entry.path];
        if (entry.kind === 'dir' && node?.open && node.entries) walk(node.entries, depth + 1);
      }
    };
    walk(entries, 0);
    return out;
  }, [entries, tree]);

  /** Expands or collapses a folder in place, loading its contents the first time. */
  const toggle = async (entry: DirEntry, open?: boolean) => {
    const node = tree[entry.path];
    const next = open ?? !node?.open;
    if (!next) return setTree((t) => ({ ...t, [entry.path]: { ...t[entry.path], open: false } }));
    if (node?.entries) return setTree((t) => ({ ...t, [entry.path]: { ...t[entry.path], open: true } }));
    setTree((t) => ({ ...t, [entry.path]: { open: true, loading: true } }));
    const id = listingId.current;
    const r = await api.listDirectory(entry.path, showHidden);
    if (id !== listingId.current) return; // the user moved to another folder meanwhile
    setTree((t) => ({
      ...t,
      [entry.path]: r.ok ? { open: true, entries: r.entries } : { open: true, error: r.message },
    }));
  };

  const selectable = (e: DirEntry) => e.kind === 'dir' || request.mode !== 'folder';
  const selectedEntry = rows.find((r) => r.entry.path === selected)?.entry ?? null;
  const parentOf = parentDir;

  const finish = (path: string) => {
    const folder = request.mode === 'folder' ? path : (listing?.path ?? null);
    if (folder) rememberFolder(folder);
    onDone(path);
  };

  /** Double-click: folders open (in every mode); files are picked (or, when saving, name the file). */
  const open = async (entry: DirEntry) => {
    if (entry.kind === 'dir') return navigate(entry.path);
    if (request.mode === 'file') return finish(entry.path);
    if (request.mode === 'save') setName(entry.name);
  };

  /** The main button and Enter. */
  const primary = async () => {
    if (request.mode === 'file') {
      if (selectedEntry?.kind === 'file') return finish(selectedEntry.path);
      if (selectedEntry?.kind === 'dir') return navigate(selectedEntry.path);
      return;
    }
    if (request.mode === 'folder') return finish(selectedEntry?.path ?? listing!.path);
    await save();
  };

  /** Where Save puts the file: the selected folder, the selected file's folder, or the current folder. */
  const saveFolder = () => {
    if (selectedEntry?.kind === 'dir') return selectedEntry.path;
    if (selectedEntry?.kind === 'file') return parentOf(selectedEntry.path);
    return listing?.path ?? null;
  };

  const save = async () => {
    const folder = saveFolder();
    if (!folder || !name.trim()) return;
    const target = api.joinPath(folder, name.trim());
    const kind = await api.pathKind(target);
    if (kind === 'dir') {
      setError(`“${name.trim()}” is a folder.`);
      return;
    }
    if (kind === 'file') {
      const ok = await confirmInPage({ message: `“${name.trim()}” already exists. Replace it?`, confirmLabel: 'Replace' });
      if (!ok) return;
    }
    await finish(target);
  };

  const onPathEnter = async () => {
    const path = pathInput.trim();
    if (!path) return;
    const kind = await api.pathKind(path);
    if (kind === 'dir') return navigate(path);
    if (kind === 'file' && request.mode === 'file') return finish(path);
    if (request.mode === 'save') {
      const parent = parentDir(path);
      if ((await api.pathKind(parent)) === 'dir') {
        setName(path.split(/[\\/]/).pop() ?? '');
        return navigate(parent);
      }
    }
    setError(kind === 'file' ? `${path} is a file; choose a folder.` : `${path} wasn't found.`);
  };

  const selectRow = (j: number) => {
    setSelected(rows[j].entry.path);
    listRef.current?.querySelector(`[data-index="${j}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.entry.path === selected);
    const row = rows[i];
    if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      if (listing?.parent) void navigate(listing.parent);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      for (let j = i + step; j >= 0 && j < rows.length; j += step) {
        if (selectable(rows[j].entry)) return selectRow(j);
      }
    } else if (e.key === 'ArrowRight' && row?.entry.kind === 'dir') {
      // Expand; if already expanded, step into its first item.
      e.preventDefault();
      if (!tree[row.entry.path]?.open) void toggle(row.entry, true);
      else if (rows[i + 1]?.depth === row.depth + 1 && selectable(rows[i + 1].entry)) selectRow(i + 1);
    } else if (e.key === 'ArrowLeft' && row) {
      // Collapse; if already collapsed, go to the enclosing folder's row.
      e.preventDefault();
      if (row.entry.kind === 'dir' && tree[row.entry.path]?.open) void toggle(row.entry, false);
      else {
        for (let j = i - 1; j >= 0; j--) if (rows[j].depth < row.depth) return selectRow(j);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void primary();
    } else if (e.key === 'Backspace' && listing?.parent) {
      e.preventDefault();
      void navigate(listing.parent);
    }
  };

  const crumbs = listing ? breadcrumbs(listing.path) : [];
  const primaryLabel =
    request.mode === 'save'
      ? 'Save'
      : request.mode === 'folder'
        ? selectedEntry
          ? `Choose “${selectedEntry.name}”`
          : 'Choose this folder'
        : selectedEntry?.kind === 'dir'
          ? 'Open folder'
          : 'Open';
  const primaryDisabled =
    !listing || (request.mode === 'file' && !selectedEntry) || (request.mode === 'save' && !name.trim());
  const saveTarget = request.mode === 'save' ? saveFolder() : null;

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onDone(null)}>
      <div className="modal file-browser" role="dialog" aria-modal="true" aria-label={request.title}>
        <div className="fb-title">{request.title}</div>
        <div className="fb-body">
          <nav className="fb-sidebar" aria-label="Locations">
            <div className="fb-section">Locations</div>
            {locations.map((l) => (
              <button key={l.path} type="button" className={listing?.path === l.path ? 'current' : ''} onClick={() => void navigate(l.path)} title={l.path}>
                {l.name}
              </button>
            ))}
            {recentFolders.length > 0 && <div className="fb-section">Recent folders</div>}
            {recentFolders.map((p) => (
              <button key={p} type="button" onClick={() => void navigate(p)} title={p}>
                {p.split(/[\\/]/).filter(Boolean).pop() ?? p}
              </button>
            ))}
          </nav>
          <div className="fb-main">
            <div className="fb-bar">
              <button type="button" className="fb-up" disabled={!listing?.parent} onClick={() => listing?.parent && void navigate(listing.parent)} title="Parent folder (Backspace)" aria-label="Parent folder">
                ↑
              </button>
              <div className="fb-crumbs">
                {crumbs.map((c, i) => (
                  <button key={c.path} type="button" onClick={() => void navigate(c.path)} disabled={i === crumbs.length - 1}>
                    {c.name}
                  </button>
                ))}
              </div>
              <label className="fb-hidden">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(e) => {
                    setShowHidden(e.target.checked);
                    if (listing) void navigate(listing.path, e.target.checked);
                  }}
                />
                Hidden files
              </label>
            </div>
            <div className="fb-bar">
              <input
                className="fb-path"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void onPathEnter()}
                aria-label="Path"
                spellCheck={false}
              />
              <input className="fb-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter this folder" spellCheck={false} />
            </div>
            {error && <div className="fb-error">{error}</div>}
            <div className="fb-list" ref={listRef} tabIndex={0} onKeyDown={onListKeyDown} role="listbox" aria-label="Folder contents">
              {entries.length === 0 && listing && <div className="fb-empty">{filter ? 'Nothing matches the filter.' : 'This folder is empty.'}</div>}
              {rows.map(({ entry: e, depth }, i) => {
                const node = e.kind === 'dir' ? tree[e.path] : undefined;
                return (
                <div key={e.path} role="presentation">
                <div
                  data-index={i}
                  role="option"
                  aria-selected={e.path === selected}
                  aria-disabled={!selectable(e)}
                  aria-expanded={e.kind === 'dir' ? !!node?.open : undefined}
                  className={`fb-row${e.path === selected ? ' selected' : ''}${selectable(e) ? '' : ' disabled'}`}
                  style={{ paddingLeft: 10 + depth * 18 }}
                  onClick={() => selectable(e) && setSelected(e.path)}
                  onDoubleClick={() => selectable(e) && void open(e)}
                >
                  {e.kind === 'dir' ? (
                    <button
                      type="button"
                      className="fb-twisty"
                      tabIndex={-1}
                      aria-label={node?.open ? `Collapse ${e.name}` : `Expand ${e.name}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void toggle(e);
                      }}
                      onDoubleClick={(ev) => ev.stopPropagation()}
                    >
                      {node?.open ? '▾' : '▸'}
                    </button>
                  ) : (
                    <span className="fb-twisty" aria-hidden="true" />
                  )}
                  <span className="fb-name">
                    {e.name}
                    {e.kind === 'dir' ? '/' : ''}
                  </span>
                  <span className="fb-size">{e.kind === 'file' ? formatSize(e.size) : ''}</span>
                  <span className="fb-date">{new Date(e.mtimeMs).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
                {node?.open && (node.loading || node.error || node.entries?.length === 0) && (
                  <div className="fb-status" style={{ paddingLeft: 10 + (depth + 1) * 18 + 22 }}>
                    {node.loading ? 'Loading…' : node.error ? `Can't open: ${node.error}` : 'Empty'}
                  </div>
                )}
                </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="fb-footer">
          {request.mode === 'save' && (
            <label className="fb-name-field">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} spellCheck={false} />
            </label>
          )}
          {saveTarget && (
            <span className="fb-save-target" title={saveTarget}>
              in {saveTarget.split(/[\\/]/).filter(Boolean).pop() ?? saveTarget}
            </span>
          )}
          <div className="spacer" />
          <button type="button" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={primaryDisabled}
            onClick={() => void primary()}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Clickable path segments, from the root down. */
function breadcrumbs(path: string): { name: string; path: string }[] {
  const parts = path.split(/[\\/]/).filter(Boolean);
  // A network share: "\\server\share" is its root.
  if (path.startsWith('\\\\') && parts.length >= 2) {
    let acc = `\\\\${parts[0]}\\${parts[1]}`;
    const out = [{ name: acc, path: acc }];
    for (const p of parts.slice(2)) out.push({ name: p, path: (acc = `${acc}\\${p}`) });
    return out;
  }
  const windows = /^[A-Za-z]:\\/.test(path);
  const sep = windows ? '\\' : '/';
  const out: { name: string; path: string }[] = windows ? [] : [{ name: '/', path: '/' }];
  let acc = '';
  parts.forEach((p, i) => {
    // Windows: "C:\" then "C:\Users", …; elsewhere: "/Users", "/Users/me", …
    acc = windows ? (i === 0 ? `${p}${sep}` : `${acc.replace(/\\$/, '')}${sep}${p}`) : `${acc}/${p}`;
    out.push({ name: p, path: acc });
  });
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readRecentFolders(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_FOLDERS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rememberFolder(path: string): void {
  const list = [path, ...readRecentFolders().filter((p) => p !== path)].slice(0, MAX_RECENT_FOLDERS);
  localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(list));
}
