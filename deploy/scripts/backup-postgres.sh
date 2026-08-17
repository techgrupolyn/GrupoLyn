#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/var/backups/lyn}
RETENTION_DAYS=${RETENTION_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

install -d -m 0700 "$BACKUP_DIR"
sudo -u postgres pg_dump --format=custom --file="$BACKUP_DIR/superagente-${STAMP}.dump" superagente
sudo -u postgres pg_dump --format=custom --file="$BACKUP_DIR/evolution_db-${STAMP}.dump" evolution_db
find "$BACKUP_DIR" -type f -name '*.dump' -mtime +"$RETENTION_DAYS" -delete
