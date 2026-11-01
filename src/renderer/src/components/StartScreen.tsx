import type { RecentComparison, RecentSide } from '../../../shared/api';
import logoUrl from '../assets/logo.svg';
import { tildePath } from '../model/paths';
import type { Theme } from './Toolbar';
import { ThemeButton } from './ThemeButton';

interface StartScreenProps {
  onCompareFiles: () => void;
  onCompareFolders: () => void;
  recents: RecentComparison[];
  /** The user's home folder, shown as ~ in paths. */
  homeDir: string;
  onOpenRecent: (item: RecentComparison) => void;
  onForgetRecent: (item: RecentComparison) => void;
  /** Present when a comparison is open behind this screen. */
  resume?: { label: string; run: () => void };
  theme: Theme;
  onToggleTheme: () => void;
}

const isMac = navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? '⌘' : 'Ctrl+';

/** The first screen: compare two files or two folders, or reopen a recent comparison. */
export function StartScreen(props: StartScreenProps) {
  const side = (label: string, s: RecentSide) => (
    <span className="recent-path">
      <span className="recent-side">{label}</span>
      <span className="recent-text" title={s.path}>
        {shorten(s.path, props.homeDir)}
      </span>
      {s.state === 'unmounted' && <span className="flag warn">Drive “{s.volume}” is not connected</span>}
      {s.state === 'missing' && <span className="flag warn">Not found</span>}
      {s.state === 'available' && s.volume && <span className="flag">External drive “{s.volume}”</span>}
    </span>
  );

  return (
    <div className="start">
      <ThemeButton theme={props.theme} onToggle={props.onToggleTheme} className="icon-button start-theme" />
      <div className="start-body">
        {/* Decorative: the heading below names the app. */}
        <img className="start-logo" src={logoUrl} alt="" draggable={false} />
        <h1>Delta</h1>
        <p className="start-lead">What would you like to compare?</p>
        {props.resume && (
          <button type="button" className="start-resume" onClick={props.resume.run}>
            Resume <strong>{props.resume.label}</strong>
          </button>
        )}
        <div className="start-choices">
          <button type="button" className="start-choice" onClick={props.onCompareFiles}>
            <span className="start-icon" aria-hidden="true">
              ▤ ▤
            </span>
            <strong>Compare Files</strong>
            <span>Choose two files to see and merge their differences.</span>
            <kbd>{mod}O</kbd>
          </button>
          <button type="button" className="start-choice" onClick={props.onCompareFolders}>
            <span className="start-icon" aria-hidden="true">
              ▦ ▦
            </span>
            <strong>Compare Folders</strong>
            <span>Choose two folders to find files that differ and copy them across.</span>
            <kbd>{mod}⇧O</kbd>
          </button>
        </div>

        {props.recents.length > 0 && (
          <section className="recents" aria-label="Recent comparisons">
            <h2>Recent comparisons</h2>
            <ul>
              {props.recents.map((item) => {
                const unavailable = item.left.state !== 'available' || item.right.state !== 'available';
                return (
                  <li
                    key={`${item.kind}\0${item.left.path}\0${item.right.path}`}
                    className={unavailable ? 'unavailable' : undefined}
                    title={unavailable ? 'Not available: connect the drive or restore the missing path to open this comparison.' : undefined}
                  >
                    <button type="button" className="recent" disabled={unavailable} onClick={() => props.onOpenRecent(item)}>
                      <span className="recent-icon" aria-label={item.kind === 'folders' ? 'Folders' : 'Files'}>
                        {item.kind === 'folders' ? '▦' : '▤'}
                      </span>
                      <span className="recent-paths">
                        {side('Left', item.left)}
                        {side('Right', item.right)}
                      </span>
                      <span className="recent-time">{ago(item.at)}</span>
                    </button>
                    <button
                      type="button"
                      className="recent-forget"
                      title="Remove from recent comparisons"
                      aria-label="Remove from recent comparisons"
                      onClick={() => props.onForgetRecent(item)}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** Replaces the home folder with ~ and elides the middle of very long paths, keeping the end. */
function shorten(path: string, home: string): string {
  let p = tildePath(path, home);
  if (p.length > 80) p = p.slice(0, 28) + '…' + p.slice(-50);
  return p;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(at: number): string {
  const minutes = Math.round((at - Date.now()) / 60000);
  if (minutes > -1) return 'just now';
  if (minutes > -60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relative.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days > -7) return relative.format(days, 'day');
  return new Date(at).toLocaleDateString();
}
