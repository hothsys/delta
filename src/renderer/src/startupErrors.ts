/**
 * Shows an error on the page if Delta fails to start, instead of leaving it blank. Imported
 * first by `main.tsx`, so it is listening before any other module runs. Only acts while
 * nothing has rendered (or after React has unmounted everything following a render error).
 */
function show(error: unknown): void {
  const root = document.getElementById('root');
  if (!root || root.childElementCount > 0) return;
  const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Most browsers' stacks already start with the message; Safari's don't.
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  const text = stack.includes(summary) ? stack : `${summary}\n${stack}`;
  const box = document.createElement('div');
  box.className = 'startup-error';
  const title = document.createElement('h1');
  title.textContent = 'Delta couldn’t start';
  const hint = document.createElement('p');
  hint.textContent = 'Reloading the page may help. If it keeps happening, please report the error below.';
  const detail = document.createElement('pre');
  detail.textContent = `${text}\n\n${navigator.userAgent}`;
  box.append(title, hint, detail);
  root.replaceChildren(box);
}

window.addEventListener('error', (e) => show(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => show(e.reason));
