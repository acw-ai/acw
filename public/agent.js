import { $, $$, esc, api, fmtDuration, fmtTime, directionLabel, toast } from './common.js';

const hintExt = (new URLSearchParams(location.search).get('ext') || '').trim();
let ext = '';
let es = null;
const app = $('#app');
const BASE_TITLE = 'ACW · Agent Portal';

let catalog = null;
let crmScreenpop = null;
let state = { agent: null, active: [], pending: [], enforce: true };
let activeKey = null;
let formKey = null;
let knownPending = null;
let flashTimer = null;
const drafts = new Map(); // callId -> notes typed during the call
const saveTimers = new Map();

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

init().catch((err) => { app.innerHTML = `<div class="picker card"><h1>Can't load</h1><p class="muted">${esc(err.message)}</p></div>`; });

async function init() {
  const cfg = await api('/api/config');
  catalog = cfg.catalog;
  crmScreenpop = cfg.crmScreenpopUrl;
  const me = await api('/api/me?role=agent');
  if (me.role !== 'agent') return renderLogin();
  start(me.ext);
}

let ticking = false;
function start(signedInExt) {
  ext = signedInExt;
  activeKey = null;
  formKey = null;
  knownPending = null;
  document.title = `Ext ${ext} · ${BASE_TITLE}`;
  app.innerHTML = layout();
  bindChrome();
  connect();
  if (!ticking) { ticking = true; setInterval(tick, 1000); }
}

// ---------------------------------------------------------------------------
function layout() {
  return `
  <header class="topbar">
    <div class="brand">
      <div class="logo acw-brand-logo" aria-hidden="true" style="background:#f97316;color:#fff;border-radius:6px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-weight:800;">A</div>
      <div><div class="brand-title">ACW</div><div class="brand-sub">After-Call Work</div></div>
    </div>
    <div class="agent-meta">
      <div id="agentName" class="agent-name">Ext ${esc(ext)}</div>
      <span id="statusPill" class="pill">Connecting…</span>
    </div>
  </header>
  <div id="banner" class="banner" role="status" hidden></div>
  <main class="agent-main">
    <section id="activeCalls" class="grid-gap" aria-label="Current calls"></section>
    <section id="pendingArea" aria-label="Disposition required"></section>
    <section id="idle" class="idle" hidden>
      <div class="idle-icon" aria-hidden="true">☎</div>
      <div><strong>Waiting for calls</strong></div>
      <div class="sm">Keep this window open. It pops up when a call ends.</div>
    </section>
  </main>
  <footer class="agent-foot">
    <button id="popOut" class="btn ghost sm" type="button" title="Open as a small always-available window">Pop out</button>
    <button id="alertsBtn" class="btn ghost sm" type="button" hidden>Turn on desktop alerts</button>
    <button id="signOut" class="btn ghost sm" type="button">Sign out</button>
    <span id="conn" class="conn">Connecting…</span>
  </footer>`;
}

function bindChrome() {
  $('#popOut').addEventListener('click', () => {
    window.open('/agent.html', `acw-dispo-${ext}`, 'popup,width=480,height=780');
  });
  $('#signOut').addEventListener('click', async () => {
    if (state.pending.length && !confirm('You still owe an outcome for a call. Sign out anyway?')) return;
    try { await api('/api/logout?role=agent', { method: 'POST' }); } catch {}
    es?.close();
    renderLogin();
  });
  const alertsBtn = $('#alertsBtn');
  if ('Notification' in window && Notification.permission === 'default') {
    alertsBtn.hidden = false;
    alertsBtn.addEventListener('click', async () => {
      await Notification.requestPermission();
      alertsBtn.hidden = Notification.permission !== 'default';
    });
  }
  window.addEventListener('focus', stopFlash);
}

function connect() {
  es?.close();
  es = new EventSource(`/api/agents/${encodeURIComponent(ext)}/events`);
  es.addEventListener('state', (e) => { state = JSON.parse(e.data); render(); });
  es.onopen = () => setConn(true);
  es.onerror = async () => {
    setConn(false);
    // Session expired or PIN changed: go back to the sign-in screen.
    try {
      const me = await api('/api/me?role=agent');
      if (me.role !== 'agent' || me.ext !== ext) { es.close(); renderLogin('Your session ended. Please sign in again.'); }
    } catch {}
  };
}

function setConn(ok) {
  const el = $('#conn');
  el.textContent = ok ? 'Live' : 'Reconnecting…';
  el.classList.toggle('down', !ok);
}

