#!/bin/bash
# Builds the landing page on this machine and copies it to the server. It's built here, not there, because that
# server also runs production apps. DEPLOY_HOST comes from the environment or .env, e.g. user@fridayai.my.id.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-$(grep -E '^DEPLOY_HOST=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)}"
[ -n "$HOST" ] || { echo "Set DEPLOY_HOST in .env (user@host)." >&2; exit 1; }

cd "$ROOT/website"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u # nvm reads variables that may be unset
  . "$HOME/.nvm/nvm.sh"
  nvm install >/dev/null
  set -u
fi
npm ci --no-audit --no-fund --loglevel=error
npm run build
rsync -az --delete-delay --delay-updates dist/ "$HOST:/var/www/friday/"
curl -fsS -o /dev/null -w "https://fridayai.my.id/ answered %{http_code}\n" https://fridayai.my.id/
