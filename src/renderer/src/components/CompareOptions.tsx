import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDownIcon } from './icons';
import type { WhitespaceMode } from '../../../engine';

const WHITESPACE_LABELS: Record<WhitespaceMode, string> = {
  exact: 'Compare whitespace',
  trim: 'Ignore leading/trailing',
  collapse: 'Ignore whitespace changes',
  ignore: 'Ignore all whitespace',
};

interface CompareOptionsProps {
  whitespace: WhitespaceMode;
  onWhitespaceChange: (mode: WhitespaceMode) => void;
  ignoreCase: boolean;
  onIgnoreCaseChange: (value: boolean) => void;
}

/**
 * One dropdown for the settings that decide what counts as a difference: the whitespace mode
 * and Ignore case. The button summarises what is active.
 */
export function CompareOptions(props: CompareOptionsProps) {
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
    // Start keyboard users on the checked whitespace option.
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const choose = (run: () => void) => {
    run();
    setOpen(false);
    buttonRef.current?.focus();
  };

  // Arrow keys move between the items.
  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const summary = WHITESPACE_LABELS[props.whitespace] + (props.ignoreCase ? ' · Ignore case' : '');

  return (
    <div className="options" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="options-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="What counts as a difference"
        onClick={() => setOpen((o) => !o)}
      >
        {summary}
        <span className="options-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>
      {open && (
        <div className="options-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          <div className="options-heading" role="presentation">
            Whitespace
          </div>
          {(Object.keys(WHITESPACE_LABELS) as WhitespaceMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={mode === props.whitespace}
              onClick={() => choose(() => props.onWhitespaceChange(mode))}
            >
              <span className="options-tick" aria-hidden="true">
                {mode === props.whitespace ? '✓' : ''}
              </span>
              {WHITESPACE_LABELS[mode]}
            </button>
          ))}
          <div className="options-separator" role="separator" />
          <div className="options-heading" role="presentation">
            Letters
          </div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={props.ignoreCase}
            title="Treat text that differs only in capitalisation as the same: lines like “Foo” and “foo” count as matching, and such words are not highlighted"
            onClick={() => choose(() => props.onIgnoreCaseChange(!props.ignoreCase))}
          >
            <span className="options-tick" aria-hidden="true">
              {props.ignoreCase ? '✓' : ''}
            </span>
            Ignore case
          </button>
        </div>
      )}
    </div>
  );
}
