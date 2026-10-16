@echo off
title FlowStudio Lite
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install Node.js 18+ from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo Installing dependencies for the first run. This can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

call npx electron .
