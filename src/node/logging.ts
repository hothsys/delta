import { mkdirSync, readFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { dirname, join } from 'node:path';
import type { LogInfo, LogLevelSource } from '../shared/api';
import { writeFileAtomic } from './files';
import { initLog, log, logFile, logLevel, recentLines, resolveLogLevel, setLogLevel } from './log';

/**
 * Logging set-up shared by the desktop app and the browser version's server: which level to
 * use, the Debug Logging setting (kept in Delta's settings folder, so it applies to both), and
 * Copy Diagnostic Info.
 */

interface Settings {
  logLevel?: string;
}

const settingsFile = (dataDir: string) => join(dataDir, 'settings.json');

function readSettings(dataDir: string): Settings {
  try {
    const value: unknown = JSON.parse(readFileSync(settingsFile(dataDir), 'utf8'));
    return value && typeof value === 'object' ? (value as Settings) : {};
  } catch {
    return {};
  }
}

let levelFrom: LogLevelSource = 'default';

export interface StartLogging {
  /** The logs folder. */
  dir: string;
  name: string;
  /** Delta's settings folder, where the Debug Logging setting lives. */
  dataDir: string;
  /** `--log-level` from the command line, if given. */
  cli?: string;
}

/** Opens the log at the level the command line, DELTA_LOG_LEVEL or the setting asks for. */
export function startLogging(options: StartLogging): LogInfo {
  const { level, from } = resolveLogLevel({ cli: options.cli, env: process.env.DELTA_LOG_LEVEL, saved: readSettings(options.dataDir).logLevel });
  levelFrom = from;
  try {
    initLog({ dir: options.dir, name: options.name, level });
  } catch (err) {
    console.error(`Delta can't write its log in ${options.dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return logInfo();
}

export const logInfo = (): LogInfo => ({ level: logLevel(), from: levelFrom, file: logFile() });

/** The Help menu's Debug Logging: applies now, and is saved for later starts. */
export async function setDebugLogging(dataDir: string, on: boolean): Promise<LogInfo> {
  const level = on ? 'debug' : 'info';
  log.info('app', `Debug logging turned ${on ? 'on' : 'off'}`);
  setLogLevel(level);
  levelFrom = 'setting';
  const settings = readSettings(dataDir);
  if (on) settings.logLevel = level;
  else delete settings.logLevel;
  try {
    mkdirSync(dataDir, { recursive: true });
    await writeFileAtomic(settingsFile(dataDir), JSON.stringify(settings, null, 2) + '\n', 0o600);
  } catch (err) {
    log.warn('app', 'Could not save the logging setting', err as Error);
  }
  return logInfo();
}

export const logsFolder = (): string | null => {
  const f = logFile();
  return f && dirname(f);
};

/** Versions, settings and the latest log lines, for pasting into a bug report. */
export function diagnostics(host: string, version: string, dataDir: string): string {
  const info = logInfo();
  return [
    `Delta ${version} (${host})`,
    `Node ${process.versions.node}${process.versions.electron ? `, Electron ${process.versions.electron}, Chromium ${process.versions.chrome}` : ''}`,
    `System: ${process.platform} ${release()} ${arch()}`,
    `Log level: ${info.level} (from ${info.from})`,
    `Log file: ${info.file ?? 'none'}`,
    `Settings folder: ${dataDir}`,
    '',
    'Latest log entries:',
    ...recentLines(100),
  ].join('\n');
}
