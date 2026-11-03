interface PrettifyBarProps {
  working: boolean;
  onTurnOff: () => void;
  onCancel: () => void;
}

/** The strip under the toolbar while Prettify is on: it's read-only, and how to get out. */
export function PrettifyBar({ working, onTurnOff, onCancel }: PrettifyBarProps) {
  return (
    <div className="prettify-bar" role="status">
      {working ? (
        <>
          <span className="notice-text">Prettifying…</span>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <span className="notice-text">
            <strong>Prettified view: read-only.</strong> Line numbers refer to the formatted text.
          </span>
          <button type="button" onClick={onTurnOff}>
            Turn off
          </button>
        </>
      )}
    </div>
  );
}
