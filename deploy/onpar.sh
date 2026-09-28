#!/usr/bin/env bash
# On Par on a server. Run from the repository folder, for example /opt/onpar:
#   deploy/onpar.sh install [address]   first time: secrets, build, start (address defaults to <public-ip>.sslip.io)
#   deploy/onpar.sh update              fetch the latest code, rebuild and restart (migrations run automatically)
#   deploy/onpar.sh status              what is running, and the web address
#   deploy/onpar.sh logs                the last lines from each part
#   deploy/onpar.sh company "Company name" "Admin full name" admin@example.co.za
#   deploy/onpar.sh demo                load the demo company (for testing only)
#   deploy/onpar.sh backup              encrypted backup now (kept in backups/, newest 14)
set -euo pipefail
cd "$(dirname "$0")/.."
DEPLOY=deploy
ENV_FILE=$DEPLOY/.env
compose() { docker compose --env-file "$ENV_FILE" -f $DEPLOY/docker-compose.yml "$@"; }
rand() { openssl rand -hex "${1:-24}"; }

case "${1:-}" in
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
  backup)
    compose --profile tools run --rm tools /scripts/backup.sh
    ls -1t backups/onpar-*.tar.enc | tail -n +15 | while read -r old; do rm -f "$old" "$old.sha256"; done
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 1
    ;;
esac
