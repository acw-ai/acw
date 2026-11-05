import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { createHub } from './hub.js';
import { createCallTracker } from './tracker.js';
import { createEnforcer } from './enforcer.js';
import { createPbxClient } from './pbx3cx.js';
import { createSimulator } from './simulator.js';
import { hashPin, verifyPin, safeEqual, createSessions, createLoginLimiter } from './auth.js';
import { dispatchWebhook } from './webhook.js';
import { analyzeCall } from './ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const stamp = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (...a) => console.log(stamp(), ...a),
  warn: (...a) => console.warn(stamp(), ...a),
  error: (...a) => console.error(stamp(), ...a),
};
const iso = (x) => (x ? new Date(x).toISOString() : null);

// ---- Setup ---------------------------------------------------------------------
if (!config.simulate && !(config.pbx.baseUrl && config.pbx.clientId && config.pbx.clientSecret)) {
  console.error('Missing PBX_URL / PBX_CLIENT_ID / PBX_CLIENT_SECRET in .env.');
  console.error('Fill them in, or run "npm run simulate" to try the app without a 3CX system.');
  process.exit(1);
}

const staticCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'dispositions.json'), 'utf8'));
let catalog = staticCatalog;
let conversionOutcomes = [...new Set(catalog.categories.flatMap((c) => c.outcomes.filter((o) => o.conversion).map((o) => o.name)))];

function buildCatalog(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.category)) {
      map.set(r.category, { name: r.category, outcomes: [] });
    }
    map.get(r.category).outcomes.push({
      id: r.id,
      name: r.name,
      requiresFollowUp: !!r.requires_follow_up,
      conversion: !!r.is_conversion,
      unanswered: !!r.is_unanswered,
    });
  }
  const categories = Array.from(map.values());
  return {
    defaultCategory: categories[0]?.name || 'Sales',
    categories,
  };
}

let repo;
try {
  repo = await openDatabase(config.db, log);
} catch (err) {
  console.error(`Could not open the ${config.db.driver} database: ${err.message}`);
  process.exit(1);
}

async function refreshCatalog() {
  try {
    const rows = await repo.listDispositions();
    if (rows && rows.length > 0) {
      catalog = buildCatalog(rows);
      conversionOutcomes = [...new Set(catalog.categories.flatMap((c) => c.outcomes.filter((o) => o.conversion).map((o) => o.name)))];
    }
  } catch (err) {
    log.warn('[catalog] using fallback dispositions.json:', err.message);
  }
}

try {
  await repo.seedDispositionsIfEmpty(staticCatalog);
  await refreshCatalog();
} catch (err) {
  log.warn('[db] dispositions table initialization skipped:', err.message);
}

const hub = createHub();
const agentSessions = createSessions({
  secret: config.auth.sessionSecret, hours: config.auth.sessionHours, secure: config.auth.cookieSecure, cookieName: 'acw_agent_session'
});
const supervisorSessions = createSessions({
  secret: config.auth.sessionSecret, hours: config.auth.sessionHours, secure: config.auth.cookieSecure, cookieName: 'acw_sup_session'
});
const legacySessions = createSessions({
  secret: config.auth.sessionSecret, hours: config.auth.sessionHours, secure: config.auth.cookieSecure, cookieName: 'acw_session'
});
const loginByIpExt = createLoginLimiter({ maxFailures: 5, lockMinutes: 10 });
const loginByExt = createLoginLimiter({ maxFailures: 10, lockMinutes: 10 });
const loginSupervisor = createLoginLimiter({ maxFailures: 5, lockMinutes: 15 });

const sim = config.simulate ? createSimulator(log) : null;
const pbx = sim ? sim.pbx : createPbxClient(config.pbx, log);

const names = new Map();
const directory = {
  name(ext) {
    if (!names.has(ext)) {
      names.set(ext, `Ext ${ext}`);
      (async () => {
        const saved = await repo.getAgent(ext);
        if (saved?.name && names.get(ext).startsWith('Ext ')) names.set(ext, saved.name);
        const u = await pbx.getUser(ext);
        if (u?.name) { names.set(ext, u.name); await repo.upsertAgent(ext, u.name); }
      })().catch((err) => log.warn(`[3cx] could not look up extension ${ext}:`, err.message));
    }
    return names.get(ext);
  },
};

