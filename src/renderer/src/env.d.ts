import type { DeltaApi } from '../../shared/api';

declare global {
  interface Window {
    /** Bridge to the main process, exposed by the preload script (absent in a browser). */
    delta?: DeltaApi;
  }
}
