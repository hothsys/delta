export interface NoticeState {
  kind: 'error' | 'info';
  text: string;
  /** Optional buttons shown before Dismiss. */
  actions?: { label: string; run: () => void }[];
}

/** A dismissable bar under the toolbar for errors and questions that should not block. */
export function Notice({ notice, onDismiss }: { notice: NoticeState; onDismiss: () => void }) {
  return (
    <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span className="notice-text">{notice.text}</span>
      {notice.actions?.map((a) => (
        <button key={a.label} type="button" onClick={a.run}>
          {a.label}
        </button>
      ))}
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