async function agentState(ext) {
  const agent = await repo.getAgent(ext);
  return {
    agent: { ext, name: agent?.name || names.get(ext) || `Ext ${ext}`, held: !!agent?.held, heldSince: iso(agent?.held_since) },
    active: await repo.callsFor(ext, 'active'),
    pending: await repo.callsFor(ext, 'pending'),
    enforce: config.enforce,
  };
}

function onChange(ext) {
  agentState(ext)
    .then((state) => hub.toAgent(ext, 'state', state))
    .catch((err) => log.error('[hub] state push failed:', err.message));
  hub.toSupervisors('changed', { ext });
}

const enforcer = createEnforcer({ config, repo, pbx, onChange, log });
const tracker = createCallTracker({ config, repo, enforcer, directory, onChange, log });

async function knownExtensions() {
  const set = new Set([...config.monitoredExtensions, ...(sim ? sim.control.agents.map((a) => a.ext) : [])]);
  for (const a of await repo.listAgents()) set.add(a.extension);
  return [...set].sort();
}
for (const ext of await knownExtensions()) directory.name(ext);

if (sim) {
  sim.control.attach(tracker);
  for (const a of sim.control.agents) {
    if (!(await repo.getAgent(a.ext))?.pin_hash) await repo.setPin(a.ext, await hashPin('1234'));
  }
} else {
  const isAgentDn = async (dn) => {
    if (config.monitoredExtensions.length) return config.monitoredExtensions.includes(dn);
    return /extension/i.test(await pbx.getDnType(dn));
  };
  pbx.startEventStream({
    async onSnapshot(dnInfos) {
      const present = new Set();
      for (const info of dnInfos) {
        if (!info?.dn || !(await isAgentDn(info.dn))) continue;
        for (const p of info.participants || []) {
          await tracker.update(info.dn, p);
          present.add(tracker.keyOf(info.dn, String(p.id)));
        }
      }
      await tracker.reconcile(present);
    },
    async onUpsert(dn, p) { if (await isAgentDn(dn)) await tracker.update(dn, p); },
    async onRemove(dn, pid) { await tracker.remove(dn, pid); },
  });
}

// ---- Auth helpers --------------------------------------------------------------
const httpError = (status, message) => Object.assign(new Error(message), { status });

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const viaProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  const fwd = req.headers['x-forwarded-for'];
  return viaProxy && fwd ? String(fwd).split(',')[0].trim() : remote;
}

async function currentSupervisor(req) {
  if (!config.auth.supervisorPassword) return null;
  const s = supervisorSessions.read(req) || legacySessions.read(req);
  if (s?.role === 'supervisor') return { role: 'supervisor' };
  return null;
}

async function currentAgent(req) {
  const s = agentSessions.read(req) || legacySessions.read(req);
  if (s?.role === 'agent' && /^\d{1,10}$/.test(s.ext)) {
    const agent = await repo.getAgent(s.ext);
    // Setting a new PIN signs the agent out everywhere.
    if (!agent?.pin_hash || iso(agent.pin_set_at) !== s.pv) return null;
    return { role: 'agent', ext: s.ext, name: agent.name || names.get(s.ext) || `Ext ${s.ext}` };
  }
  return null;
}

async function currentUser(req, url) {
  const prefer = url?.searchParams?.get('role');
  if (prefer === 'supervisor') return (await currentSupervisor(req)) || { role: null };
  if (prefer === 'agent') return (await currentAgent(req)) || { role: null };

  const sup = await currentSupervisor(req);
  const ag = await currentAgent(req);
  if (ag) return { ...ag, supervisor: !!sup };
  if (sup) return { ...sup, supervisor: true };
  return { role: null };
}

async function requireAgent(req, ext) {
  const user = await currentAgent(req);
  if (user?.role !== 'agent') throw httpError(401, 'Please sign in');
  if (ext && user.ext !== ext) throw httpError(403, 'You are signed in as a different extension');
  return user;
}

async function requireSupervisor(req) {
  const user = await currentSupervisor(req);
  if (user?.role !== 'supervisor') throw httpError(401, 'Supervisor sign-in required');
  return user;
}