// ---------------------------------------------------------------------------
function render() {
  const { agent, active, pending } = state;
  $('#agentName').textContent = agent?.name && agent.name !== `Ext ${ext}` ? `${agent.name} · Ext ${ext}` : `Ext ${ext}`;

  const pill = $('#statusPill');
  if (agent?.held) [pill.className, pill.textContent] = ['pill warn', 'Paused from queues'];
  else if (pending.length) [pill.className, pill.textContent] = ['pill warn', 'Disposition needed'];
  else if (active.length) [pill.className, pill.textContent] = ['pill accent', 'On a call'];
  else [pill.className, pill.textContent] = ['pill ok', 'Ready'];

  const banner = $('#banner');
  banner.hidden = !agent?.held;
  if (agent?.held) banner.textContent = "You're paused from your queues. Save the outcome below and you'll be logged back in automatically.";

  renderActive();
  renderPending();
  $('#idle').hidden = active.length > 0 || pending.length > 0;
  alertOnNewPending();
}

function renderActive() {
  const box = $('#activeCalls');
  const key = state.active.map((c) => c.id).join(',');
  if (key !== activeKey) {
    activeKey = key;
    box.innerHTML = state.active.map(activeCard).join('');
    box.style.display = state.active.length ? 'grid' : 'none';
    box.style.gap = '12px';
    for (const ta of $$('textarea[data-call]', box)) {
      const id = Number(ta.dataset.call);
      ta.value = drafts.get(id) ?? state.active.find((c) => c.id === id)?.notes ?? '';
      ta.addEventListener('input', () => { drafts.set(id, ta.value); scheduleSave(id); });
      ta.addEventListener('blur', () => saveNotes(id));
    }
  }
  for (const c of state.active) {
    const card = box.querySelector(`[data-card="${c.id}"]`);
    if (!card) continue;
    card.classList.toggle('live', !!c.answered_at);
    card.querySelector('.call-status').textContent = c.answered_at
      ? 'Connected'
      : c.direction === 'outbound' ? 'Dialing…' : 'Ringing…';
    card.querySelector('.timer').dataset.since = c.answered_at || c.started_at;
    card.querySelector('.call-number').textContent = c.customer_number || 'Unknown number';
    card.querySelector('.call-name').textContent = c.customer_name || '';
  }
  tick();
}

function activeCard(c) {
  return `
  <article class="card call-card" data-card="${c.id}">
    <div class="call-row">
      <div>
        <div class="eyebrow">${esc(directionLabel(c.direction))} call · <span class="call-status"></span></div>
        <div class="call-number"></div>
        <div class="call-name muted"></div>
      </div>
      <div class="timer" aria-label="Call duration">00:00</div>
    </div>
    <div class="field" style="margin-top:0">
      <label for="draft-${c.id}">Notes</label>
      <textarea id="draft-${c.id}" data-call="${c.id}" rows="3" maxlength="4000" placeholder="Type notes during the call…"></textarea>
      <div class="notes-hint">Saved as you type. You'll pick the outcome when the call ends.</div>
    </div>
  </article>`;
}

function scheduleSave(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.set(id, setTimeout(() => saveNotes(id), 700));
}
async function saveNotes(id) {
  clearTimeout(saveTimers.get(id));
  if (!drafts.has(id)) return;
  try { await api(`/api/calls/${id}/notes`, { method: 'POST', body: { ext, notes: drafts.get(id) } }); } catch {}
}

// ---------------------------------------------------------------------------
function renderPending() {
  const area = $('#pendingArea');
  const c = state.pending[0];
  const key = c ? String(c.id) : null;
  if (key !== formKey) {
    formKey = key;
    area.innerHTML = c ? pendingForm(c) : '';
    if (c) bindForm(c);
  }
  const more = $('#moreWaiting');
  if (more) more.textContent = state.pending.length > 1 ? `${state.pending.length - 1} more waiting` : '';
}

