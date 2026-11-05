// Server-Sent Events hub: pushes live updates to agent popups and supervisor dashboards.
export function createHub() {
  const agents = new Map(); // ext -> Set<res>
  const supervisors = new Set();

  function open(req, res, set) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    set.add(res);
    req.on('close', () => set.delete(res));
  }

  function send(res, type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  setInterval(() => {
    for (const set of [...agents.values(), supervisors]) for (const res of set) res.write(': ping\n\n');
  }, 25_000).unref();

  return {
    addAgent(ext, req, res) {
      if (!agents.has(ext)) agents.set(ext, new Set());
      const set = agents.get(ext);
      const wasOnline = set.size > 0;
      open(req, res, set);
      if (!wasOnline) {
        for (const s of supervisors) send(s, 'changed', { ext, online: true });
      }
      req.on('close', () => {
        if (set.size === 0) {
          for (const s of supervisors) send(s, 'changed', { ext, online: false });
        }
      });
    },
    addSupervisor(req, res) { open(req, res, supervisors); },
    send,
    toAgent(ext, type, data) { for (const res of agents.get(ext) || []) send(res, type, data); },
    toSupervisors(type, data) { for (const res of supervisors) send(res, type, data); },
    agentOnline: (ext) => (agents.get(ext)?.size || 0) > 0,
    // Drop open windows (e.g. after a PIN change) so they have to sign in again.
    disconnectAgent(ext) { for (const res of agents.get(ext) || []) res.end(); agents.get(ext)?.clear(); },
  };
}
