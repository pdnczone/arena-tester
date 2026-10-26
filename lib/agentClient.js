'use strict';
const { fetch } = require('undici');

// Returns normalized stats of a server under test, or null when the agent is unreachable.
async function pollAgent(t) {
  if (!t.agentUrl) return null;
  try {
    const qs = new URLSearchParams({ token: t.agentToken || '', panel: t.panelProc || '', core: t.coreProc || '' });
    const res = await fetch(`${t.agentUrl.replace(/\/+$/, '')}/stats?${qs}`, { signal: AbortSignal.timeout(900) });
    if (!res.ok) return null;
    const s = await res.json();
    return {
      cpu: s.cpu, memPct: s.memPct, memUsedMB: s.memUsedMB, memTotalMB: s.memTotalMB, rx: s.rxMbps, tx: s.txMbps,
      tcp: s.tcp_inuse, load: s.load1, cores: s.cores,
      panelCpu: s.panel ? s.panel.cpu : null, panelMem: s.panel ? s.panel.rssMB : null,
      coreCpu: s.core ? s.core.cpu : null, coreMem: s.core ? s.core.rssMB : null,
    };
  } catch {
    return null;
  }
}

module.exports = { pollAgent };