function pendingForm(c) {
  const answered = !!c.answered_at;
  const dir = c.direction;
  const crmLink = crmScreenpop && c.customer_number
    ? `<a href="${esc(crmScreenpop.replace('{PHONE}', encodeURIComponent(c.customer_number)))}" target="_blank" class="btn ghost sm" style="margin-top:4px;">Open CRM ↗</a>`
    : '';
  return `
  <form id="dispoForm" class="card dispo" novalidate>
    <div class="dispo-head">
      <div style="min-width:0">
        <div class="eyebrow">Call ended · outcome required</div>
        <div class="call-number">${esc(c.customer_number || 'Unknown number')}</div>
        <div class="muted">${esc(c.customer_name || '')}</div>
        ${crmLink}
      </div>
      <div class="dispo-meta">
        <span id="moreWaiting" class="pill warn"></span>
        <div>${answered ? `Talk time <strong>${fmtDuration(c.talk_seconds)}</strong>` : '<span class="pill plain">Not answered</span>'}</div>
        <div class="muted sm">Ended ${esc(fmtTime(c.ended_at))}</div>
      </div>
    </div>

    <fieldset>
      <legend>Call type</legend>
      <div class="seg">
        <label><input type="radio" name="direction" value="outbound" ${dir === 'outbound' ? 'checked' : ''}>Outbound</label>
        <label><input type="radio" name="direction" value="inbound" ${dir === 'inbound' ? 'checked' : ''}>Inbound</label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Category</legend>
      <div class="seg" id="catSeg">
        ${catalog.categories.map((cat) => `<label><input type="radio" name="category" value="${esc(cat.name)}">${esc(cat.name)}</label>`).join('')}
      </div>
    </fieldset>

    <fieldset>
      <legend>Call outcome</legend>
      <div class="outcomes" id="outcomes"></div>
    </fieldset>

    <div class="field" id="followField" hidden>
      <label for="followUp">Follow-up date <span class="req">Required</span></label>
      <input type="date" id="followUp" name="followUpDate">
    </div>
    <div class="field">
      <label for="subDispo">Sub-disposition <span class="muted sm">optional</span></label>
      <input id="subDispo" name="subDisposition" maxlength="200" placeholder="e.g. Follow-up next week" autocomplete="off">
    </div>
    <div class="field">
      <label for="notes">Agent notes</label>
      <textarea id="notes" name="notes" rows="4" maxlength="4000" placeholder="Enter call notes…"></textarea>
    </div>

    <div id="formError" class="form-error" role="alert" hidden></div>
    <div class="submit-row">
      <button class="btn primary block" id="submitBtn" type="submit" disabled>Save outcome</button>
    </div>
  </form>`;
}

function bindForm(c) {
  const form = $('#dispoForm');
  const answered = !!c.answered_at;
  const lastCat = store.get(`acw.lastCategory.${ext}`);
  const names = catalog.categories.map((x) => x.name);
  const startCat = [c.category, lastCat, catalog.defaultCategory, names[0]].find((n) => n && names.includes(n));
  form.querySelector(`input[name="category"][value="${CSS.escape(startCat)}"]`).checked = true;

  form.notes.value = drafts.get(c.id) ?? c.notes ?? '';
  form.subDisposition.value = c.sub_disposition || '';
  const today = new Date();
  form.followUpDate.min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (c.follow_up_date) form.followUpDate.value = c.follow_up_date;

  const drawOutcomes = (keep) => {
    const cat = catalog.categories.find((x) => x.name === form.category.value);
    $('#outcomes').innerHTML = cat.outcomes.map((o) => {
      const suggest = !answered && o.unanswered;
      return `<label class="chip ${suggest ? 'suggest' : ''}">
        <input type="radio" name="disposition" value="${esc(o.name)}" ${o.name === keep ? 'checked' : ''}>
        <span>${esc(o.name)}</span>${suggest ? '<span class="tag">Likely</span>' : ''}
      </label>`;
    }).join('');
    syncOutcome();
  };

  const syncOutcome = () => {
    const cat = catalog.categories.find((x) => x.name === form.category.value);
    const chosen = form.querySelector('input[name="disposition"]:checked')?.value;
    const outcome = cat.outcomes.find((o) => o.name === chosen);
    $('#followField').hidden = !outcome?.requiresFollowUp;
    form.followUpDate.required = !!outcome?.requiresFollowUp;
    $('#submitBtn').disabled = !outcome;
  };

  drawOutcomes(c.disposition);
  $('#catSeg').addEventListener('change', () => {
    drawOutcomes(form.querySelector('input[name="disposition"]:checked')?.value);
  });
  $('#outcomes').addEventListener('change', syncOutcome);
  form.notes.addEventListener('input', () => drafts.set(c.id, form.notes.value));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#formError');
    err.hidden = true;
    const data = {
      ext,
      direction: form.querySelector('input[name="direction"]:checked')?.value,
      category: form.category.value,
      disposition: form.querySelector('input[name="disposition"]:checked')?.value,
      subDisposition: form.subDisposition.value,
      notes: form.notes.value,
      followUpDate: form.followUpDate.value,
    };
    const problem = !data.direction ? 'Choose whether this was an inbound or outbound call.'
      : !data.disposition ? 'Choose a call outcome.'
      : form.followUpDate.required && !data.followUpDate ? 'Pick a follow-up date for this outcome.'
      : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await api(`/api/calls/${c.id}/disposition`, { method: 'POST', body: data });
      store.set(`acw.lastCategory.${ext}`, data.category);
      drafts.delete(c.id);
      toast('Outcome saved');
      stopFlash();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Save outcome';
    }
  });
}

