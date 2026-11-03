#!/bin/bash
# [CUSTOM] Make the dev app use production's installed packages instead of a
# second "npm install" (which would add tens of thousands of files and could
# push the account over its file-count limit — that breaks WhatsApp logins).
set -euo pipefail
PROD_MODULES=$(readlink -f /home/hunaixon/whatscrm/node_modules)
VENV_LIB=$(ls -d /home/hunaixon/nodevenv/whatscrm-dev/*/lib 2>/dev/null | head -1)
[ -d "$PROD_MODULES" ] || { echo "production node_modules not found"; exit 1; }
[ -n "$VENV_LIB" ] || { echo "create the whatscrm-dev Node.js app in cPanel first"; exit 1; }

if [ -d "$VENV_LIB/node_modules" ] && [ ! -L "$VENV_LIB/node_modules" ]; then
  if [ -n "$(ls -A "$VENV_LIB/node_modules")" ]; then
    echo "STOP: $VENV_LIB/node_modules is not empty (was NPM Install run?)"; exit 1
  fi
  rmdir "$VENV_LIB/node_modules"
fi
ln -sfn "$PROD_MODULES" "$VENV_LIB/node_modules"
ln -sfn "$VENV_LIB/node_modules" /home/hunaixon/whatscrm-dev/node_modules
echo "dev app now uses $PROD_MODULES — restart it from cPanel"
