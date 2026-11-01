import { useEffect, useRef } from 'react';
import type { ConfirmOptions } from '../../../shared/api';

/** The browser version's confirmation dialog (the desktop app uses the native one). Enter confirms, Esc cancels. */
export function ConfirmDialog({ options, onDone }: { options: ConfirmOptions; onDone: (confirmed: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div className="modal-backdrop confirm-backdrop" onKeyDown={(e) => e.key === 'Escape' && onDone(false)}>
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-label={options.message}>
        <p className="confirm-message">{options.message}</p>
        {options.detail && <p className="confirm-detail">{options.detail}</p>}
        <div className="fb-footer">
          <div className="spacer" />
          <button type="button" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" className="primary" onClick={() => onDone(true)}>
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
