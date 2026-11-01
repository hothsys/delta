/** Toolbar button with a house icon that returns to the start screen. */
export function HomeButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="icon-button" onClick={onClick} title="Home: start screen and recent comparisons" aria-label="Home">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9" />
      </svg>
    </button>
  );
}
