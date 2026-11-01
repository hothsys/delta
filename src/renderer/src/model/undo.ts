import type { Side } from './rowModel';
import { composeOps, type EditOp, type Selection } from './textEdit';

export interface UndoEntry {
  side: Side;
  op: EditOp;
  /** Selection to restore on undo. */
  before: Selection;
  /** Selection to restore on redo. */
  after: Selection;
  /** Consecutive entries with the same group (e.g. typing) merge into one undo step. */
  group?: string;
  time: number;
}

/** Consecutive same-group edits closer together than this merge into one undo step. */
const GROUP_WINDOW_MS = 1000;
const MAX_ENTRIES = 1000;

/** One history for both sides, so undo reverts the most recent change wherever it was made. */
export class UndoHistory {
  private done: UndoEntry[] = [];
  private undone: UndoEntry[] = [];
  /** Sides whose oldest entries were trimmed away, so their opened (or saved) state can't be undone back to. */
  private lost: Record<Side, boolean> = { a: false, b: false };

  push(entry: UndoEntry): void {
    this.undone = [];
    const last = this.done[this.done.length - 1];
    if (
      entry.group &&
      last &&
      last.group === entry.group &&
      last.side === entry.side &&
      entry.time - last.time < GROUP_WINDOW_MS
    ) {
      const merged = composeOps(last.op, entry.op);
      if (merged) {
        last.op = merged;
        last.after = entry.after;
        last.time = entry.time;
        return;
      }
    }
    this.done.push(entry);
    if (this.done.length > MAX_ENTRIES) this.lost[this.done.shift()!.side] = true;
  }

  /** The entry to revert (apply its inverse), or null if there is nothing to undo. */
  undo(): UndoEntry | null {
    const e = this.done.pop();
    if (!e) return null;
    this.undone.push(e);
    return e;
  }

  /**
   * The most recent entry for one side, even if the other side changed more recently.
   * Edits never span both sides, so undoing one side out of order leaves the other intact.
   */
  undoSide(side: Side): UndoEntry | null {
    for (let i = this.done.length - 1; i >= 0; i--) {
      if (this.done[i].side !== side) continue;
      const [e] = this.done.splice(i, 1);
      this.undone.push(e);
      return e;
    }
    return null;
  }

  /** The most recent undoable entry for one side; identifies the side's position in history. */
  lastEntry(side: Side): UndoEntry | null {
    for (let i = this.done.length - 1; i >= 0; i--) if (this.done[i].side === side) return this.done[i];
    return null;
  }

  canUndo(side?: Side): boolean {
    return side ? this.done.some((e) => e.side === side) : this.done.length > 0;
  }

  /** The entry to re-apply, or null if there is nothing to redo. */
  redo(): UndoEntry | null {
    const e = this.undone.pop();
    if (!e) return null;
    this.done.push(e);
    return e;
  }

  /**
   * Forgets one side's history, for when its document is replaced by a newly opened file.
   * The other side's entries stay valid because edits never span both sides.
   */
  dropSide(side: Side): void {
    this.done = this.done.filter((e) => e.side !== side);
    this.undone = this.undone.filter((e) => e.side !== side);
    this.lost[side] = false;
  }

  /** True when entries of `side` were trimmed since `resetLost`, so its starting state is out of reach. */
  lostStart(side: Side): boolean {
    return this.lost[side];
  }

  /** The current state becomes the new starting point (after a save). */
  resetLost(side: Side): void {
    this.lost[side] = false;
  }

  /** Stops the next edit from merging into the previous one (e.g. after the caret is moved). */
  seal(): void {
    const last = this.done[this.done.length - 1];
    if (last) last.group = undefined;
  }
}
