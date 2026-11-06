import net from 'node:net';

// FreeSWITCH Event Socket Library (ESL) Driver for ACW.
// Connects to FreeSWITCH mod_event_socket via TCP socket to track live calls
// and handle queue wrap-up status for mod_callcenter.

export function createFreeSwitchClient({ host, port, password }, log) {
  let socket = null;
  let retryMs = 1000;
  let reconnectTimer = null;
  const queueStatuses = new Map();

  function startEventStream({ onUpsert, onRemove }) {
    function scheduleReconnect() {
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }

    function connect() {
      log.info(`[freeswitch] connecting to ESL at ${host}:${port}...`);
      socket = net.createConnection({ host, port }, () => {
        retryMs = 1000;
        log.info('[freeswitch] connected to ESL TCP socket, authenticating...');
      });

      let buffer = '';
      let authenticated = false;

      socket.on('data', (data) => {
        buffer += data.toString();

        while (true) {
          const delim = buffer.indexOf('\n\n');
          if (delim === -1) break;
          const rawBlock = buffer.slice(0, delim);
          buffer = buffer.slice(delim + 2);

          const lines = rawBlock.split('\n');
          const headers = {};
          for (const line of lines) {
            const idx = line.indexOf(': ');
            if (idx !== -1) {
              const k = line.slice(0, idx).trim().toLowerCase();
              const v = line.slice(idx + 2).trim();
              headers[k] = v;
            }
          }

          if (headers['content-type'] === 'auth/request') {
            socket.write(`auth ${password}\n\n`);
          } else if (headers['content-type'] === 'command/reply') {
            const reply = headers['reply-text'] || '';
            if (reply.startsWith('+OK accepted')) {
              authenticated = true;
              log.info('[freeswitch] ESL authenticated successfully. Subscribing to channel events...');
              socket.write('event plain CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE\n\n');
            }
          } else if (headers['content-type'] === 'text/event-plain' || headers['event-name']) {
            handleEvent(headers);
          }
        }
      });

      function handleEvent(h) {
        const evName = (h['event-name'] || '').toUpperCase();
        const uuid = h['unique-id'];
        if (!uuid) return;

        const callee = h['caller-destination-number'] || '';
        const caller = h['caller-caller-id-number'] || '';
        const callerName = h['caller-caller-id-name'] || '';

        // Identify agent extension vs customer
        const ext = /^\d{2,6}$/.test(callee) ? callee : /^\d{2,6}$/.test(caller) ? caller : callee;
        const customerNumber = ext === callee ? caller : callee;

        if (evName === 'CHANNEL_CREATE' || evName === 'CHANNEL_PROGRESS') {
          onUpsert(ext, {
            id: uuid,
            callid: uuid,
            status: 'ringing',
            party_caller_id: customerNumber,
            party_caller_name: callerName,
          });
        } else if (evName === 'CHANNEL_ANSWER') {
          onUpsert(ext, {
            id: uuid,
            callid: uuid,
            status: 'connected',
            party_caller_id: customerNumber,
            party_caller_name: callerName,
          });
        } else if (evName === 'CHANNEL_HANGUP_COMPLETE') {
          onRemove(ext, uuid);
        }
      }

      socket.on('close', () => {
        log.warn(`[freeswitch] ESL connection closed. Reconnecting in ${retryMs / 1000}s`);
        scheduleReconnect();
      });

      socket.on('error', (err) => {
        log.error('[freeswitch] ESL socket error:', err.message);
        scheduleReconnect();
      });
    }

    connect();
  }

  return {
    startEventStream,
    async getAgentUser(ext) {
      return { name: `Agent ${ext}` };
    },
    async getQueueStatus(ext) {
      return queueStatuses.get(ext) || 'LoggedIn';
    },
    async setQueueStatus(ext, status) {
      queueStatuses.set(ext, status);
      // If mod_callcenter is loaded: api callcenter_config agent set status <ext> <Available|Logged Out>
      if (socket && socket.writable) {
        const fsStatus = status === 'LoggedOut' ? "'On Break'" : "'Available'";
        socket.write(`api callcenter_config agent set status ${ext} ${fsStatus}\n\n`);
      }
      log.info(`[freeswitch] extension ${ext} status set to ${status}`);
    },
    async getDnType(dn) {
      return 'Extension';
    },
  };
}
