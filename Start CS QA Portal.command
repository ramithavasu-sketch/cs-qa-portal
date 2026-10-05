#!/bin/bash
# Double-click to start the CS QA Portal in local review mode (macOS).
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and try again."
  read -r -p "Press Enter to close…"; exit 1
fi
echo "Preparing the portal (first run takes a minute)…"
npm install --no-audit --no-fund --loglevel=error || { read -r -p "npm install failed. Press Enter to close…"; exit 1; }
( sleep 4; open "http://localhost:5173" ) &
echo "Portal running at http://localhost:5173  —  keep this window open. Press Ctrl+C to stop."
npm run local
