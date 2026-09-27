#!/usr/bin/env bash
# First-time setup of a new Ubuntu 24.04 server for On Par. Run once, as the default user:
#   curl -fsSL <this file> | bash      (or paste it into the server's terminal)
# It installs Docker, adds a 2 GB swap file, creates a key so the server can fetch the
# code from GitHub, and prints the next step.
set -euo pipefail
sudo apt-get update -y
sudo apt-get install -y git curl openssl ca-certificates
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
sudo timedatectl set-timezone Africa/Johannesburg
# Automatic security updates for the server itself.
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
if [ ! -f ~/.ssh/onpar_deploy ]; then
  ssh-keygen -t ed25519 -N '' -f ~/.ssh/onpar_deploy -C "onpar-server" >/dev/null
  cat >> ~/.ssh/config <<CFG
Host github.com
  IdentityFile ~/.ssh/onpar_deploy
  StrictHostKeyChecking accept-new
CFG
fi
echo
echo "================================================================"
echo "Next: add this key to GitHub as a read-only Deploy key:"
echo
cat ~/.ssh/onpar_deploy.pub
echo
echo "Then run:  newgrp docker  and follow step 5 in docs/HOSTING.md"
echo "================================================================"