async function agentLogin(req, res, body) {
  const ext = String(body.ext ?? '').trim();
  const pin = String(body.pin ?? '');
  if (!/^\d{1,10}$/.test(ext) || !pin) throw httpError(400, 'Enter your extension and PIN');
  const ip = clientIp(req);
  const locked = Math.max(loginByIpExt.lockedMinutes(`${ip}|${ext}`), loginByExt.lockedMinutes(ext));
  if (locked) throw httpError(429, `Too many wrong PINs. Try again in ${locked} minute${locked > 1 ? 's' : ''}.`);

  const agent = await repo.getAgent(ext);
  const ok = await verifyPin(pin, agent?.pin_hash);
  if (!ok) {
    loginByIpExt.fail(`${ip}|${ext}`);
    loginByExt.fail(ext);
    log.warn(`[auth] failed sign-in for extension ${ext} from ${ip}`);
    throw httpError(401, agent?.pin_hash ? 'Wrong extension or PIN' : 'Wrong extension or PIN. If you have no PIN yet, ask your supervisor to set one.');
  }
  loginByIpExt.reset(`${ip}|${ext}`);
  loginByExt.reset(ext);
  agentSessions.issue(res, { role: 'agent', ext, pv: iso(agent.pin_set_at) });
  log.info(`[auth] extension ${ext} signed in from ${ip}`);
  return { role: 'agent', ext, name: agent.name || directory.name(ext) };
}

function supervisorLogin(req, res, body) {
  if (!config.auth.supervisorPassword) throw httpError(503, 'Supervisor sign-in is not set up. Add SUPERVISOR_PASSWORD to .env and restart.');
  const ip = clientIp(req);
  const locked = loginSupervisor.lockedMinutes(ip);
  if (locked) throw httpError(429, `Too many wrong passwords. Try again in ${locked} minute${locked > 1 ? 's' : ''}.`);
  if (!safeEqual(String(body.password ?? ''), config.auth.supervisorPassword)) {
    loginSupervisor.fail(ip);
    log.warn(`[auth] failed supervisor sign-in from ${ip}`);
    throw httpError(401, 'Wrong password');
  }
  loginSupervisor.reset(ip);
  supervisorSessions.issue(res, { role: 'supervisor' });
  log.info(`[auth] supervisor signed in from ${ip}`);
  return { role: 'supervisor' };
}

async function setAgentPin(ext, body) {
  const pin = String(body.pin ?? '').trim();
  if (!/^\d{4,12}$/.test(pin)) throw httpError(400, 'PIN must be 4 to 12 digits');
  await repo.setPin(ext, await hashPin(pin));
  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim() || null;
    await repo.setAgentName(ext, name);
    if (name) names.set(ext, name);
  }
  hub.disconnectAgent(ext);
  directory.name(ext);
  log.info(`[auth] PIN set for extension ${ext}${body.name ? ` (name: ${body.name})` : ''}`);
  return { ok: true };
}

async function setAgentName(ext, body) {
  const name = String(body.name ?? '').trim() || null;
  await repo.setAgentName(ext, name);
  names.set(ext, name || `Ext ${ext}`);
  directory.name(ext);
  hub.toSupervisors('changed', { ext });
  log.info(`[auth] Agent ${ext} name set to "${name}"`);
  return { ok: true, name };
}

async function supervisorAgents() {
  const rows = new Map((await repo.listAgents()).map((a) => [a.extension, a]));
  return (await knownExtensions()).map((ext) => {
    const a = rows.get(ext);
    return {
      ext, name: a?.name || directory.name(ext), hasPin: !!a?.pin_hash, pinSetAt: iso(a?.pin_set_at),
      held: !!a?.held, lastSeen: iso(a?.last_seen),
      online: hub.agentOnline(ext),
    };
  });
}

// ---- Outcome logic -------------------------------------------------------------
async function callForAgent(id, ext) {
  const call = await repo.getCall(id);
  if (!call) throw httpError(404, 'Call not found');
  if (ext !== call.extension) throw httpError(403, 'This call belongs to another extension');
  return call;
}

