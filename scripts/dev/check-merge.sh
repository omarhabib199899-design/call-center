#!/bin/bash
# [CUSTOM] Run before merging dev into production:
#   bash scripts/dev/check-merge.sh
# Lists what the merge would change and stops on anything that touches the
# WhatsApp / Facebook / Instagram connection code or other risky files.
set -uo pipefail
cd "$(dirname "$0")/../.."
git fetch -q origin dev production
CHANGED=$(git diff --name-only origin/production...origin/dev)
[ -n "$CHANGED" ] || { echo "dev has nothing new for production"; exit 0; }
echo "Files dev would change in production:"; echo "$CHANGED" | sed 's/^/  /'

RISKY='^(node_modules|\.env|sessions/|server\.js|app\.js|socket\.js|database/|helper/addon/qr/|helper/addon/insta/|helper/addon/telegram/|helper/inbox/|helper/markRead\.js|helper/readSync\.js|helper/socket/|routes/(insta|messenger|qr|qrPairing|inbox|meta)[^/]*\.js|loops/|automation/|package(-lock)?\.json)'
BAD=$(echo "$CHANGED" | grep -E "$RISKY" || true)
if [ -n "$BAD" ]; then
  echo; echo "!! STOP — these touch connections/backend. Review them with Omar/Claude before merging:"
  echo "$BAD" | sed 's/^/  /'; exit 1
fi
echo; echo "OK — design/front-end only. Safe to merge."
