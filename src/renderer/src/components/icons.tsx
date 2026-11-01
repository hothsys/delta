/** Small line icons drawn in the current text colour, so they follow the theme. */

const base = {
  width: 17,
  height: 17,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** A floppy disk. */
export function SaveIcon() {
  return (
    <svg {...base}>
      <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M7 3v5h8V3" />
      <path d="M7 21v-7h10v7" />
    </svg>
  );
}

/** A curved arrow pointing back. */
export function UndoIcon() {
  return (
    <svg {...base}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

/** A circular arrow: reload from disk. */
export function RefreshIcon() {
  return (
    <svg {...base}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

/**
 * A merge action pointing at the side it changes: an arrow (copy this change across), or a
 * delete key (remove the lines there, because this side has none to copy).
 */
export function MergeIcon({ toward, remove = false }: { toward: 'left' | 'right'; remove?: boolean }) {
  return (
    <svg {...base} width={14} height={14} strokeWidth={2.2} style={toward === 'left' ? { transform: 'scaleX(-1)' } : undefined}>
      {remove ? (
        <>
          <path d="M3 5h12l6 7-6 7H3z" />
          <path d="M7 9l6 6M13 9l-6 6" />
        </>
      ) : (
        <>
          <path d="M3 12h15" />
          <path d="M13 6l6 6-6 6" />
        </>
      )}
    </svg>
  );
}

/** A small downward chevron: this button opens a menu. */
export function ChevronDownIcon() {
  return (
    <svg {...base} width={12} height={12} strokeWidth={2.5}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
