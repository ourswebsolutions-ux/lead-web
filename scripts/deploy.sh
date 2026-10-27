#!/usr/bin/env bash
# Updates this site on the server in one step: pulls the latest code,
# installs, prepares the database (additions only, never deletes), builds,
# restarts the PM2 process, and checks that the Lead Finder API answers with
# activation codes and the daily allowance.
#   bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
npm install --no-audit --no-fund
npm run build
pm2 restart axora-subscriptions --update-env || pm2 start ecosystem.config.cjs
pm2 save
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3060/lead-getter/health >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS http://127.0.0.1:3060/lead-getter/api/plans | grep -q '"freePlan"'; then
  echo "Lead Finder API is up to date: activation codes and daily lead allowances are live."
else
  echo "The site restarted, but the Lead Finder API is not answering with the new version. Check: pm2 logs axora-subscriptions --lines 50" >&2
  exit 1
fi
