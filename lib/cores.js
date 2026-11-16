'use strict';
// Spawns local Xray / sing-box client processes exposing one SOCKS5 port per share link.
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const links = require('./links');

const RUN_DIR = path.join(__dirname, '..', 'data', 'run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitPort(port, ms) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > end) reject(new Error('core did not open port ' + port));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

function checkConfig(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15000, encoding: 'utf8', maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err && (err.code === 'ENOENT' || err.killed)) return resolve({ error: err });
      resolve({ status: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

class Cores {
  constructor(tag, basePort) {
    this.tag = tag;
    this.basePort = basePort;
    this.procs = [];
    this.ports = [];
    this.tail = [];
  }

  // items: [{raw, link}] -> this.ports (one per item)
  async start(items) {
    this.ports = [];
    return this.add(items);
  }

  // More configs while the test runs (users created step by step): they get their own client process, so the
  // users already connected through the earlier processes are never interrupted. Returns the new ports.
  async add(items) {
    if (!items.length) return [];
    fs.mkdirSync(RUN_DIR, { recursive: true });
    this.batch = (this.batch || 0) + 1;
    const first = this.ports.length;
    const groups = { xray: [], singbox: [] };
    const ports = items.map((_, i) => this.basePort + first + i);
    items.forEach((it, i) => groups[links.coreFor(it.link)].push({ ...it, port: ports[i] }));
    if (groups.xray.length) await this.launch('xray', process.env.XRAY_BIN || 'xray', ['run', '-c'], this.xrayConfig(groups.xray), groups.xray, ['run', '-test', '-c']);
    if (groups.singbox.length) await this.launch('singbox', process.env.SINGBOX_BIN || 'sing-box', ['run', '-c'], this.singConfig(groups.singbox), groups.singbox, ['check', '-c']);
    this.ports.push(...ports);
    return ports;
  }

  xrayConfig(g) {
    return {
      log: { loglevel: 'warning' },
      inbounds: g.map((x, i) => ({ tag: `in${i}`, listen: '127.0.0.1', port: x.port, protocol: 'socks', settings: { auth: 'noauth', udp: false } })),
      outbounds: g.map((x, i) => links.toXray(x.link, `out${i}`)),
      routing: { domainStrategy: 'AsIs', rules: g.map((x, i) => ({ type: 'field', inboundTag: [`in${i}`], outboundTag: `out${i}` })) },
    };
  }

  singConfig(g) {
    return {
      log: { level: 'warn' },
      inbounds: g.map((x, i) => ({ type: 'socks', tag: `in${i}`, listen: '127.0.0.1', listen_port: x.port })),
      outbounds: g.map((x, i) => links.toSingbox(x.link, `out${i}`)),
      route: { rules: g.map((x, i) => ({ inbound: [`in${i}`], outbound: `out${i}` })) },
    };
  }

  async launch(kind, bin, args, cfg, group, testArgs) {
    const file = path.join(RUN_DIR, `${this.tag}-${kind}-${this.batch || 1}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
    // checked without blocking: a synchronous check freezes the whole test for a second or two, every transfer in
    // flight stalls and the run blames the panel for it
    const chk = await checkConfig(bin, [...testArgs, file]);
    if (chk.error) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      throw new Error(`cannot start ${bin}: ${chk.error.code === 'ENOENT' ? 'binary not found (set XRAY_BIN / SINGBOX_BIN)' : chk.error.message}`);
    }
    if (chk.status !== 0) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      throw new Error(`${kind} rejected the generated config: ${String(chk.stdout + chk.stderr).trim().split('\n').slice(-4).join(' | ').slice(0, 400)}`);
    }
    const p = spawn(bin, [...args, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnErr = null;
    p.on('error', (e) => { spawnErr = e; });
    const onData = (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) { this.tail.push(`[${kind}] ${line}`); if (this.tail.length > 20) this.tail.shift(); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    this.procs.push(p);
    await sleep(300);
    if (spawnErr) throw new Error(`cannot start ${bin}: ${spawnErr.code === 'ENOENT' ? 'binary not found (set XRAY_BIN / SINGBOX_BIN)' : spawnErr.message}`);
    try {
      await waitPort(group[group.length - 1].port, 15000);
    } catch (e) {
      throw new Error(`${e.message}. ${this.tail.slice(-3).join(' | ')}`);
    } finally {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }

  stop() {
    for (const p of this.procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
    this.procs = [];
  }
}

module.exports = { Cores };
