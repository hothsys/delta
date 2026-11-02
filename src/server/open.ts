import { spawn } from 'node:child_process';

/** Opens a web address or a folder the way double-clicking it would (browser, Finder, Explorer). */
export function openExternally(target: string): void {
  // cmd.exe would read the "&" between a link's parameters as a command separator.
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', target.replace(/&/g, '^&')]]
        : ['xdg-open', [target]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
