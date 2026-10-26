#!/usr/bin/env bash
# Install the vpn-bench agent as a systemd service.
# Usage:  sudo TOKEN=mysecret [PORT=9100] bash install.sh
set -euo pipefail
: "${TOKEN:?set TOKEN=... first}"
PORT="${PORT:-9100}"
DIR=/opt/vpn-bench-agent
command -v python3 >/dev/null || { apt-get update -y && apt-get install -y python3; }
mkdir -p "$DIR"
cp "$(dirname "$0")/agent.py" "$DIR/agent.py"
cat >/etc/systemd/system/vpn-bench-agent.service <<EOF
[Unit]
Description=vpn-bench agent
After=network.target
[Service]
Environment=TOKEN=$TOKEN
Environment=PORT=$PORT
ExecStart=/usr/bin/python3 $DIR/agent.py
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now vpn-bench-agent
echo "agent running on :$PORT"
echo "IMPORTANT: allow port $PORT only from the load-generator IP, e.g.:"
echo "  ufw allow from <GENERATOR_IP> to any port $PORT proto tcp"
