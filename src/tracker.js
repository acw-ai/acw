// Turns 3CX participant events (or simulator events) into call records.
//
// 3CX Call Control models each leg of a call on an extension as a "participant"
// under /callcontrol/{dn}/participants/{id}. We get an Upsert when it appears or
// changes status (Dialing / Ringing / Connected) and a Remove when it hangs up.
// Events are processed one at a time, in arrival order.
export function createCallTracker({ config, repo, enforcer, directory, onChange, log }) {
  const live = new Map(); // "dn/participantId" -> { callId, ignored }
  const keyOf = (dn, pid) => `${dn}/${pid}`;
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch((err) => log.error('[call] event failed:', err.message));
    return p;
  };

  const isInternal = (number) =>
    !!number && /^\d+$/.test(number) && number.length <= config.internalNumberMaxLength;

  async function doUpdate(dn, p) {
    if (!p || p.id == null) return;
    const pid = String(p.id);
    const k = keyOf(dn, pid);
    const status = String(p.status || '').toLowerCase();
    const number = p.party_caller_id || p.party_dn || '';
    let t = live.get(k);

    if (!t) {
      t = { callId: null, ignored: false };
      live.set(k, t);
      if (config.skipInternal && isInternal(number)) {
        t.ignored = true;
        return;
      }
      const callKey = `${dn}:${p.callid ?? 'na'}:${pid}`;
      const existing = await repo.getCallByKey(callKey);
      if (existing) {
        t.callId = existing.id; // picked back up after a reconnect / restart
      } else {
        const direction = status === 'dialing' ? 'outbound' : status === 'ringing' ? 'inbound' : 'unknown';
        const agentName = directory.name(dn);
        await repo.upsertAgent(dn, agentName.startsWith('Ext ') ? null : agentName);
        const row = await repo.createCall({
          callKey, pbxCallId: p.callid != null ? String(p.callid) : null, participantId: pid,
          extension: dn, agentName, customerNumber: number || null,
          customerName: p.party_caller_name || null, direction,
        });
        t.callId = row.id;
        log.info(`[call] ${direction} call ${row.id} on ${dn} with ${number || 'unknown'}`);
        onChange(dn);
      }
    }
    if (t.ignored) return;

    const row = await repo.getCall(t.callId);
    if (!row || row.status !== 'active') return;
    const patch = {};
    if (status === 'connected' && !row.answered_at) patch.answered_at = repo.now();
    if (!row.customer_number && number) patch.customer_number = number;
    if (!row.customer_name && p.party_caller_name) patch.customer_name = p.party_caller_name;
    if (Object.keys(patch).length) {
      await repo.updateCall(row.id, patch);
      onChange(dn);
    }
  }

  async function finalize(row, endedAt = new Date()) {
    const talk = row.answered_at ? Math.max(0, Math.round((endedAt - new Date(row.answered_at)) / 1000)) : 0;
    const needsDisposition =
      !!row.answered_at || (row.direction === 'outbound' && config.requireUnansweredOutbound);
    const status = !needsDisposition ? 'not_required' : row.disposition ? 'completed' : 'pending';
    await repo.updateCall(row.id, { ended_at: endedAt.toISOString(), talk_seconds: talk, status });
    log.info(`[call] call ${row.id} on ${row.extension} ended -> ${status}`);
    onChange(row.extension);
    if (status === 'pending') {
      enforcer.hold(row.extension).catch((err) => log.error(`[enforce] hold ${row.extension} failed:`, err.message));
    }
  }

  async function doRemove(dn, pid) {
    const k = keyOf(dn, String(pid));
    const t = live.get(k);
    if (!t) return;
    live.delete(k);
    if (t.ignored || !t.callId) return;
    const row = await repo.getCall(t.callId);
    if (row?.status === 'active') await finalize(row);
  }

  // After (re)connecting we receive a full snapshot. Anything we thought was live but
  // is no longer present ended while we weren't listening.
  async function doReconcile(presentKeys) {
    for (const k of [...live.keys()]) {
      if (!presentKeys.has(k)) {
        const [dn, pid] = k.split('/');
        await doRemove(dn, pid);
      }
    }
    for (const row of await repo.callsWithStatus('active')) {
      if (!presentKeys.has(keyOf(row.extension, row.participant_id))) {
        log.warn(`[call] call ${row.id} on ${row.extension} ended while disconnected; end time is approximate`);
        await finalize(row);
      }
    }
  }

  return {
    update: (dn, p) => serial(() => doUpdate(dn, p)),
    remove: (dn, pid) => serial(() => doRemove(dn, pid)),
    reconcile: (keys) => serial(() => doReconcile(keys)),
    keyOf,
  };
}
