import type { DiffStats, WhitespaceMode } from '../../../engine';
import { CompareOptions } from './CompareOptions';
import { HomeButton } from './HomeButton';
import { RefreshIcon } from './icons';
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
  busy: boolean;
  elapsedMs: number;
  canRefresh: boolean;
  onRefresh: () => void;
  /** Present when this comparison was opened from a folder comparison. */
  onBackToFolders?: () => void;
  /** Back to the start screen (the comparison stays open and can be resumed). */
  onHome: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const { stats } = props;
  return (
    <div className="toolbar">
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

      <div className="spacer" />

      <span className="stats">
        {stats && (
          <>
            <strong>{stats.changeBlocks === 0 ? 'Identical' : `${stats.changeBlocks} ${stats.changeBlocks === 1 ? 'difference' : 'differences'}`}</strong>
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
  );
}
