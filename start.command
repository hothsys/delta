#!/usr/bin/env bash
# Starts Delta's browser version and opens it in your browser.
#
#   Double-click in Finder (macOS), or run ./start.command [--port N] [left right]
#
# The first start installs dependencies and builds, which takes a minute. Ctrl+C, or closing
# the window, stops Delta.

# Finder doesn't load your shell profile, so look where Node is usually installed
# (Homebrew, nvm, Volta) if it isn't already on PATH.
if ! command -v node >/dev/null 2>&1; then
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" $(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V -r); do
    if [[ -x "$dir/node" ]]; then
      export PATH="$dir:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Delta needs Node.js 22.12 or newer: https://nodejs.org"
  [[ -t 0 ]] && read -r -p "Press Return to close."
  exit 1
fi

node "$(dirname "$0")/web/start.mjs" "$@" || { [[ -t 0 ]] && read -r -p "Press Return to close."; exit 1; }
