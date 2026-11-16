#!/usr/bin/env bash
# arena-tester agent: run this on a SERVER UNDER TEST (the machine that runs the panel / proxy).
# Easiest: copy the ready-made command from the dashboard (Settings -> Servers -> "Install agent"), e.g.
#   curl -fsSL https://raw.githubusercontent.com/pdnczone/arena-tester/main/agent/install.sh | sudo ENROLL_URL=http://DASH_IP:8080 ENROLL_TOKEN=xxxx bash
#   (add a NEW server: copy the command from Settings -> Servers -> "Add server" — it uses JOIN_TOKEN instead of ENROLL_TOKEN)
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

# Token lives in a 600 file, not in the world-readable unit.
cat >"$DIR/env" <<ENV
TOKEN=$TOKEN
PORT=$PORT
ENV
chmod 600 "$DIR/env"

cat >/etc/systemd/system/arena-agent.service <<UNIT
[Unit]
Description=arena-tester agent
After=network.target
[Service]
EnvironmentFile=$DIR/env
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

# Best-effort detection of what runs on this machine, so the dashboard needs no manual entry.
KIND=custom; PANEL_PROC=""; CORE_PROC=xray; PANEL_URL=""; PANEL_USER=""; PANEL_PASS=""
# Detection is best effort: a grep that finds nothing must never abort the install (set -e + pipefail would).
set +e +o pipefail
field() { echo "$1" | grep -iE "^\s*$2\s*:" | head -1 | sed -E 's/^[^:]*:\s*//' | tr -d ' \r'; }
if command -v x-ui >/dev/null 2>&1 || [ -x /usr/local/x-ui/x-ui ]; then
  KIND=3xui; PANEL_PROC=x-ui
  # The real binary (the "x-ui" on PATH is often just the menu script). Bool flags without "true".
  XBIN=/usr/local/x-ui/x-ui; [ -x "$XBIN" ] || XBIN="$(command -v x-ui)"
  SHOW="$(timeout 15 "$XBIN" setting -show 2>/dev/null)"
  XPORT="$(field "$SHOW" port | grep -oE '[0-9]+' | head -1)"
  XBASE="$(field "$SHOW" webBasePath)"
  XUSER="$(field "$SHOW" username)"
  XPASS="$(field "$SHOW" password)"
  if [ "$(field "$SHOW" hasDefaultCredential)" = "true" ] && [ -z "$XUSER" ]; then XUSER=admin; XPASS=admin; fi
  XCERT="$(field "$(timeout 15 "$XBIN" setting -getCert 2>/dev/null)" cert)"
  SCHEME=http; HOSTN="$MYIP"
  if [ -n "$XCERT" ]; then
    SCHEME=https
    # The certificate is issued for a domain, not the IP: use that domain or TLS verification fails.
    D="$(openssl x509 -in "$XCERT" -noout -ext subjectAltName 2>/dev/null | grep -oE 'DNS:[^, ]+' | head -1 | cut -d: -f2)"
    [ -n "$D" ] || D="$(openssl x509 -in "$XCERT" -noout -subject 2>/dev/null | grep -oE 'CN *= *[^,/]+' | sed -E 's/CN *= *//')"
    [ -n "$D" ] || D="$(basename "$(dirname "$XCERT")")"
    case "$D" in *.*) HOSTN="${D#\*.}";; esac
  fi
  if [ -n "$XPORT" ]; then
    case "$XBASE" in /*) ;; "") XBASE="/";; *) XBASE="/$XBASE";; esac
    PANEL_URL="$SCHEME://$HOSTN:$XPORT${XBASE%/}"
  fi
  PANEL_USER="$XUSER"
  case "$XPASS" in \$2*|"") ;; *) PANEL_PASS="$XPASS";; esac   # never a bcrypt hash
elif systemctl list-unit-files 2>/dev/null | grep -qi nexora || pgrep -f nexora >/dev/null 2>&1; then
  KIND=nexora; PANEL_PROC=nexora-panel
fi
MACHINE_ID="$( (cat /etc/machine-id 2>/dev/null || hostname) | sha256sum | cut -c1-32)"
set -e -o pipefail

register() { # $1 = extra JSON fields (token)
  ARENA_KIND="$KIND" ARENA_PROC="$PANEL_PROC" ARENA_CORE="$CORE_PROC" ARENA_PURL="$PANEL_URL" ARENA_PUSER="$PANEL_USER" ARENA_PPASS="$PANEL_PASS" \
  ARENA_AURL="http://$MYIP:$PORT" ARENA_ATOKEN="$TOKEN" ARENA_MID="$MACHINE_ID" ARENA_HOST="$(hostname)" ARENA_TOK_KEY="$1" ARENA_TOK_VAL="$2" \
  python3 - <<'PY' | curl -fsS --max-time 15 -X POST "$ENROLL_URL/api/enroll" -H 'content-type: application/json' --data-binary @-
import json, os
e = os.environ.get
print(json.dumps({e("ARENA_TOK_KEY"): e("ARENA_TOK_VAL"), "agentUrl": e("ARENA_AURL"), "agentToken": e("ARENA_ATOKEN"),
  "kind": e("ARENA_KIND"), "panelProc": e("ARENA_PROC"), "coreProc": e("ARENA_CORE"), "panelUrl": e("ARENA_PURL"),
  "username": e("ARENA_PUSER"), "password": e("ARENA_PPASS"), "machineId": e("ARENA_MID"), "hostname": e("ARENA_HOST")}))
PY
}

if [ -n "${ENROLL_URL:-}" ] && { [ -n "${JOIN_TOKEN:-}" ] || [ -n "${ENROLL_TOKEN:-}" ]; }; then
  if [ -n "${JOIN_TOKEN:-}" ]; then K=joinToken; V="$JOIN_TOKEN"; else K=token; V="$ENROLL_TOKEN"; fi
  if OUT="$(register "$K" "$V" 2>&1)"; then
    echo ">> detected: type=$KIND${PANEL_URL:+, panel=$PANEL_URL}"
    echo ">> registered with the dashboard: $OUT"
    echo "Done. The server is now in the dashboard — open it and press Start."
  else
    echo "!! could not reach the dashboard at $ENROLL_URL ($OUT)"
    echo "   open the dashboard port to this server, or enter manually: agent URL http://$MYIP:$PORT  token $TOKEN"
    exit 1
  fi
else
  echo "Manual setup: agent URL  http://$MYIP:$PORT   token  $TOKEN"
fi
