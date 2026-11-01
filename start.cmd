@echo off
rem Starts Delta's browser version and opens it in your browser.
rem
rem   Double-click in Explorer, or run: start.cmd [--port N] [left right]
rem
rem The first start installs dependencies and builds, which takes a minute. Ctrl+C, or closing
rem the window, stops Delta.

where node >nul 2>nul
if errorlevel 1 (
  echo Delta needs Node.js 22.12 or newer: https://nodejs.org
  pause
  exit /b 1
)

node "%~dp0web\start.mjs" %*
if errorlevel 1 pause
