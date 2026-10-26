#!/usr/bin/env python3
"""vpn-bench agent: tiny dependency-free stats endpoint for the servers under test.

GET /stats?token=XXX&panel=x-ui&core=xray
  -> cpu %, ram, network Mbps, TCP sockets, per-process CPU/RSS for the
     panel process and the core (xray / sing-box) process.
Run:  TOKEN=secret PORT=9100 python3 agent.py
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TOKEN = os.environ.get("TOKEN", "")
PORT = int(os.environ.get("PORT", "9100"))
CLK = os.sysconf("SC_CLK_TCK")
NCPU = os.cpu_count() or 1

latest = {}
tracked = {}  # process-name -> last time a client asked for it
lock = threading.Lock()


def read_cpu():
    with open("/proc/stat") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    idle = v[3] + (v[4] if len(v) > 4 else 0)
    return sum(v), idle


def read_mem():
    m = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            m[k] = int(v.split()[0])
    total = m["MemTotal"]
    avail = m.get("MemAvailable", m.get("MemFree", 0))
    return total, total - avail


def read_net():
    rx = tx = 0
    with open("/proc/net/dev") as f:
        for line in list(f)[2:]:
            name, data = line.split(":", 1)
            if name.strip() == "lo" or name.strip().startswith(("docker", "veth", "br-")):
                continue
            c = data.split()
            rx += int(c[0])
            tx += int(c[8])
    return rx, tx


def read_sockstat():
    out = {"tcp_inuse": 0, "tcp_tw": 0}
    try:
        with open("/proc/net/sockstat") as f:
            for line in f:
                if line.startswith("TCP:"):
                    p = line.split()
                    out["tcp_inuse"] = int(p[p.index("inuse") + 1])
                    out["tcp_tw"] = int(p[p.index("tw") + 1])
    except OSError:
        pass
    return out


def scan_procs(names):
    """Return {name: (cpu_ticks, rss_kb)} summed over processes whose comm/cmdline matches."""
    res = {n: [0, 0] for n in names}
    page_kb = os.sysconf("SC_PAGE_SIZE") // 1024
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat") as f:
                s = f.read()
            comm = s[s.index("(") + 1 : s.rindex(")")]
            rest = s[s.rindex(")") + 2 :].split()
            ticks = int(rest[11]) + int(rest[12])
            rss = int(rest[21]) * page_kb
            hit = [n for n in names if n in comm.lower()]
            if not hit:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmd = f.read().replace(b"\0", b" ").decode(errors="ignore").lower()
                hit = [n for n in names if n in cmd.split(" ")[0]]
            for n in hit:
                res[n][0] += ticks
                res[n][1] += rss
        except (OSError, ValueError, IndexError):
            continue
    return res


def sampler():
    global latest
    pt, pi = read_cpu()
    prx, ptx = read_net()
    pprocs = {}
    pnow = time.time()
    while True:
        time.sleep(1)
        now = time.time()
        dt = max(now - pnow, 0.001)
        t, i = read_cpu()
        rx, tx = read_net()
        total, used = read_mem()
        with lock:
            names = [n for n, ts in tracked.items() if now - ts < 60]
        procs = scan_procs(names) if names else {}
        pout = {}
        for n, (ticks, rss) in procs.items():
            prev = pprocs.get(n)
            cpu = 0.0
            if prev is not None and ticks >= prev:
                cpu = (ticks - prev) / CLK / dt * 100  # % of ONE core
            pout[n] = {"cpu": round(cpu, 1), "rssMB": round(rss / 1024, 1)}
        pprocs = {n: v[0] for n, v in procs.items()}
        la = os.getloadavg()[0]
        snap = {
            "ts": now,
            "cores": NCPU,
            "cpu": round(100 * (1 - (i - pi) / max(t - pt, 1)), 1),
            "memPct": round(used / total * 100, 1),
            "memUsedMB": round(used / 1024),
            "memTotalMB": round(total / 1024),
            "rxMbps": round((rx - prx) * 8 / dt / 1e6, 2),
            "txMbps": round((tx - ptx) * 8 / dt / 1e6, 2),
            "load1": round(la, 2),
            "procs": pout,
        }
        snap.update(read_sockstat())
        with lock:
            latest = snap
        pt, pi, prx, ptx, pnow = t, i, rx, tx, now


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if TOKEN and q.get("token", [""])[0] != TOKEN:
            self.send_response(401)
            self.end_headers()
            return
        if u.path != "/stats":
            self.send_response(404)
            self.end_headers()
            return
        now = time.time()
        with lock:
            for key in ("panel", "core"):
                for n in q.get(key, []):
                    if n:
                        tracked[n.lower()] = now
            snap = dict(latest)
        # attach panel/core aliases
        procs = snap.get("procs", {})
        for key in ("panel", "core"):
            n = (q.get(key, [""])[0] or "").lower()
            snap[key] = procs.get(n)
        body = json.dumps(snap).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    threading.Thread(target=sampler, daemon=True).start()
    print(f"vpn-bench agent on :{PORT} (token {'set' if TOKEN else 'NOT set'})")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
