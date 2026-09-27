#!/usr/bin/env bash
# On Par backup: the whole database plus stored files, in one encrypted file.
#
# Usage:  scripts/backup.sh
# Needs:  DATABASE_OWNER_URL      the database to back up (owner role)
#         BACKUP_PASSPHRASE_FILE  a file holding the backup passphrase (keep it apart from the backups)
# Optional: UPLOAD_DIR (default ./uploads; left out when STORAGE_DRIVER=s3, as S3 has its own versioning),
#           BACKUP_DIR (default ./backups)
#
# Stored files are already encrypted by On Par; the database dump is encrypted here.
# In production, the host's own automated backups (for example RDS snapshots with
# point-in-time recovery) run as well; this script is the portable, tested fallback.
set -euo pipefail

: "${DATABASE_OWNER_URL:?Set DATABASE_OWNER_URL}"
: "${BACKUP_PASSPHRASE_FILE:?Set BACKUP_PASSPHRASE_FILE}"
UPLOAD_DIR="${UPLOAD_DIR:-./uploads}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
[ -s "$BACKUP_PASSPHRASE_FILE" ] || { echo "The passphrase file is missing or empty." >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
mkdir -p "$BACKUP_DIR"

# 1. The database, in PostgreSQL's own format (schema, data, security policies, triggers and grants).
pg_dump --format=custom --no-owner --dbname="$DATABASE_OWNER_URL" --file="$work/db.dump"

# 2. Row counts, so a restore can prove it is complete.
psql "$DATABASE_OWNER_URL" -At -v ON_ERROR_STOP=1 -c "
  SELECT string_agg(format('%s %s', relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', relname), false, true, '')))[1]::text), E'\n' ORDER BY relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'" > "$work/row-counts.txt"

# 3. Stored photos and certificates (local storage only).
if [ "${STORAGE_DRIVER:-local}" != "s3" ] && [ -d "$UPLOAD_DIR" ]; then
  tar -C "$UPLOAD_DIR" -cf "$work/files.tar" .
fi
echo "created=$stamp" > "$work/manifest.txt"

# 4. One encrypted file, plus its checksum.
out="$BACKUP_DIR/onpar-$stamp.tar.enc"
tar -C "$work" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$out"
sha256sum "$out" | awk '{print $1}' > "$out.sha256"
echo "$out"
