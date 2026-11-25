# Development

```sh
npm install
npm run dev        # the desktop app with hot reload
npm run web:dev    # the browser version with hot reload
```

| Command | What it does |
|---|---|
| `npm run dev` | Run the desktop app in development mode |
| `npm run web:dev` | Run the browser version in development mode |
| `npm test` | Run the unit tests |
| `npm run test:e2e` | Build, then run end-to-end checks of the browser version in a real page |
| `npm run screenshots` | Build, then retake the README's screenshots (`docs/images`); `npm run screenshots -- start.png` retakes just one. Only images that actually changed are rewritten |
| `npm run typecheck` | Type-check the whole project |
| `npm run build` | Build the app into `dist/app/` |
| `npm start` | Build and run the desktop app |
| `npm run web` | Run the browser version (same as `start.command`) |
| `npm run dist` | Build installers for your platform into `dist/installers/` |
| `npm run dist:mac` / `dist:win` / `dist:linux` | Build installers for a specific platform |
| `npm run clean` | Delete `dist/` (builds and installers); everything in it can be rebuilt |

Installers are configured in `desktop/electron-builder.yml`; they're unsigned unless you add code-signing credentials there (or `CSC_LINK` / `CSC_KEY_PASSWORD` in CI). The GitHub Actions workflow (`.github/workflows/build.yml`) builds all three platforms on version tags.

## Project structure

```
src/          the source code
  engine/       the diff engine (pure TypeScript, unit-tested)
  renderer/     the React interface (desktop and browser)
  main/         desktop: Electron main process, native menu
  preload/      desktop: the secure bridge between the interface and the main process
  server/       browser: the local server and its security checks
  node/         file, folder, recents, watching and logging code used by both
  shared/       types and the menu definition used everywhere
tests/        unit tests, and e2e/ (end-to-end checks of the browser version)
desktop/      how the desktop installers are built (electron-builder.yml, app icon)
web/          the browser version's start script (start.mjs, run by start.command and
              start.cmd), its server build config and the dev server script
start.command, start.cmd   start the browser version (macOS/Linux, Windows)
docs/         images/ (the screenshots in this README) and screenshots/ (the script that takes
              them, capture.mjs, and the demo project they show)
dist/         everything generated (not in git): app/ (compiled app), installers/
```

## Built with

[Electron](https://www.electronjs.org/), [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vite.dev/) with [electron-vite](https://electron-vite.org/), [Vitest](https://vitest.dev/) and [electron-builder](https://www.electron.build/). Prettify uses [Prettier](https://prettier.io/) for JavaScript, TypeScript and CSS. The interface font is [Josefin Sans](https://github.com/ThomasJockin/JosefinSansFont-master) (SIL Open Font License).