// ---------------------------------------------------------------------------
function tick() {
  for (const el of $$('.timer[data-since]')) {
    el.textContent = fmtDuration((Date.now() - new Date(el.dataset.since)) / 1000);
  }
}

function alertOnNewPending() {
  const ids = state.pending.map((c) => c.id);
  const fresh = knownPending ? ids.filter((id) => !knownPending.has(id)) : [];
  knownPending = new Set(ids);
  if (!ids.length) return stopFlash();
  if (!fresh.length) return;

  const c = state.pending.find((x) => x.id === fresh[0]);
  beep();
  startFlash();
  try { window.focus(); } catch {}
  if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    const n = new Notification('Call outcome needed', {
      body: `${c.customer_number || 'Unknown number'} — pick an outcome to get your next call.`,
      tag: `acw-dispo-${ext}`,
      requireInteraction: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  }
}

function startFlash() {
  if (flashTimer) return;
  let on = false;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? '⚠ Outcome needed' : `Ext ${ext} · ${BASE_TITLE}`;
  }, 1000);
}
function stopFlash() {
  if (state.pending.length && !document.hasFocus()) return;
  clearInterval(flashTimer);
  flashTimer = null;
  document.title = `Ext ${ext} · ${BASE_TITLE}`;
}

let audioCtx = null;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime;
    for (const [i, f] of [[0, 880], [1, 660]]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.18);
      o.stop(t + i * 0.18 + 0.17);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
function renderLogin(message = '') {
  document.title = BASE_TITLE;
  clearInterval(flashTimer);
  flashTimer = null;
  let savedExt = '';
  try { savedExt = localStorage.getItem('acw.ext') || ''; } catch {}
  app.innerHTML = `
  <main class="picker card">
    <div class="brand">
      <div class="logo acw-brand-logo" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
          <path d="M12 9v6M9 11v2M15 11v2"/>
        </svg>
      </div>
      <div><div class="brand-title">ACW</div><div class="brand-sub">After-Call Work Portal</div></div>
    </div>
    <h1>Sign in</h1>
    <p class="muted" style="margin:0">Use your 3CX extension and the PIN your supervisor gave you. Keep this window open while you take calls.</p>
    ${message ? `<div class="notice">${esc(message)}</div>` : ''}
    <form id="loginForm" class="login-form" novalidate>
      <div class="field"><label for="loginExt">Extension</label>
        <input id="loginExt" name="ext" inputmode="numeric" autocomplete="username" maxlength="10" required value="${esc(hintExt || savedExt)}"></div>
      <div class="field"><label for="loginPin">PIN</label>
        <input id="loginPin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" required></div>
      <div id="loginError" class="form-error" role="alert" hidden></div>
      <div class="submit-row"><button class="btn primary block" type="submit">Sign in</button></div>
    </form>
    <div style="text-align: center; margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--border);">
      <a href="/acw-extension.zip" download style="color: #ff6b00; font-size: 13px; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; font-weight: 600;">
        <span>📥 Download Chrome Extension</span>
      </a>
    </div>
  </main>`;
  const form = $('#loginForm');
  (form.ext.value ? form.pin : form.ext).focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginError');
    err.hidden = true;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const me = await api('/api/login', { method: 'POST', body: { ext: form.ext.value.trim(), pin: form.pin.value } });
      try { localStorage.setItem('acw.ext', me.ext); } catch {}
      if (hintExt && hintExt !== me.ext) history.replaceState(null, '', '/agent.html');
      start(me.ext);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      form.pin.value = '';
      form.pin.focus();
      btn.disabled = false;
    }
  });
}