async function saveNotes(id, ext, body) {
  const call = await callForAgent(id, ext);
  if (!['active', 'pending'].includes(call.status)) throw httpError(409, `Call is already ${call.status}`);
  await repo.updateCall(id, { notes: String(body.notes ?? '').slice(0, 4000) });
  return { ok: true };
}

async function submitDisposition(id, ext, body) {
  const call = await callForAgent(id, ext);
  if (!['active', 'pending'].includes(call.status)) throw httpError(409, `This call is already ${call.status}`);

  const category = catalog.categories.find((c) => c.name === body.category);
  if (!category) throw httpError(400, 'Choose a category');
  const outcome = category.outcomes.find((o) => o.name === body.disposition);
  if (!outcome) throw httpError(400, 'Choose a call outcome');
  const direction = ['inbound', 'outbound'].includes(body.direction) ? body.direction : call.direction;
  if (!['inbound', 'outbound'].includes(direction)) throw httpError(400, 'Choose the call type');
  const followUp = String(body.followUpDate ?? '').trim() || null;
  if (followUp && (!/^\d{4}-\d{2}-\d{2}$/.test(followUp) || Number.isNaN(Date.parse(followUp)))) {
    throw httpError(400, 'Follow-up date is not a valid date');
  }
  if (outcome.requiresFollowUp && !followUp) throw httpError(400, `"${outcome.name}" needs a follow-up date`);

  const status = call.status === 'pending' ? 'completed' : 'active'; // saved early during the call
  const updated = await repo.updateCall(id, {
    category: category.name,
    disposition: outcome.name,
    sub_disposition: String(body.subDisposition ?? '').trim().slice(0, 200) || null,
    notes: String(body.notes ?? '').slice(0, 4000),
    follow_up_date: followUp,
    direction,
    disposed_at: repo.now(),
    status,
  });
  log.info(`[dispo] call ${id} on ${call.extension}: ${category.name} / ${outcome.name}`);
  onChange(call.extension);
  if (status === 'completed') {
    await enforcer.release(call.extension).catch((err) => log.error(`[enforce] release ${call.extension} failed:`, err.message));
    dispatchWebhook('call.disposition_saved', {
      callId: updated.id,
      extension: call.extension,
      agentName: call.agent_name || directory.name(call.extension),
      customerNumber: call.customer_number,
      customerName: call.customer_name,
      direction,
      category: category.name,
      disposition: outcome.name,
      subDisposition: updated.sub_disposition,
      notes: updated.notes,
      followUpDate: updated.follow_up_date,
      talkSeconds: call.talk_seconds,
      startedAt: call.started_at,
      endedAt: call.ended_at,
    });
  }
  return updated;
}

async function supervisorRelease(ext, body) {
  const waived = await repo.callsFor(ext, 'pending');
  for (const c of waived) {
    await repo.updateCall(c.id, {
      status: 'waived',
      waived_by: String(body.by || 'supervisor').slice(0, 80),
      waived_reason: String(body.reason || '').slice(0, 300) || null,
    });
  }
  await enforcer.release(ext, { force: true });
  onChange(ext);
  return { waived: waived.length };
}

async function stats(days) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return {
    ...(await repo.stats({ todayStart: todayStart.toISOString(), since, conversionOutcomes })),
    days,
    held: (await repo.heldAgents()).map((a) => ({ ext: a.extension, name: a.name, since: iso(a.held_since) })),
    pending: await repo.callsWithStatus('pending'),
    enforce: config.enforce,
  };
}

const CSV_COLUMNS = [
  'id', 'pbx_call_id', 'extension', 'agent_name', 'customer_number', 'customer_name', 'direction', 'status',
  'started_at', 'answered_at', 'ended_at', 'talk_seconds', 'category', 'disposition', 'sub_disposition',
  'notes', 'follow_up_date', 'disposed_at', 'waived_by', 'waived_reason',
];
const FREE_TEXT = new Set(['customer_name', 'sub_disposition', 'notes', 'waived_reason']);
function toCsv(rows) {
  const cell = (col, v) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (FREE_TEXT.has(col) && /^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(c, r[c])).join(','))].join('\r\n');
}

