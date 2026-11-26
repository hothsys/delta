# Logs

Delta keeps a log of what you do in it (files and folders compared, saves, merges, copies, settings changed) and of anything that goes wrong. It records paths, sizes, counts and timings, never the contents of your files or what you type.

All logs are in one folder, whichever version you use:

| System | Logs folder |
|---|---|
| macOS | `~/Library/Logs/Delta` |
| Windows | `%APPDATA%\Delta\logs` |
| Linux | `~/.config/Delta/logs` |

It holds `desktop.log` (the desktop app), `web.log` (the browser version) and `start.log` (what `start.command` installed and built, and why it failed if it did). **Help → Open Logs Folder** opens it, and the browser version prints its log's path when it starts. Each log is kept to 5MB: when it fills up it's renamed `.1` (and the older ones `.2` and `.3`), and the oldest is deleted, so logs never use more than about 20MB.

**More detail:** turn on **Help → Debug Logging** to also log every request, comparison timing and file read. It stays on (in both versions) until you turn it off. You can also set the level when starting Delta, which takes priority over the menu setting:

```sh
./start.command --log-level debug             # browser version (also start.cmd, npm run web -- --log-level debug)
DELTA_LOG_LEVEL=debug ./start.command         # the same, with an environment variable
/Applications/Delta.app/Contents/MacOS/Delta --log-level=debug   # desktop app on macOS
```

Levels, from least to most detail: `error`, `warn`, `info` (the default) and `debug`.
