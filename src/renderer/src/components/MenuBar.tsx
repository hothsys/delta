import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Command } from '../../../shared/api';
import { acceleratorFor, formatAccelerator, MENU } from '../../../shared/menu';

const isMac = navigator.platform.toUpperCase().includes('MAC');

interface Item {
  command: Command;
  label: string;
  shortcut?: string;
  checkbox?: boolean;
}

/**
 * The menus as the browser version shows them: Delta's commands only (the desktop-only roles,
 * like zoom and the clipboard, are the browser's own), with separators tidied up afterwards.
 */
const SECTIONS = MENU.map((section) => {
  const rows: (Item | 'separator')[] = [];
  for (const e of section.items) {
    if (e === 'separator') {
      if (rows.length && rows[rows.length - 1] !== 'separator') rows.push('separator');
    } else if ('command' in e) {
      const acc = acceleratorFor(e, isMac);
      rows.push({ command: e.command, label: e.label, shortcut: acc && formatAccelerator(acc, isMac), checkbox: e.checkbox });
    }
  }
  while (rows[rows.length - 1] === 'separator') rows.pop();
  // A menu with check marks leaves room for them on every row, so the labels line up.
  return { label: section.label, rows, checks: rows.some((r) => r !== 'separator' && r.checkbox) };
});

interface MenuBarProps {
  enabled: (command: Command) => boolean;
  /** Whether a checkbox item is on. */
  checked: (command: Command) => boolean;
  onCommand: (command: Command) => void;
}

/**
 * File, Edit, View and Help menus for the browser version (the desktop app has a native menu).
 * Pressing never takes focus from the editor, so commands act on what was being edited.
 * While a menu is open: arrow keys move, Enter chooses, Esc or a press elsewhere closes, and
 * hovering another menu's title switches to it.
 */
export function MenuBar({ enabled, checked, onCommand }: MenuBarProps) {
  const [open, setOpen] = useState<number | null>(null);
  /** Highlighted row in the open menu (keyboard), or -1. */
  const [active, setActive] = useState(-1);
  const barRef = useRef<HTMLDivElement>(null);
  const titles = useRef<(HTMLButtonElement | null)[]>([]);

  const close = () => {
    setOpen(null);
    setActive(-1);
  };
  const choose = (item: Item) => {
    close();
    onCommand(item.command);
  };

  useEffect(() => {
    if (open === null) return;
    const rows = SECTIONS[open].rows;
    const usable = (i: number) => rows[i] !== 'separator' && enabled((rows[i] as Item).command);
    const step = (from: number, dir: 1 | -1) => {
      for (let k = 1; k <= rows.length; k++) {
        const i = (from + dir * k + rows.length) % rows.length;
        if (usable(i)) return i;
      }
      return -1;
    };
    const onKey = (e: KeyboardEvent) => {
      let handled = true;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown') setActive((a) => step(a < 0 ? -1 : a, 1));
      else if (e.key === 'ArrowUp') setActive((a) => step(a < 0 ? rows.length : a, -1));
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        setOpen((o) => ((o ?? 0) + (e.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length);
        setActive(-1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (active >= 0 && usable(active)) choose(rows[active] as Item);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onPress = (e: Event) => {
      if (!barRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open, active, enabled]);

  // Keep the editor's focus (and selection) when the bar is pressed.
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  const panelLeft = open === null ? 0 : (titles.current[open]?.getBoundingClientRect().left ?? 0);

  return (
    <div className="menubar" ref={barRef} role="menubar" onMouseDown={keepFocus}>
      {SECTIONS.map((section, i) => (
        <button
          key={section.label}
          ref={(el) => {
            titles.current[i] = el;
          }}
          type="button"
          className={`menubar-title${open === i ? ' open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open === i}
          onClick={() => (open === i ? close() : (setOpen(i), setActive(-1)))}
          onMouseEnter={() => open !== null && open !== i && (setOpen(i), setActive(-1))}
        >
          {section.label}
        </button>
      ))}
      {open !== null && (
        <div className="context-menu menubar-panel" role="menu" aria-label={SECTIONS[open].label} style={{ left: panelLeft }}>
          {SECTIONS[open].rows.map((row, i) =>
            row === 'separator' ? (
              <div key={`sep${i}`} className="menu-separator" role="separator" />
            ) : (
              <button
                key={row.command}
                type="button"
                role={row.checkbox ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={row.checkbox ? checked(row.command) : undefined}
                className={i === active ? 'active' : ''}
                disabled={!enabled(row.command)}
                onClick={() => choose(row)}
                onMouseEnter={() => setActive(i)}
              >
                <span>
                  {SECTIONS[open].checks && <span className="menu-check">{row.checkbox && checked(row.command) ? '✓' : ''}</span>}
                  {row.label}
                </span>
                {row.shortcut && <span className="menu-shortcut">{row.shortcut}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
