import { useCallback, useState } from 'react';

/** Narrowest a pane may be dragged to, in CSS pixels. */
export const MIN_PANE_WIDTH = 160;

/**
 * The left pane's share of the space shared by both panes (0..1), remembered between launches
 * under `storageKey`.
 */
export function useSplit(storageKey: string): [number, (ratio: number) => void] {
  const [split, setSplitState] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return saved > 0 && saved < 1 ? saved : 0.5;
  });
  const setSplit = useCallback(
    (ratio: number) => {
      setSplitState(ratio);
      localStorage.setItem(storageKey, String(ratio));
    },
    [storageKey],
  );
  return [split, setSplit];
}

/**
 * The split ratio for a divider dragged to `clientX`, given the container's bounds, the total
 * width of its fixed columns, and the divider's own width.
 */
export function ratioAt(clientX: number, rect: DOMRect, fixedWidth: number, dividerWidth: number): number {
  const available = rect.width - fixedWidth;
  if (available <= 2 * MIN_PANE_WIDTH) return 0.5;
  const left = clientX - rect.left - dividerWidth / 2;
  const min = MIN_PANE_WIDTH / available;
  return Math.min(1 - min, Math.max(min, left / available));
}
