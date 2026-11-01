import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDownIcon } from './icons';
import type { FolderCompareMode } from '../../../shared/api';

const MODES: { mode: FolderCompareMode; label: string; detail: string }[] = [
  { mode: 'contents', label: 'Contents', detail: 'Exact. Reads files; slower on large or external folders.' },
  { mode: 'size-date', label: 'Size and modified date', detail: 'Fast. Never opens files.' },
  { mode: 'date', label: 'Modified date only', detail: 'Fastest. Ignores size and content.' },
];

interface FolderCompareOptionsProps {
  mode: FolderCompareMode;
  onChange: (mode: FolderCompareMode) => void;
}

/** The folder view's "Compare by" dropdown: how files present on both sides are judged equal. */
export function FolderCompareOptions({ mode, onChange }: FolderCompareOptionsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on any press outside, or on Escape (returning focus to the button).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length]?.focus();
  };

  const current = MODES.find((m) => m.mode === mode) ?? MODES[0];

  return (
    <div className="options" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="options-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="How files present on both sides are compared"
        onClick={() => setOpen((o) => !o)}
      >
        Compare by: {current.label}
        <span className="options-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>
      {open && (
        <div className="options-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          <div className="options-heading" role="presentation">
            Compare files by
          </div>
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="menuitemradio"
              aria-checked={m.mode === mode}
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
                if (m.mode !== mode) onChange(m.mode);
              }}
            >
              <span className="options-tick" aria-hidden="true">
                {m.mode === mode ? '✓' : ''}
              </span>
              <span className="options-item">
                {m.label}
                <span className="options-detail">{m.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
