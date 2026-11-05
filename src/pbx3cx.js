import WebSocket from 'ws';

// 3CX V20 client.
//  - OAuth client-credentials token:  POST {PBX}/connect/token (multipart form)
//  - Call Control API (live events):  GET {PBX}/callcontrol, WSS {PBX}/callcontrol/ws
//  - Configuration API (XAPI):        GET/PATCH {PBX}/xapi/v1/Users
// Event and participant field names follow 3CX's own examples
// (github.com/3cx/call-control-examples, server/src/types.ts).

const PARTICIPANT_PATH = /^\/callcontrol\/([^/]+)\/participants\/(\d+)$/;
const EXT_RE = /^\d{1,10}$/;
const EVENT_UPSERT = 0; // TS enum EventType { Upset, Remove, DTMFstring, PromptPlaybackFinished }
const EVENT_REMOVE = 1;

export function createPbxClient({ baseUrl, clientId, clientSecret }, log) {
  let token = null;
  let tokenExpiresAt = 0;
  let tokenPromise = null;
  const userCache = new Map();
  const dnTypes = new Map();

  async function fetchToken() {
    const form = new FormData();
    form.append('client_id', clientId);
    form.append('client_secret', clientSecret);
    form.append('grant_type', 'client_credentials');
    let res;
    try {
      res = await fetch(`${baseUrl}/connect/token`, { method: 'POST', body: form });
    } catch (err) {
      throw new Error(`Can't reach 3CX at ${baseUrl} (${err.cause?.code || err.cause?.message || err.message})`);
    }
    if (!res.ok) throw new Error(`3CX token request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    token = body.access_token;
    tokenExpiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return token;
  }

  function getToken(force = false) {
    if (!force && token && Date.now() < tokenExpiresAt - 60_000) return Promise.resolve(token);
    tokenPromise ??= fetchToken().finally(() => { tokenPromise = null; });
    return tokenPromise;
  }

  async function api(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const t = await getToken(attempt > 0);
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${t}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
  }

  // ---- XAPI: users and queue login status -------------------------------------
  async function getUser(ext, { fresh = false } = {}) {
    if (!EXT_RE.test(ext)) throw new Error(`Invalid extension "${ext}"`);
    const cached = userCache.get(ext);
    if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.user;
    const filter = encodeURIComponent(`Number eq '${ext}'`);
    const data = await api('GET', `/xapi/v1/Users?$filter=${filter}&$select=Id,Number,FirstName,LastName,QueueStatus`);
    const u = data?.value?.[0];
    const user = u
      ? {
          id: u.Id,
          ext: u.Number,
          name: [u.FirstName, u.LastName].filter(Boolean).join(' ') || `Ext ${ext}`,
          queueStatus: u.QueueStatus ?? null,
        }
      : null;
    userCache.set(ext, { user, at: Date.now() });
    return user;
  }

  async function getQueueStatus(ext) {
    return (await getUser(ext, { fresh: true }))?.queueStatus ?? null;
  }

  // QueueStatus PATCH works from V20 Update 4 onward ("LoggedIn" / "LoggedOut").
  async function setQueueStatus(ext, status) {
    const user = await getUser(ext);
    if (!user) throw new Error(`No 3CX user has extension ${ext}`);
    await api('PATCH', `/xapi/v1/Users(${user.id})`, { QueueStatus: status });
  }

  // ---- Call Control: which DNs are extensions ---------------------------------
  async function getDnType(dn) {
    if (!dnTypes.has(dn)) {
      const info = await api('GET', `/callcontrol/${encodeURIComponent(dn)}`);
      dnTypes.set(dn, info?.type ?? '');
    }
    return dnTypes.get(dn);
  }

  // ---- Call Control: live event stream ----------------------------------------
  function startEventStream({ onUpsert, onRemove, onSnapshot }) {
    const wsUrl = `${baseUrl.replace(/^http/i, 'ws')}/callcontrol/ws`;
    let ws = null;
    let retryMs = 1000;
    let reconnectTimer = null;
    let pingTimer = null;
    let chain = Promise.resolve();

    // Handle events strictly in order so a Remove never overtakes its Upsert.
    const enqueue = (fn) => {
      chain = chain.then(fn).catch((err) => log.error('[3cx] event handling failed:', err.message));
    };

    function scheduleReconnect() {
      clearInterval(pingTimer);
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }

    async function connect() {
      let t;
      try {
        t = await getToken(true);
      } catch (err) {
        log.error('[3cx]', err.message);
        return scheduleReconnect();
      }
      ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${t}` } });
      let alive = true;

      ws.on('open', () => {
        retryMs = 1000;
        log.info(`[3cx] connected to ${wsUrl}`);
        enqueue(async () => {
          const snapshot = (await api('GET', '/callcontrol')) ?? [];
          for (const info of snapshot) if (info?.dn) dnTypes.set(info.dn, info.type ?? '');
          await onSnapshot(snapshot);
        });
        pingTimer = setInterval(() => {
          if (!alive) { log.warn('[3cx] no pong; reconnecting'); return ws.terminate(); }
          alive = false;
          ws.ping();
        }, 30_000);
      });
      ws.on('pong', () => { alive = true; });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const ev = msg?.event;
        const m = ev?.entity && PARTICIPANT_PATH.exec(ev.entity);
        if (!m) return;
        const [, dn, pid] = m;
        const type = ev.event_type;
        if (type === EVENT_REMOVE || type === 'Remove') {
          enqueue(() => onRemove(dn, pid));
        } else if (type === EVENT_UPSERT || type === 'Upset' || type === 'Upsert') {
          enqueue(async () => {
            const participant = await api('GET', ev.entity);
            if (participant) await onUpsert(dn, participant);
            else await onRemove(dn, pid); // already gone by the time we asked
          });
        }
      });

      ws.on('close', (code) => {
        log.warn(`[3cx] event stream closed (${code}); reconnecting in ${retryMs / 1000}s`);
        scheduleReconnect();
      });
      ws.on('error', (err) => log.error('[3cx] websocket error:', err.message));
    }

    connect();
  }

  return { getUser, getQueueStatus, setQueueStatus, getDnType, startEventStream, api };
}
