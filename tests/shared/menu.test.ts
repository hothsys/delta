import { describe, expect, it } from 'vitest';
import { commandForKey, formatAccelerator, matchesAccelerator, MENU } from '../../src/shared/menu';

const key = (k: string, mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {}) => ({
  key: k,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('matchesAccelerator', () => {
  it('maps CmdOrCtrl to Command on macOS and Control elsewhere', () => {
    expect(matchesAccelerator('CmdOrCtrl+S', key('s', { meta: true }), true)).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+S', key('s', { ctrl: true }), true)).toBe(false);
    expect(matchesAccelerator('CmdOrCtrl+S', key('s', { ctrl: true }), false)).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+S', key('s', { meta: true }), false)).toBe(false);
  });

  it('requires exactly the listed modifiers, whatever the letter case', () => {
    expect(matchesAccelerator('CmdOrCtrl+Shift+S', key('S', { meta: true, shift: true }), true)).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+S', key('S', { meta: true, shift: true }), true)).toBe(false);
    expect(matchesAccelerator('F7', key('F7', { shift: true }), true)).toBe(false);
    expect(matchesAccelerator('Shift+F7', key('F7', { shift: true }), true)).toBe(true);
  });
});

describe('commandForKey', () => {
  it('finds the command for each shortcut on each platform', () => {
    expect(commandForKey(key('o', { meta: true }), true)).toBe('compare-files');
    expect(commandForKey(key('O', { meta: true, shift: true }), true)).toBe('compare-folders');
    expect(commandForKey(key('z', { meta: true, shift: true }), true)).toBe('redo');
    expect(commandForKey(key('y', { ctrl: true }), false)).toBe('redo');
    expect(commandForKey(key('y', { meta: true }), true)).toBeNull();
    expect(commandForKey(key('F5'), true)).toBe('refresh');
    expect(commandForKey(key('F7', { shift: true }), false)).toBe('previous-difference');
    expect(commandForKey(key('w', { meta: true }), true)).toBeNull();
    expect(commandForKey(key('s'), true)).toBeNull();
  });
});

describe('formatAccelerator', () => {
  it('uses symbols in macOS order there, and words elsewhere', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+S', true)).toBe('⇧⌘S');
    expect(formatAccelerator('CmdOrCtrl+Shift+S', false)).toBe('Ctrl+Shift+S');
    expect(formatAccelerator('Shift+F7', true)).toBe('⇧F7');
    expect(formatAccelerator('F5', false)).toBe('F5');
  });
});

describe('MENU', () => {
  it('lists every command exactly once', () => {
    const commands = MENU.flatMap((s) => s.items).flatMap((e) => (typeof e === 'object' && 'command' in e ? [e.command] : []));
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands.sort()).toEqual(
      [
        'compare-files', 'compare-folders', 'save', 'save-as', 'save-left', 'save-right',
        'refresh', 'undo', 'redo', 'select-all', 'toggle-theme', 'next-difference', 'previous-difference',
        'toggle-debug-logging', 'open-logs-folder', 'copy-diagnostics',
      ].sort(),
    );
  });
});
