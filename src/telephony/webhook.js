// Inbound Universal Telephony Webhook Adapter.
// Allows any PBX (Asterisk dialplan curl, FreeSWITCH Lua, Twilio, Vicidial, or custom VoIP)
// to push call lifecycle events directly to ACW.

export function createWebhookTelephonyAdapter({ config, tracker: initialTracker, repo, directory, enforcer: initialEnforcer, log }) {
  let tracker = initialTracker;
  let enforcer = initialEnforcer;
  const queueStatuses = new Map();

  function attach({ tracker: t, enforcer: e }) {
    if (t) tracker = t;
    if (e) enforcer = e;
  }

  async function processEvent(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid JSON payload');
    }
    if (!tracker) {
      throw new Error('Telephony tracker is not yet initialized');
    }

    // Normalize event name
    const rawEvent = String(payload.event || payload.Event || payload.CallStatus || '').toLowerCase();
    const callId = String(payload.call_id || payload.callId || payload.id || payload.CallSid || payload.Uniqueid || `call_${Date.now()}`);
    const extension = String(payload.extension || payload.agent_extension || payload.ext || payload.To || payload.party_dn || '').trim();
    const customerNumber = String(payload.customer_number || payload.caller_id || payload.caller_number || payload.From || payload.party_caller_id || '').trim();
    const customerName = String(payload.customer_name || payload.caller_name || payload.party_caller_name || '').trim();
    const direction = String(payload.direction || (rawEvent.includes('outbound') ? 'outbound' : 'inbound')).toLowerCase();

    if (!extension) {
      throw new Error('Missing "extension" (or agent_extension / ext) in event payload');
    }

    // Ensure agent directory has name if provided
    if (payload.agent_name) {
      await repo.upsertAgent(extension, String(payload.agent_name).trim());
    }

    // Determine event action
    const isStart = /^(call_started|call_ringing|ringing|initiated|dialing|channel_create)$/.test(rawEvent);
    const isAnswer = /^(call_answered|answered|in-progress|connected|channel_answer)$/.test(rawEvent);
    const isEnd = /^(call_ended|hangup|completed|canceled|failed|busy|no-answer|channel_hangup|channel_hangup_complete)$/.test(rawEvent);

    if (isStart || isAnswer) {
      const status = isAnswer ? 'connected' : (direction === 'outbound' ? 'dialing' : 'ringing');
      await tracker.update(extension, {
        id: callId,
        callid: callId,
        status,
        party_caller_id: customerNumber || null,
        party_caller_name: customerName || null,
      });
      log.info(`[webhook-telephony] call ${callId} on ext ${extension}: ${status} (${customerNumber || 'unknown'})`);
      return { ok: true, action: status, call_id: callId, extension };
    }

    if (isEnd) {
      await tracker.remove(extension, callId);
      log.info(`[webhook-telephony] call ${callId} on ext ${extension}: ended`);
      return { ok: true, action: 'ended', call_id: callId, extension };
    }

    // Agent queue pause/resume events via webhook
    if (/^(agent_paused|queue_logout|wrapup_start)$/.test(rawEvent)) {
      queueStatuses.set(extension, 'LoggedOut');
      await repo.setHeld(extension, true);
      return { ok: true, action: 'agent_paused', extension };
    }
    if (/^(agent_unpaused|queue_login|wrapup_end)$/.test(rawEvent)) {
      queueStatuses.set(extension, 'LoggedIn');
      await repo.setHeld(extension, false);
      return { ok: true, action: 'agent_unpaused', extension };
    }

    // Default fallback: if duration is provided, treat as completed call
    if (payload.duration || payload.talk_seconds) {
      await tracker.update(extension, {
        id: callId,
        callid: callId,
        status: 'connected',
        party_caller_id: customerNumber || null,
        party_caller_name: customerName || null,
      });
      await tracker.remove(extension, callId);
      return { ok: true, action: 'recorded', call_id: callId, extension };
    }

    return { ok: true, action: 'ignored', rawEvent };
  }

  return {
    processEvent,
    async getAgentUser(ext) {
      const a = await repo.getAgent(ext);
      return a ? { name: a.name || `Ext ${ext}` } : null;
    },
    async getQueueStatus(ext) {
      return queueStatuses.get(ext) || 'LoggedIn';
    },
    async setQueueStatus(ext, status) {
      queueStatuses.set(ext, status);
      log.info(`[webhook-telephony] queue status for ${ext} set to ${status}`);
    },
    async getDnType(dn) {
      return 'Extension';
    },
    startEventStream() {
      log.info('[webhook-telephony] listening for incoming HTTP telephony webhook events');
    },
    attach,
  };
}
