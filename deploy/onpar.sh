#!/usr/bin/env bash
# On Par on a server. Run from the repository folder, for example /opt/onpar:
#   deploy/onpar.sh install [address]   first time: secrets, build, start (address defaults to <public-ip>.sslip.io)
#   deploy/onpar.sh update              fetch the latest code, rebuild and restart (migrations run automatically)
#   deploy/onpar.sh status              what is running, and the web address
#   deploy/onpar.sh logs                the last lines from each part
#   deploy/onpar.sh company "Company name" "Admin full name" admin@example.co.za
#   deploy/onpar.sh demo                load the demo company (for testing only)
#   deploy/onpar.sh password their@email.co.za   new temporary password for a user (and lifts a sign-in lock)
#   deploy/onpar.sh backup              encrypted backup now (kept in backups/, newest 14)
#   deploy/onpar.sh reset               DELETES ALL DATA and makes new secrets (before real data, or if the secrets leaked)
set -euo pipefail
cd "$(dirname "$0")/.."
DEPLOY=deploy
ENV_FILE=$DEPLOY/.env
compose() { docker compose --env-file "$ENV_FILE" -f $DEPLOY/docker-compose.yml "$@"; }
rand() { openssl rand -hex "${1:-24}"; }
# Photos and certificates are written by the app's own user, so it must own the folder.
fix_uploads() { compose exec -T -u root api chown node:node /data/uploads 2>/dev/null || true; }

case "${1:-}" in
  reset)
    # Start again with new secrets: every company, user, guard, photo and backup on this server is deleted.
    echo "This deletes ALL On Par data on this server (companies, users, guards, photos, backups)"
    echo "and creates a new DATA_KEY and backup passphrase. It cannot be undone."
    read -r -p 'To continue, type DELETE EVERYTHING and press Enter: ' answer
    if [ "$answer" != "DELETE EVERYTHING" ]; then echo "Stopped. Nothing was deleted."; exit 1; fi
    if [ -f "$ENV_FILE" ]; then compose --profile tools down -v --remove-orphans || true; fi
    rm -f "$ENV_FILE" "$DEPLOY/backup-passphrase" backups/onpar-*.tar.enc backups/onpar-*.tar.enc.sha256
    echo "Everything deleted. Installing again with new secrets..."
    exec "$0" install "${2:-}"
    ;;
  install)
    if [ ! -f "$ENV_FILE" ]; then
      address="${2:-}"
      if [ -z "$address" ]; then
        ip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
        address="$(echo "$ip" | tr . -).sslip.io"
      fi
      umask 077
      cat > "$ENV_FILE" <<ENV
# Generated $(date -u +%Y-%m-%dT%H:%MZ). Keep a copy of DATA_KEY somewhere safe: without it, ID numbers and photos cannot be read.
ONPAR_DOMAIN=$address
POSTGRES_PASSWORD=$(rand)
ONPAR_OWNER_PASSWORD=$(rand)
ONPAR_APP_PASSWORD=$(rand)
JWT_SECRET=$(rand 48)
DATA_KEY=$(openssl rand -base64 32)
ENV
      rand 32 > $DEPLOY/backup-passphrase
      chmod 600 $DEPLOY/backup-passphrase
      echo "Created $ENV_FILE and $DEPLOY/backup-passphrase (secrets for this server)."
    fi
    mkdir -p backups
    compose --profile tools build
    compose up -d
    fix_uploads
    # A nightly encrypted backup at 02:15 (server time: South Africa).
    (crontab -l 2>/dev/null | grep -v 'onpar.sh backup' || true; echo "15 2 * * * $(pwd)/deploy/onpar.sh backup >> $(pwd)/backups/backup.log 2>&1") | crontab -
    echo "Waiting for On Par to finish setting up its database..."
    for i in $(seq 1 90); do
      compose exec -T api node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
      sleep 2
    done
    echo
    echo "On Par is running at https://$(grep ^ONPAR_DOMAIN= "$ENV_FILE" | cut -d= -f2)"
    echo "The first visit can take a minute while the HTTPS certificate is fetched."
    ;;
  update)
    git pull --ff-only
    compose --profile tools build
    compose up -d
    fix_uploads
    docker image prune -f >/dev/null
    echo "Updated."
    ;;
  status)
    compose ps
    echo "Web address: https://$(grep ^ONPAR_DOMAIN= "$ENV_FILE" | cut -d= -f2)"
    ;;
  logs)
    compose logs --tail 50
    ;;
  company)
    shift
    compose exec api node dist/db/company-cli.js "$@"
    ;;
  demo)
    compose exec api node dist/db/seed-cli.js
    ;;
  password)
    shift
    compose exec api node dist/db/password-cli.js "$@"
    ;;
  backup)
    compose --profile tools run --rm tools /scripts/backup.sh
    ls -1t backups/onpar-*.tar.enc | tail -n +15 | while read -r old; do rm -f "$old" "$old.sha256"; done
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 1
    ;;
esac
