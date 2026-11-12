#!/bin/bash
# [CUSTOM] One-time setup of the dev (design) copy of WhatsCRM.
#
#   bash /home/hunaixon/whatscrm/scripts/dev/setup-dev.sh
#
# Before running it, in cPanel:
#   1. MySQL Databases: create database  hunaixon_automation_dev  and add the
#      SAME database user production uses to it with ALL PRIVILEGES.
#   2. Domains: create the subdomain you want for the copy (default below:
#      dev.hunaix.online).
#
# What it does (production is only READ, never changed):
#   - clones the GitHub "dev" branch into /home/hunaixon/whatscrm-dev
#   - copies the production database into the dev database (no table locks)
#   - wipes every token/secret in the dev copy (scripts/dev/sandbox.sql)
#   - writes the dev .env with DEV_SANDBOX=1 (no WhatsApp, no jobs)
set -euo pipefail

PROD=/home/hunaixon/whatscrm
DEV=/home/hunaixon/whatscrm-dev
DEV_DB="${DEV_DB:-hunaixon_automation_dev}"
DEV_URL="${DEV_URL:-https://dev.hunaix.online}"
REPO="https://github.com/omarhabib199899-design/call-center.git"

envval() { grep -E "^$1=" "$PROD/.env" | tail -1 | cut -d= -f2- | tr -d "\r" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
PROD_DB="$(envval DBNAME)"; DBUSER="$(envval DBUSER)"; DBPASS="$(envval DBPASS)"
DBHOST="$(envval DBHOST)"; DBHOST="${DBHOST:-localhost}"

[ -n "$PROD_DB" ] || { echo "DBNAME not found in $PROD/.env"; exit 1; }
if [ "$PROD_DB" = "$DEV_DB" ]; then echo "STOP: dev DB name equals production DB"; exit 1; fi
case "$DEV_DB" in *dev*) ;; *) echo "STOP: dev DB name must contain 'dev'"; exit 1;; esac

MY="--host=$DBHOST --user=$DBUSER"
export MYSQL_PWD="$DBPASS"

echo "== checking the dev database exists and is empty"
mysql $MY -e "USE \`$DEV_DB\`" || { echo "Create $DEV_DB in cPanel > MySQL Databases first (and add user $DBUSER to it)"; exit 1; }
n=$(mysql $MY -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DEV_DB'")
if [ "$n" != "0" ]; then echo "STOP: $DEV_DB already has $n tables. Empty it first if you really want a fresh copy."; exit 1; fi

echo "== code: cloning branch dev into $DEV"
if [ -e "$DEV" ]; then echo "STOP: $DEV already exists"; exit 1; fi
read -s -p "GitHub token: " TOKEN; echo
git clone --branch dev "https://omarhabib199899-design:$TOKEN@github.com/omarhabib199899-design/call-center.git" "$DEV"
unset TOKEN
cd "$DEV"
git remote set-url origin "$REPO"          # don't keep the token in .git/config
git update-index --skip-worktree node_modules 2>/dev/null || true   # never commit a changed node_modules link
mkdir -p sessions client/public/meta-media

echo "== database: copying $PROD_DB -> $DEV_DB (no locks on production)"
mysqldump $MY --single-transaction --quick --no-tablespaces --routines --skip-triggers "$PROD_DB" \
  | mysql $MY "$DEV_DB"

echo "== database: removing tokens and secrets from the copy"
sed "s/__DEV_DB__/$DEV_DB/g" "$DEV/scripts/dev/sandbox.sql" | mysql $MY --force "$DEV_DB"

echo "== .env for dev"
grep -vE '^(DBNAME|FRONTENDURI|BACKURI|DEV_SANDBOX|PORT|QR_FULL_HISTORY)=' "$PROD/.env" > "$DEV/.env"
cat >> "$DEV/.env" <<ENV
DBNAME=$DEV_DB
FRONTENDURI=$DEV_URL
BACKURI=$DEV_URL
DEV_SANDBOX=1
ENV
chmod 600 "$DEV/.env"
unset MYSQL_PWD

echo
echo "Done. Next, in cPanel > Setup Node.js App > Create Application:"
echo "  Node.js version: same as production (24)"
echo "  Application root: whatscrm-dev"
echo "  Application URL:  ${DEV_URL#https://}"
echo "  Startup file:     server.js"
echo "Do NOT click 'Run NPM Install'. Then run:"
echo "  bash $DEV/scripts/dev/link-modules.sh"
