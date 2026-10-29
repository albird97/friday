#!/bin/bash
# Daily backup of Friday's data, run by friday-backup.timer as the friday user (see linux-service.sh): a consistent
# copy of the database taken while Friday runs, the WhatsApp login (so a restore needs no re-linking) and .env.
# Keeps 14 days in /opt/friday/backups. Pictures (data/images) are left out: they expire after 30 days anyway.
#
# Restore: sudo systemctl stop friday; sudo -u friday tar -xzf <backup> -C /opt/friday/app; sudo systemctl start friday
set -euo pipefail

APP="${APP:-/opt/friday/app}"
DEST="${DEST:-/opt/friday/backups}"
KEEP_DAYS=14

umask 077
stamp="$(date +%Y%m%d-%H%M%S)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$DEST" "$work/data"
sqlite3 "$APP/data/friday.db" ".backup '$work/data/friday.db'"
cp -r "$APP/data/whatsapp-auth" "$work/data/"
cp "$APP/.env" "$work/.env"
tar -czf "$DEST/friday-$stamp.tar.gz" -C "$work" .
find "$DEST" -name 'friday-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "Backup saved: $DEST/friday-$stamp.tar.gz ($(du -h "$DEST/friday-$stamp.tar.gz" | cut -f1))"
