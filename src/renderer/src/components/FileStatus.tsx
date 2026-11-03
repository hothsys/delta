import { eolSummary, encodingLabel, formatBytes, formatLines, formatSize, type FileDetails } from '../model/fileDetails';

interface FileStatusProps {
  side: 'a' | 'b';
  /** Null for a side with no file yet (missing from one of two compared folders). */
  details: FileDetails | null;
  lines: number;
  trailingNewline: boolean;
  edited: boolean;
  /** Conventions that differ from the other side, emphasised. */
  differs: { encoding: boolean; eol: boolean; newline: boolean };
}

/**
 * The status line under a pane: the file's encoding, size, line count and line endings, as
 * most editors show. What differs from the other side is emphasised, so a BOM or CRLF/LF
 * mismatch stands out even when every line matches.
 */
export function FileStatus({ side, details, lines, trailingNewline, edited, differs }: FileStatusProps) {
  const cls = (differ: boolean) => `fs-item${differ ? ' differs' : ''}`;
  const why = (differ: boolean, title: string) => (differ ? `${title} The other side differs.` : title);
  if (!details) {
    return (
      <div className={`file-status file-status-${side}`}>
        <span className="fs-item">Not saved yet</span>
        <span className="fs-item">{formatLines(lines)}</span>
      </div>
    );
  }
  const eol = eolSummary(details.eolCounts);
  const encoding = encodingLabel(details.encoding, details.asciiOnly);
  return (
    <div className={`file-status file-status-${side}`}>
      <span className={cls(differs.encoding)} title={why(differs.encoding, `Encoding: ${encoding}.${details.asciiOnly ? ' Plain ASCII (a subset of UTF-8).' : ''}`)}>
        {encoding}
      </span>
      <span className={cls(differs.eol)} title={why(differs.eol, eol.title)}>
        {eol.label}
      </span>
      <span className="fs-item" title={`${lines.toLocaleString('en-US')} ${lines === 1 ? 'line' : 'lines'}${edited ? ', including unsaved edits' : ''}`}>
        {formatLines(lines)}
      </span>
      {lines > 0 && (!trailingNewline || differs.newline) && (
        <span className={cls(differs.newline)} title={why(differs.newline, trailingNewline ? 'The last line ends with a line break.' : 'The last line has no line break after it.')}>
          {trailingNewline ? 'Newline at end' : 'No newline at end'}
        </span>
      )}
      <span className="fs-item" title={`${formatBytes(details.size)} on disk${edited ? ' when last saved; unsaved edits aren’t counted' : ''}`}>
        {formatSize(details.size)}
        {edited && ' (edited)'}
      </span>
    </div>
  );
}
