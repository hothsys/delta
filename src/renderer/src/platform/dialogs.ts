import type { ConfirmOptions } from '../../../shared/api';

/** What the in-app file browser is asked to choose. */
export interface PickRequest {
  mode: 'file' | 'folder' | 'save';
  title: string;
  /** Save mode: the suggested file name (or a full path to start from). */
  defaultName?: string;
}

export interface DialogPresenter {
  pick(request: PickRequest): Promise<string | null>;
  confirm(options: ConfirmOptions): Promise<boolean>;
}

let presenter: DialogPresenter | null = null;

/**
 * Hosts without native dialogs (the browser version) show in-app ones. The interface
 * registers how to present them; the platform client calls through here.
 */
export function registerDialogs(p: DialogPresenter | null): void {
  presenter = p;
}

export function pick(request: PickRequest): Promise<string | null> {
  if (!presenter) return Promise.resolve(null);
  return presenter.pick(request);
}

export function confirmInPage(options: ConfirmOptions): Promise<boolean> {
  if (!presenter) return Promise.resolve(false);
  return presenter.confirm(options);
}
