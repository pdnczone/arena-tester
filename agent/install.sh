#!/usr/bin/env bash
# arena-tester agent: run this on a SERVER UNDER TEST (the machine that runs the panel / proxy).
# Easiest: copy the ready-made command from the dashboard (Settings -> Servers -> "Install agent"), e.g.
#   curl -fsSL https://raw.githubusercontent.com/pdnczone/arena-tester/main/agent/install.sh | sudo ENROLL_URL=http://DASH_IP:8080 ENROLL_TOKEN=xxxx bash
# Optional env: PORT=9100  TOKEN=...  TEST_PORT=24443  RAW_BASE=...
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/pdnczone/arena-tester/main}"
PORT="${PORT:-9100}"
TEST_PORT="${TEST_PORT:-24443}"
TOKEN="${TOKEN:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
DIR=/opt/arena-agent

command -v python3 >/dev/null || { apt-get update -y && apt-get install -y python3; }
command -v curl >/dev/null || { apt-get update -y && apt-get install -y curl; }
mkdir -p "$DIR"
if [ -f "$(dirname "$0")/agent.py" ] && [ "${0##*/}" = "install.sh" ]; then cp "$(dirname "$0")/agent.py" "$DIR/agent.py"; else curl -fsSL "$RAW_BASE/agent/agent.py" -o "$DIR/agent.py"; fi

cat >/etc/systemd/system/arena-agent.service <<UNIT
[Unit]
Description=arena-tester agent
After=network.target
[Service]
Environment=TOKEN=$TOKEN
Environment=PORT=$PORT
ExecStart=/usr/bin/python3 $DIR/agent.py
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now arena-agent
systemctl restart arena-agent

# Firewall: let only the dashboard server reach the agent and the test inbound port.
DASH_HOST=""
if [ -n "${ENROLL_URL:-}" ]; then DASH_HOST="$(echo "$ENROLL_URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"; fi
DASH_IP="$DASH_HOST"
if [ -n "$DASH_HOST" ] && ! echo "$DASH_HOST" | grep -Eq '^[0-9.]+$'; then DASH_IP="$(getent hosts "$DASH_HOST" | awk '{print $1; exit}')"; fi
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active" && [ -n "$DASH_IP" ]; then
  ufw allow from "$DASH_IP" to any port "$PORT" proto tcp >/dev/null && echo ">> ufw: agent port $PORT opened for $DASH_IP"
  ufw allow from "$DASH_IP" to any port "$TEST_PORT" proto tcp >/dev/null && echo ">> ufw: test inbound port $TEST_PORT opened for $DASH_IP"
else
  echo ">> no active ufw (or unknown dashboard IP): make sure ports $PORT and $TEST_PORT are reachable from the dashboard server"
fi

MYIP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo ">> agent running on http://$MYIP:$PORT"

if [ -n "${ENROLL_URL:-}" ] && [ -n "${ENROLL_TOKEN:-}" ]; then
  if OUT="$(curl -fsS --max-time 15 -X POST "$ENROLL_URL/api/enroll" -H 'content-type: application/json' \
      -d "{\"token\":\"$ENROLL_TOKEN\",\"agentUrl\":\"http://$MYIP:$PORT\",\"agentToken\":\"$TOKEN\"}" 2>&1)"; then
    echo ">> registered with the dashboard: $OUT"
    echo "Done. Nothing else to do on this server."
  else
    echo "!! could not reach the dashboard at $ENROLL_URL ($OUT)"
    echo "   open the dashboard port to this server, or enter manually: agent URL http://$MYIP:$PORT  token $TOKEN"
    exit 1
  fi
else
  echo "Manual setup: agent URL  http://$MYIP:$PORT   token  $TOKEN"
fi
