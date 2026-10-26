#!/usr/bin/env bash
# arena-tester installer for the load-generator server ("server 3"), Ubuntu/Debian.
#   curl -fsSL https://raw.githubusercontent.com/OWNER/arena-tester/main/install.sh | sudo bash
# Optional env: DASH_PASSWORD=...  DIR=/opt/arena-tester  REPO=https://github.com/OWNER/arena-tester.git
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
REPO="${REPO:-__REPO_URL__}"
DIR="${DIR:-/opt/arena-tester}"

if ! command -v docker >/dev/null; then
  echo ">> installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"

if [ ! -f .env ]; then
  PASS="${DASH_PASSWORD:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)}"
  echo "DASH_PASSWORD=$PASS" > .env
  chmod 600 .env
  echo ">> dashboard password: $PASS   (saved in $DIR/.env)"
fi

docker compose up -d --build
IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "arena-tester is running:  http://$IP:8080   (any username, password from .env)"
echo "IMPORTANT: open ports 8080 (dashboard) and 8081 (test download source) only to your own IPs:"
echo "  ufw allow from <YOUR_IP> to any port 8080 proto tcp"
echo "  ufw allow from <SERVER_A_IP> to any port 8081 proto tcp   # and the same for server B"
