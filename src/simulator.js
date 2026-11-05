// A stand-in for 3CX so the whole flow can be tried without a PBX.
// It plays the same participant events the Call Control API sends, and keeps
// an in-memory queue login status per agent in place of XAPI.
export function createSimulator(log) {
  const agents = [
    { ext: '100', name: 'Agent 100' },
    { ext: '101', name: 'Agent 101' },
    { ext: '102', name: 'Agent 102' },
  ];
  const queueStatus = new Map(agents.map((a) => [a.ext, 'LoggedIn']));
  const calls = new Map();
  // Unique across restarts, like real 3CX call IDs (the database remembers old ones).
  let nextParticipant = Math.floor(Date.now() / 1000) % 1_000_000_000;
  let nextCallId = nextParticipant;
  let tracker = null;

  const pbx = {
    async getAgentUser(ext) {
      const a = agents.find((x) => x.ext === ext);
      return a ? { id: Number(ext), ext, name: a.name, queueStatus: queueStatus.get(ext) } : null;
    },
    async getQueueStatus(ext) { return queueStatus.get(ext) ?? null; },
    async setQueueStatus(ext, status) {
      queueStatus.set(ext, status);
      log.info(`[sim] queue status for ${ext} -> ${status}`);
    },
  };

  const busy = (ext) => [...calls.values()].some((c) => c.ext === ext);
  const participant = (c) => ({
    id: c.id, status: c.status, callid: c.callid, dn: c.ext,
    party_caller_id: c.number, party_dn: c.number, party_caller_name: c.name,
  });

  const control = {
    attach(t) { tracker = t; },
    agents,
    state() {
      return {
        agents: agents.map((a) => ({ ...a, queueStatus: queueStatus.get(a.ext), busy: busy(a.ext) })),
        calls: [...calls.values()],
      };
    },
    async start({ ext, direction = 'inbound', number, name }) {
      if (ext === 'queue') {
        const free = agents.find((a) => queueStatus.get(a.ext) === 'LoggedIn' && !busy(a.ext));
        if (!free) throw Object.assign(new Error('No agent is free: everyone is on a call or paused from the queue.'), { status: 409 });
        ext = free.ext;
        direction = 'inbound';
      }
      if (!agents.some((a) => a.ext === ext)) throw Object.assign(new Error(`Unknown extension ${ext}`), { status: 400 });
      const c = {
        id: nextParticipant++, callid: nextCallId++, ext, direction,
        number: String(number || '').trim() || '+1 604 555 0142', name: String(name || '').trim(),
        status: direction === 'outbound' ? 'Dialing' : 'Ringing',
      };
      calls.set(c.id, c);
      await tracker.update(ext, participant(c));
      return c;
    },
    async answer(id) {
      const c = calls.get(Number(id));
      if (!c) throw Object.assign(new Error('No such call'), { status: 404 });
      c.status = 'Connected';
      await tracker.update(c.ext, participant(c));
      return c;
    },
    async hangup(id) {
      const c = calls.get(Number(id));
      if (!c) throw Object.assign(new Error('No such call'), { status: 404 });
      calls.delete(c.id);
      await tracker.remove(c.ext, c.id);
      return c;
    },
    // Lets you play an agent who logs themselves back in from the 3CX app.
    setQueue(ext, status) {
      if (!queueStatus.has(ext)) throw Object.assign(new Error(`Unknown extension ${ext}`), { status: 400 });
      queueStatus.set(ext, status === 'LoggedIn' ? 'LoggedIn' : 'LoggedOut');
    },
  };

  return { pbx, control };
}
