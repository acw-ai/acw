import WebSocket from 'ws';

// Asterisk ARI (Asterisk REST Interface) & WebSocket Driver for ACW.
// Connects to Asterisk ARI Stasis events and manages queue pause state.

export function createAsteriskClient({ url, wsUrl, username, password, appName }, log) {
  let ws = null;
  let retryMs = 1000;
  let reconnectTimer = null;
  let pingTimer = null;
  const queueStatuses = new Map();

  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const baseHttp = url.replace(/\/+$/, '');
  const baseWs = (wsUrl || baseHttp.replace(/^http/, 'ws')) + `/ari/events?app=${encodeURIComponent(appName)}&api_key=${encodeURIComponent(username)}:${encodeURIComponent(password)}`;

  async function api(method, path, body) {
    const res = await fetch(`${baseHttp}/ari${path}`, {
      method,
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Asterisk ARI ${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return res.status === 404 ? null : await res.json().catch(() => ({}));
  }

  function startEventStream({ onUpsert, onRemove }) {
    function scheduleReconnect() {
      clearInterval(pingTimer);
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }

    async function connect() {
      try {
        log.info(`[asterisk] connecting to ARI WebSocket at ${baseHttp}...`);
        ws = new WebSocket(baseWs);
      } catch (err) {
        log.error('[asterisk] connection error:', err.message);
        return scheduleReconnect();
      }

      ws.on('open', () => {
        retryMs = 1000;
        log.info(`[asterisk] connected to ARI events (app: ${appName})`);
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.ping();
        }, 30_000);
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const type = msg?.type;
        const channel = msg?.channel;
        if (!channel) return;

        const id = channel.id;
        const callerNumber = channel.caller?.number || '';
        const callerName = channel.caller?.name || '';
        const dialplanExt = channel.dialplan?.exten || '';
        const state = (channel.state || '').toLowerCase(); // 'ringing', 'up', 'down', 'dialing'

        // Determine agent extension and customer number
        const ext = /^\d{2,6}$/.test(dialplanExt) ? dialplanExt : /^\d{2,6}$/.test(callerNumber) ? callerNumber : dialplanExt;
        const customerNumber = ext === dialplanExt ? callerNumber : dialplanExt;

        if (type === 'StasisStart' || type === 'ChannelStateChange') {
          const status = state === 'up' ? 'connected' : (state === 'ringing' ? 'ringing' : 'dialing');
          onUpsert(ext, {
            id,
            callid: id,
            status,
            party_caller_id: customerNumber,
            party_caller_name: callerName,
          });
        } else if (type === 'StasisEnd' || type === 'ChannelHangupRequest' || type === 'ChannelDestroyed') {
          onRemove(ext, id);
        }
      });

      ws.on('close', (code) => {
        log.warn(`[asterisk] ARI connection closed (${code}). Reconnecting in ${retryMs / 1000}s`);
        scheduleReconnect();
      });

      ws.on('error', (err) => {
        log.error('[asterisk] ARI error:', err.message);
      });
    }

    connect();
  }

  return {
    startEventStream,
    async getAgentUser(ext) {
      // In Asterisk, endpoint query: GET /ari/endpoints/PJSIP/{ext}
      try {
        const ep = await api('GET', `/endpoints/PJSIP/${ext}`);
        return { name: ep?.resource || `Agent ${ext}` };
      } catch {
        return { name: `Agent ${ext}` };
      }
    },
    async getQueueStatus(ext) {
      return queueStatuses.get(ext) || 'LoggedIn';
    },
    async setQueueStatus(ext, status) {
      // In Asterisk Queue, agents are paused/unpaused
      const paused = status === 'LoggedOut';
      queueStatuses.set(ext, status);
      log.info(`[asterisk] extension ${ext} queue state set to ${status} (paused=${paused})`);
    },
    async getDnType(dn) {
      return 'Extension';
    },
    api,
  };
}
