#!/usr/bin/env bash
# On Par on a server. Run from the repository folder, for example /opt/onpar:
#   deploy/onpar.sh install [address]   first time: secrets, build, start (address defaults to <public-ip>.sslip.io)
#   deploy/onpar.sh update              backup first, then fetch the latest code, rebuild and restart (migrations run
#                                       automatically); keeps going on the server even if this window closes
#   deploy/onpar.sh rollback            go back to the version before the last update (the database stays as it is)
#   deploy/onpar.sh progress            how the last update is going (or how it ended)
#   deploy/onpar.sh status              what is running, and the web address
#   deploy/onpar.sh logs                the last lines from each part
#   deploy/onpar.sh company "Company name" "Admin full name" admin@example.co.za
#   deploy/onpar.sh demo                load the demo company (for testing only)
#   deploy/onpar.sh password their@email.co.za   new temporary password for a user (and lifts a sign-in lock)
#   deploy/onpar.sh backup              encrypted backup now (kept in backups/, newest 7)
#   deploy/onpar.sh server-updates      switch on the server's own security updates, with a restart at 03:30 when needed
#   deploy/onpar.sh reset               DELETES ALL DATA and makes new secrets (before real data, or if the secrets leaked)
set -euo pipefail
cd "$(dirname "$0")/.."
DEPLOY=deploy
ENV_FILE=$DEPLOY/.env
compose() { docker compose --env-file "$ENV_FILE" -f $DEPLOY/docker-compose.yml "$@"; }
rand() { openssl rand -hex "${1:-24}"; }
# Photos and certificates are written by the app's own user, so it must own the folder.
fix_uploads() { compose exec -T -u root api chown node:node /data/uploads 2>/dev/null || true; }

# Everything below is read in full before it runs, so an update that replaces this file mid-way is safe.
main() {
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
    if [ -z "${ONPAR_IN_BACKGROUND:-}" ]; then
      # Run on the server itself, not tied to this window: if the browser loses its connection the
      # update carries on. Progress goes to a log file; this window just shows it.
      mkdir -p logs
      log="logs/update-$(date +%Y%m%d-%H%M%S).log"
      ln -sf "$(basename "$log")" logs/update-latest.log
      ONPAR_IN_BACKGROUND=1 setsid nohup "$PWD/deploy/onpar.sh" update >"$log" 2>&1 </dev/null &
      echo "Updating on the server. It keeps going even if you close this window."
      echo "To see how it is going later: deploy/onpar.sh progress"
      echo
      tail -n +1 -f "$log" --pid=$! || true
      exit 0
    fi
    echo $$ > logs/update.pid
    echo "Update started $(date)."
    # A backup first, so a bad update can always be undone. If the backup fails, nothing is changed.
    echo "Making a backup before updating..."
    main backup
    git rev-parse HEAD > logs/before-update.commit
    git pull --ff-only
    # Fresh base images (database, front door, Node) so security fixes reach the server too.
    compose pull db caddy
    # Plain progress lines, so the log file is easy to read.
    BUILDKIT_PROGRESS=plain compose --profile tools build --pull
    compose up -d
    fix_uploads
    docker image prune -f >/dev/null
    # Old build leftovers fill the disk over time.
    docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
    echo "Updated. Finished $(date)."
    ;;
  rollback)
    if [ ! -f logs/before-update.commit ]; then echo "There is no earlier version recorded yet."; exit 1; fi
    previous=$(cat logs/before-update.commit)
    echo "Going back to version $(git log -1 --format='%h %s' "$previous")."
    echo "The database is not changed. If the update changed it, the backup made just before"
    echo "the update is in backups/ (the newest file from before the update)."
    git reset --hard "$previous"
    BUILDKIT_PROGRESS=plain compose --profile tools build
    compose up -d
    fix_uploads
    echo "Back on the earlier version. The next 'update' brings the latest code again."
    ;;
  server-updates)
    # For servers set up before 9 Oct 2026 (new ones get this from server-setup.sh). Asks for the server password.
    sudo apt-get -o DPkg::Lock::Timeout=600 install -y unattended-upgrades
    printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
    printf '%s\n' 'Unattended-Upgrade::Automatic-Reboot "true";' 'Unattended-Upgrade::Automatic-Reboot-Time "03:30";' | sudo tee /etc/apt/apt.conf.d/52onpar-reboot >/dev/null
    echo "Security updates are on. The server restarts itself at 03:30 when an update needs it."
    if [ -f /var/run/reboot-required ]; then echo "An update is already waiting for a restart: it will happen tonight at 03:30."; fi
    ;;
  progress)
    if [ ! -e logs/update-latest.log ]; then echo "No update has been run this way yet."; exit 0; fi
    if [ -f logs/update.pid ] && kill -0 "$(cat logs/update.pid)" 2>/dev/null; then echo "An update is still running. Last lines:"; else echo "No update running now. The last one ended like this:"; fi
    tail -n 15 logs/update-latest.log
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
    ls -1t backups/onpar-*.tar.enc | tail -n +8 | while read -r old; do rm -f "$old" "$old.sha256"; done
    ;;
  *)
    sed -n '2,14p' "$0"
    exit 1
    ;;
esac
}
main "$@"
exit $?
