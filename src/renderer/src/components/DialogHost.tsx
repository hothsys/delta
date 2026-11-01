import { useEffect, useState } from 'react';
import type { ConfirmOptions } from '../../../shared/api';
import { registerDialogs, type PickRequest } from '../platform/dialogs';
import { ConfirmDialog } from './ConfirmDialog';
import { FileBrowser } from './FileBrowser';

/** Presents the in-app file browser and confirmations for hosts without native dialogs. */
export function DialogHost() {
  const [pickState, setPick] = useState<{ request: PickRequest; resolve: (path: string | null) => void } | null>(null);
  const [confirmState, setConfirm] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);

  useEffect(() => {
    registerDialogs({
      pick: (request) => new Promise((resolve) => setPick({ request, resolve })),
      confirm: (options) => new Promise((resolve) => setConfirm({ options, resolve })),
    });
    return () => registerDialogs(null);
  }, []);

  return (
    <>
      {pickState && (
        <FileBrowser
          request={pickState.request}
          onDone={(path) => {
            setPick(null);
            pickState.resolve(path);
          }}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          options={confirmState.options}
          onDone={(ok) => {
            setConfirm(null);
            confirmState.resolve(ok);
          }}
        />
      )}
    </>
  );
}
