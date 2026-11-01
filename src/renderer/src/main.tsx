import './startupErrors';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/josefin-sans';
import { App } from './App';
import { DialogHost } from './components/DialogHost';
import { api } from './platform';
import './styles.css';

// Delta doesn't open dropped files. Refuse drops everywhere, so a file dragged onto the window
// can't make the browser (or Electron) navigate to it and replace the app, losing unsaved edits.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {!api.capabilities.nativeDialogs && <DialogHost />}
  </StrictMode>,
);
