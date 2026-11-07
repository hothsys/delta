import type { MouseEvent } from 'react';
import type { DiffStats, WhitespaceMode } from '../../../engine';
import { CompareOptions } from './CompareOptions';
import { HomeButton } from './HomeButton';
import { ArrowDownIcon, ArrowUpIcon, RefreshIcon } from './icons';
import { ThemeButton } from './ThemeButton';

export type Theme = 'light' | 'dark';

interface ToolbarProps {
  whitespace: WhitespaceMode;
  onWhitespaceChange: (mode: WhitespaceMode) => void;
  ignoreCase: boolean;
  onIgnoreCaseChange: (value: boolean) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  stats: DiffStats | null;
  /** When the text is identical but the files still differ (encoding, line endings…), says how. */
  identicalNote?: string | null;
  /** Moves to the previous (-1) or next (1) difference. */
  onDifference: (direction: 1 | -1) => void;
  /** The difference just moved to, while the caret is still there: shown as "2 of 5". */
  position?: { index: number; total: number } | null;
  busy: boolean;
  elapsedMs: number;
  canRefresh: boolean;
  onRefresh: () => void;
  /** Present when this comparison was opened from a folder comparison. */
  onBackToFolders?: () => void;
  /** Back to the start screen (the comparison stays open and can be resumed). */
  onHome: () => void;
  prettify: {
    on: boolean;
    /** Why it can't be used for these files, if it can't. */
    unavailable?: string;
    onToggle: () => void;
  };
}

export function Toolbar(props: ToolbarProps) {
  const { stats } = props;
  const noDifferences = !stats || stats.changeBlocks === 0;
  // Pressing an arrow keeps the editor's focus and caret, so F7 and typing carry on from there.
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  return (
    <div className="toolbar toolbar-centered">
      <div className="toolbar-side">
        <HomeButton onClick={props.onHome} />
        {props.onBackToFolders && (
          <button type="button" onClick={props.onBackToFolders} title="Back to the folder comparison">
            ← Folders
          </button>
        )}
        <span className="toolbar-sep" />
        <CompareOptions
          whitespace={props.whitespace}
          onWhitespaceChange={props.onWhitespaceChange}
          ignoreCase={props.ignoreCase}
          onIgnoreCaseChange={props.onIgnoreCaseChange}
        />
        <button
          type="button"
          className={`prettify-button${props.prettify.on ? ' on' : ''}`}
          aria-pressed={props.prettify.on}
          onClick={props.prettify.onToggle}
          disabled={!!props.prettify.unavailable}
          title={
            props.prettify.unavailable ??
            (props.prettify.on ? 'Turn off Prettify and edit the files again' : 'Format both files one statement, rule or element per line, for a readable comparison (read-only)')
          }
        >
          {'{ }'} Prettify
        </button>
      </div>

      <div className="diff-nav" role="group" aria-label="Differences">
        <button
          type="button"
          className="icon-button"
          onMouseDown={keepFocus}
          onClick={() => props.onDifference(-1)}
          disabled={noDifferences}
          title="Previous difference (Shift+F7)"
          aria-label="Previous difference"
        >
          <ArrowUpIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          onMouseDown={keepFocus}
          onClick={() => props.onDifference(1)}
          disabled={noDifferences}
          title="Next difference (F7)"
          aria-label="Next difference"
        >
          <ArrowDownIcon />
        </button>
      </div>

      <div className="toolbar-side toolbar-end">
        <span className="stats">
          {stats && (
            <>
              <strong>
                {stats.changeBlocks === 0
                  ? (props.identicalNote ?? 'Identical')
                  : `${props.position ? `${props.position.index} of ` : ''}${stats.changeBlocks} ${stats.changeBlocks === 1 ? 'difference' : 'differences'}`}
              </strong>
              <span className="stat mod">{stats.modifiedPairs} modified</span>
              <span className="stat ins">{stats.insertedLines} inserted</span>
              <span className="stat del">{stats.deletedLines} deleted</span>
              {stats.unimportantLines > 0 && <span className="stat minor">{stats.unimportantLines} unimportant</span>}
              {!props.busy && <span className="elapsed">{Math.round(props.elapsedMs)} ms</span>}
            </>
          )}
          {props.busy && <span className="elapsed">Comparing…</span>}
        </span>

        <button
          type="button"
          className="icon-button"
          onClick={props.onRefresh}
          disabled={!props.canRefresh}
          title="Refresh: reload both files from disk (F5)"
          aria-label="Refresh"
        >
          <RefreshIcon />
        </button>

        <ThemeButton theme={props.theme} onToggle={() => props.onThemeChange(props.theme === 'dark' ? 'light' : 'dark')} />
      </div>
    </div>
  );
}
