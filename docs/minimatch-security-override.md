# Temporary minimatch security override

The dependency audit flags GHSA-g3hv-75wg-m249 (CVE-2026-118764) in
minimatch 9.0.9 and 10.2.6. Both arrive through Electron packaging dependencies,
not a direct application import.

The current stable electron-builder/app-builder-lib versions still require the
affected majors. This candidate uses version-range-specific npm overrides for
the 9.x and 10.x requirements to resolve to patched minimatch 11.0.9 or newer
within major 11. Unaffected minimatch 3.x and 5.x dependencies are not overridden.
Remove these overrides once compatible upstream parent updates eliminate the
flagged versions.

This is a deliberate cross-major compatibility tradeoff, not an ordinary patch
update. The PR stays draft pending review and real macOS packaging validation.

## Checks

- Clean `npm ci --ignore-scripts` and `npm ls minimatch` succeed.
- OSV-Scanner 2.7.1 lockfile scan exits 0 after the update.
- Typecheck and `npm run build:web` pass.
- New regression tests exercise the actual electron-builder file filter,
  dotfiles, exclusions and partial directories, plus the `matchBase` API used by
  Electron universal packaging and resolution of unaffected minimatch 3.x.
- Full suite: 294 pass, one existing copy-cancellation test fails. The same test
  fails on the unmodified main commit in a separate checkout. This change does
  not attempt to fix that unrelated behavior.

Not validated here: signed installers, macOS universal packaging, Windows
packaging, or runtime exploit reachability. These smoke tests do not replace
cross-platform packaging tests.

Sources:
- https://github.com/hothsys/delta/issues/33
- https://osv.dev/GHSA-g3hv-75wg-m249
