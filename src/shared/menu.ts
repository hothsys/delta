import type { Command } from './api';

/**
 * Delta's menus, defined once: the desktop app builds its native menu from this, and the
 * browser version its in-page menu bar and keyboard shortcuts, so the two can't drift apart.
 *
 * Accelerators use Electron's syntax (`CmdOrCtrl+Shift+S`, `F7`).
 */
export type MenuEntry =
  | {
      command: Command;
      label: string;
      accelerator?: string;
      /** Where macOS uses a different accelerator (Redo: Cmd+Shift+Z there, Ctrl+Y elsewhere). */
      macAccelerator?: string;
      /** Shown with a check mark when on (the host says which are). */
      checkbox?: true;
    }
  /** Provided by the desktop host only (the browser has its own clipboard, zoom and window keys). */
  | { role: 'cut' | 'copy' | 'paste' | 'close' | 'zoom' | 'fullscreen' | 'devtools' }
  | 'separator';

export interface MenuSection {
  label: string;
  items: MenuEntry[];
}

export const MENU: MenuSection[] = [
  {
    label: 'File',
    items: [
      { command: 'compare-files', label: 'Compare Files…', accelerator: 'CmdOrCtrl+O' },
      { command: 'compare-folders', label: 'Compare Folders…', accelerator: 'CmdOrCtrl+Shift+O' },
      'separator',
      { command: 'save', label: 'Save', accelerator: 'CmdOrCtrl+S' },
      { command: 'save-as', label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S' },
      { command: 'save-left', label: 'Save Left' },
      { command: 'save-right', label: 'Save Right' },
      'separator',
      { command: 'refresh', label: 'Refresh from Disk', accelerator: 'F5' },
      'separator',
      { role: 'close' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { command: 'undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z' },
      { command: 'redo', label: 'Redo', accelerator: 'Ctrl+Y', macAccelerator: 'Cmd+Shift+Z' },
      'separator',
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { command: 'select-all', label: 'Select All', accelerator: 'CmdOrCtrl+A' },
    ],
  },
  {
    label: 'View',
    items: [
      { command: 'next-difference', label: 'Next Difference', accelerator: 'F7' },
      { command: 'previous-difference', label: 'Previous Difference', accelerator: 'Shift+F7' },
      'separator',
      { command: 'toggle-theme', label: 'Toggle Dark Mode' },
      'separator',
      { role: 'zoom' },
      'separator',
      { role: 'fullscreen' },
      { role: 'devtools' },
    ],
  },
  {
    label: 'Help',
    items: [
      { command: 'toggle-debug-logging', label: 'Debug Logging', checkbox: true },
      { command: 'open-logs-folder', label: 'Open Logs Folder' },
      { command: 'copy-diagnostics', label: 'Copy Diagnostic Info' },
    ],
  },
];

/** The accelerator an entry uses on this platform, if any. */
export function acceleratorFor(entry: { accelerator?: string; macAccelerator?: string }, isMac: boolean): string | undefined {
  return (isMac && entry.macAccelerator) || entry.accelerator;
}

interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** True when a key press is exactly `accelerator` (no extra modifiers). */
export function matchesAccelerator(accelerator: string, e: KeyLike, isMac: boolean): boolean {
  const parts = accelerator.split('+');
  const key = parts.pop()!.toLowerCase();
  const want = { meta: false, ctrl: false, shift: false, alt: false };
  for (const p of parts) {
    if (p === 'CmdOrCtrl') want[isMac ? 'meta' : 'ctrl'] = true;
    else if (p === 'Cmd') want.meta = true;
    else if (p === 'Ctrl') want.ctrl = true;
    else if (p === 'Shift') want.shift = true;
    else if (p === 'Alt') want.alt = true;
  }
  return (
    e.key.toLowerCase() === key &&
    e.metaKey === want.meta &&
    e.ctrlKey === want.ctrl &&
    e.shiftKey === want.shift &&
    e.altKey === want.alt
  );
}

/** The command a key press triggers, if any. */
export function commandForKey(e: KeyLike, isMac: boolean): Command | null {
  for (const section of MENU) {
    for (const entry of section.items) {
      if (typeof entry === 'string' || !('command' in entry)) continue;
      const acc = acceleratorFor(entry, isMac);
      if (acc && matchesAccelerator(acc, e, isMac)) return entry.command;
    }
  }
  return null;
}

/** An accelerator as shown in a menu: `⇧⌘S` on macOS, `Ctrl+Shift+S` elsewhere. */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parts = accelerator.split('+');
  const key = parts.pop()!;
  if (!isMac) return [...parts.map((p) => (p === 'CmdOrCtrl' ? 'Ctrl' : p)), key].join('+');
  const symbol: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘', CmdOrCtrl: '⌘' };
  // macOS orders modifiers Control, Option, Shift, Command.
  const order = ['Ctrl', 'Alt', 'Shift', 'Cmd', 'CmdOrCtrl'];
  return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((p) => symbol[p]).join('') + key;
}
