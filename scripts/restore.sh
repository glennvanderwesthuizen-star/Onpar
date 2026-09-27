#!/usr/bin/env bash
# On Par restore: puts a backup from scripts/backup.sh into an EMPTY database and file folder,
# then checks every table has the same number of rows as when it was backed up.
#
# Usage:  scripts/restore.sh backups/onpar-20260927T120000Z.tar.enc
# Needs:  TARGET_DATABASE_URL     an empty database (owner role); never the live one
#         TARGET_UPLOAD_DIR       where the stored files go
#         BACKUP_PASSPHRASE_FILE  the passphrase file used for the backup
set -euo pipefail

backup="${1:?Give the backup file to restore}"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL}"
: "${TARGET_UPLOAD_DIR:?Set TARGET_UPLOAD_DIR}"
: "${BACKUP_PASSPHRASE_FILE:?Set BACKUP_PASSPHRASE_FILE}"

if [ -f "$backup.sha256" ] && [ "$(sha256sum "$backup" | awk '{print $1}')" != "$(cat "$backup.sha256")" ]; then
  echo "The backup file does not match its checksum. It may be damaged; do not use it." >&2
  exit 1
fi

tables="$(psql "$TARGET_DATABASE_URL" -At -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'")"
if [ "$tables" != "0" ]; then
  echo "The target database is not empty ($tables tables). Restore only into a new, empty database." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$backup" | tar -C "$work" -xf -; then
  echo "Could not open the backup. Check the passphrase file." >&2
  exit 1
fi

pg_restore --no-owner --clean --if-exists --exit-on-error --dbname="$TARGET_DATABASE_URL" "$work/db.dump"

mkdir -p "$TARGET_UPLOAD_DIR"
[ -f "$work/files.tar" ] && tar -C "$TARGET_UPLOAD_DIR" -xf "$work/files.tar"

# Prove it is complete: every table's row count must match the backup's.
psql "$TARGET_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "
  SELECT string_agg(format('%s %s', relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', relname), false, true, '')))[1]::text), E'\n' ORDER BY relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'" > "$work/restored-counts.txt"
if ! diff -u "$work/row-counts.txt" "$work/restored-counts.txt"; then
  echo "Restore incomplete: row counts differ (shown above)." >&2
  exit 1
fi
echo "Restore complete: $(wc -l < "$work/row-counts.txt") tables, all row counts match. $(cat "$work/manifest.txt")"
