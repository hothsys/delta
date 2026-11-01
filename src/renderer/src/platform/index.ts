import type { DeltaApi } from '../../../shared/api';
import { createHttpApi } from './http';

/**
 * The system bridge for whichever host Delta is running in: Electron's preload provides
 * `window.delta`; in a browser, Delta talks to its local server.
 */
export const api: DeltaApi = window.delta ?? createHttpApi();