// ---- HTTP ----------------------------------------------------------------------
const NO_BODY = Symbol('handled');
const requireSim = () => { if (!sim) throw httpError(404, 'Not found'); };

const routes = [
  // Session
  ['GET', /^\/api\/me$/, async ({ req, url }) => (await currentUser(req, url)) || { role: null }],
  ['POST', /^\/api\/login$/, ({ req, res, body }) => agentLogin(req, res, body)],
  ['POST', /^\/api\/supervisor\/login$/, ({ req, res, body }) => supervisorLogin(req, res, body)],
  ['POST', /^\/api\/supervisor\/logout$/, ({ res }) => { supervisorSessions.clear(res); return { ok: true }; }],
  ['POST', /^\/api\/logout$/, ({ res, url }) => {
    if (url.searchParams.get('role') === 'supervisor') {
      supervisorSessions.clear(res);
    } else {
      agentSessions.clear(res);
      legacySessions.clear(res);
    }
    return { ok: true };
  }],
  ['GET', /^\/api\/config$/, () => ({
    brand: config.brand,
    catalog,
    enforce: config.enforce,
    simulate: config.simulate,
    crmScreenpopUrl: config.crm.screenpopUrl,
    requireUnansweredOutbound: config.requireUnansweredOutbound,
  })],
  ['POST', /^\/api\/ai\/analyze$/, async ({ body }) => {
    return (await analyzeCall(body)) || { error: 'AI analysis unavailable or provider is set to none.' };
  }],

  // Agent (own extension only)
  ['GET', /^\/api\/agents\/(\d{1,10})\/state$/, async ({ req, m }) => {
    await requireAgent(req, m[1]);
    return agentState(m[1]);
  }],
  ['GET', /^\/api\/agents\/(\d{1,10})\/events$/, async ({ req, res, m }) => {
    await requireAgent(req, m[1]);
    const state = await agentState(m[1]);
    hub.addAgent(m[1], req, res);
    hub.send(res, 'state', state);
    return NO_BODY;
  }],
  ['POST', /^\/api\/calls\/(\d+)\/notes$/, async ({ req, m, body }) => saveNotes(m[1], (await requireAgent(req)).ext, body)],
  ['POST', /^\/api\/calls\/(\d+)\/disposition$/, async ({ req, m, body }) => submitDisposition(m[1], (await requireAgent(req)).ext, body)],

  // Supervisor
  ['GET', /^\/api\/supervisor\/events$/, async ({ req, res }) => {
    await requireSupervisor(req);
    hub.addSupervisor(req, res);
    return NO_BODY;
  }],
  ['GET', /^\/api\/supervisor\/agents$/, async ({ req }) => { await requireSupervisor(req); return supervisorAgents(); }],
  ['GET', /^\/api\/supervisor\/dispositions$/, async ({ req }) => {
    await requireSupervisor(req);
    return catalog;
  }],
  ['POST', /^\/api\/supervisor\/dispositions$/, async ({ req, body }) => {
    await requireSupervisor(req);
    const category = String(body.category ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!category) throw httpError(400, 'Category is required');
    if (!name) throw httpError(400, 'Outcome name is required');
    const requiresFollowUp = !!body.requiresFollowUp;
    const isConversion = !!body.conversion;
    const isUnanswered = !!body.unanswered;

    await repo.addDisposition({ category, name, requiresFollowUp, isConversion, isUnanswered });
    await refreshCatalog();
    hub.toSupervisors('dispositions_changed', catalog);
    log.info(`[catalog] Added disposition "${name}" under "${category}"`);
    return catalog;
  }],
  ['DELETE', /^\/api\/supervisor\/dispositions\/(\d+)$/, async ({ req, m }) => {
    await requireSupervisor(req);
    await repo.deleteDisposition(m[1]);
    await refreshCatalog();
    hub.toSupervisors('dispositions_changed', catalog);
    log.info(`[catalog] Deleted disposition id ${m[1]}`);
    return catalog;
  }],
  ['POST', /^\/api\/supervisor\/agents\/(\d{1,10})\/pin$/, async ({ req, m, body }) => {
    await requireSupervisor(req);
    return setAgentPin(m[1], body);
  }],
  ['POST', /^\/api\/supervisor\/agents\/(\d{1,10})\/name$/, async ({ req, m, body }) => {
    await requireSupervisor(req);
    return setAgentName(m[1], body);
  }],
  ['DELETE', /^\/api\/supervisor\/agents\/(\d{1,10})$/, async ({ req, m }) => {
    await requireSupervisor(req);
    const ext = m[1];
    names.delete(ext);
    hub.disconnectAgent(ext);
    await repo.deleteAgent(ext);
    log.info(`[auth] Agent extension ${ext} deleted`);
    return { ok: true };
  }],
  ['POST', /^\/api\/agents\/(\d{1,10})\/release$/, async ({ req, m, body }) => {
    await requireSupervisor(req);
    return supervisorRelease(m[1], body);
  }],
  ['GET', /^\/api\/stats$/, async ({ req, url }) => {
    await requireSupervisor(req);
    return stats(Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 365));
  }],
  ['GET', /^\/api\/calls$/, async ({ req, url }) => {
    await requireSupervisor(req);
    const sp = url.searchParams;
    return repo.listCalls({ status: sp.get('status') || undefined, ext: sp.get('ext') || undefined, limit: sp.get('limit') || 100 });
  }],
  ['GET', /^\/api\/export\.csv$/, async ({ req, res, url }) => {
    await requireSupervisor(req);
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
    const rows = await repo.listCalls({ since: new Date(Date.now() - days * 86_400_000).toISOString(), limit: 5000 });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="acw-dispositions-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.end('﻿' + toCsv(rows));
    return NO_BODY;
  }],

  // Simulator (simulate mode only)
  ['GET', /^\/api\/sim\/state$/, () => { requireSim(); return sim.control.state(); }],
  ['POST', /^\/api\/sim\/calls$/, ({ body }) => { requireSim(); return sim.control.start(body); }],
  ['POST', /^\/api\/sim\/calls\/(\d+)\/answer$/, ({ m }) => { requireSim(); return sim.control.answer(m[1]); }],
  ['POST', /^\/api\/sim\/calls\/(\d+)\/hangup$/, ({ m }) => { requireSim(); return sim.control.hangup(m[1]); }],
  ['POST', /^\/api\/sim\/agents\/(\d{1,10})\/queue$/, ({ m, body }) => {
    requireSim();
    sim.control.setQueue(m[1], body.status);
    return sim.control.state();
  }],
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') { res.writeHead(302, { Location: '/agent.html' }); return res.end(); }
  if (pathname === '/sim.html' && !sim) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = ''; }
  const file = path.resolve(PUBLIC, `.${rel}`);
  if (!rel || !file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(httpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); }
      catch { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) throw httpError(404, 'Not found');
    let body = {};
    if (req.method === 'POST') {
      // JSON-only POSTs: a plain HTML form on another site can't send these.
      if (!String(req.headers['content-type'] || '').includes('application/json')) throw httpError(415, 'Send JSON');
      body = await readJson(req);
    }
    const result = await route[2]({ req, res, url, body, m: route[1].exec(url.pathname) });
    if (result === NO_BODY) return;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(result ?? {}));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log.error('[http]', req.method, url.pathname, err);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: status >= 500 ? 'Something went wrong on the server' : err.message }));
  }
});

server.listen(config.port, config.host, () => {
  log.info(`${config.brand.name} running on http://${config.host}:${config.port} (database: ${repo.driver})`);
  log.info(`  Agent window: /agent.html    Supervisor: /supervisor.html${sim ? '    Simulator: /sim.html' : ''}`);
  log.info(`  Enforcement:  ${config.enforce ? 'on (queue logout until the outcome is saved)' : 'off'}`);
  if (sim) log.info('  Simulator sign-in: agents 100/101/102 use PIN 1234; supervisor password is "supervisor" unless SUPERVISOR_PASSWORD is set');
  if (agentSessions.generatedSecret || supervisorSessions.generatedSecret) log.warn('  SESSION_SECRET is not set: everyone is signed out whenever the app restarts.');
  if (!config.auth.supervisorPassword) log.warn('  SUPERVISOR_PASSWORD is not set: the supervisor page is disabled.');
});

const shutdown = async () => {
  server.close();
  await repo.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
