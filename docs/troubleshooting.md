# Troubleshooting

- **"Delta needs Node.js 22.12 or newer"**, or npm warns about an unsupported engine: install a current Node.js from [nodejs.org](https://nodejs.org/) and start Delta again.
- **"A Delta started before an update is still running on port 5910"**: a copy from before you updated is still running and can't take over. Run `./start.command --restart` (or `start.cmd --restart`, or `npm run web -- --restart`).
- **"Port 5910 is already in use by another program"**: something else is using that port. Stop it, or start Delta on another one: `./start.command --port 5920`.
- **macOS won't open start.command** ("cannot be opened because it is from an unidentified developer", typically after downloading the project as a ZIP): right-click it, choose **Open**, then **Open** again. Or run `./start.command` in Terminal. If it says "permission denied", run `chmod +x start.command` once.
- **Ctrl+C doesn't stop it straight away while it's installing**: npm first undoes the half-finished install, which waits for downloads in progress. Delta says so; press Ctrl+C a second time to stop npm at once (the next start installs again).
- **The browser version doesn't start**: the window it runs in shows what went wrong. The first start installs dependencies and builds, so it needs an internet connection; if `npm install` fails, fix the problem it reports and start again.
- **`npm start` or `npm run dev` says "Electron uninstall" or "Electron failed to install"**: Electron's app wasn't downloaded (it's fetched on first run, and the browser version never needs it). Run `node node_modules/electron/install.js` once; if it fails, check your internet connection (or proxy settings), delete `node_modules/electron` and run `npm install` again.
- **Nothing happens when the desktop app starts from a downloaded installer** (macOS): use right-click → Open the first time, as described in [Installing and running](installing.md).
- **Anything else:** look in Delta's [log](logging.md). To report a problem, choose **Help → Copy Diagnostic Info** and paste the result into your report: it has Delta's version, your system and the latest log entries.
