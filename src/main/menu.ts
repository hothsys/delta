import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import type { Command } from '../shared/api';
import { acceleratorFor, MENU, type MenuEntry } from '../shared/menu';

/** Which checkbox items are on (Debug Logging). */
let isChecked: (command: Command) => boolean = () => false;

/** A click handler sending `command` to the window the menu was used in. */
const send =
  (command: Command) =>
  (_item: unknown, win: Electron.BaseWindow | undefined) => {
    const target = (win as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (target) target.webContents.send('menu:command', command);
    // No window to act on (macOS keeps running without one): undo the check mark's toggle.
    else installMenu();
  };

/** The native items for one shared menu entry. */
function nativeItems(entry: MenuEntry, isMac: boolean): MenuItemConstructorOptions[] {
  if (entry === 'separator') return [{ type: 'separator' }];
  if ('command' in entry) {
    return [
      {
        label: entry.label,
        accelerator: acceleratorFor(entry, isMac),
        click: send(entry.command),
        ...(entry.checkbox && { type: 'checkbox' as const, checked: isChecked(entry.command) }),
      },
    ];
  }
  switch (entry.role) {
    case 'cut':
    case 'copy':
    case 'paste':
      return [{ role: entry.role }];
    case 'close':
      return [isMac ? { role: 'close' } : { role: 'quit' }];
    case 'zoom':
      return [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }];
    case 'fullscreen':
      return [{ role: 'togglefullscreen' }];
    case 'devtools':
      return app.isPackaged ? [] : [{ role: 'toggleDevTools' }];
  }
}

/**
 * The application menu, built from the shared definition in `src/shared/menu.ts`. It replaces
 * Electron's default, whose Reload item (Cmd/Ctrl+R) would silently discard unsaved edits.
 * Undo, Redo and Select All are routed to the renderer's own editor; the native roles would act
 * on the hidden input element instead.
 */
export function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    ...MENU.filter((s) => s.label !== 'Help').map((section) => ({ label: section.label, submenu: section.items.flatMap((e) => nativeItems(e, isMac)) })),
    { role: 'windowMenu' },
    // Last, where every platform expects Help.
    ...MENU.filter((s) => s.label === 'Help').map((section) => ({ role: 'help' as const, submenu: section.items.flatMap((e) => nativeItems(e, isMac)) })),
  ];
  return Menu.buildFromTemplate(template);
}

/** Sets (or refreshes, after a checkbox changed) the application menu. */
export function installMenu(checked = isChecked): void {
  isChecked = checked;
  Menu.setApplicationMenu(buildMenu());
}
