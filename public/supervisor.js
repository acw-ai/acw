import { $, esc, api, fmtDuration, fmtDateTime, fmtAgo, fmtDate, directionLabel, toast } from './common.js';

const STATUS = {
  active: ['accent', 'On call'],
  pending: ['warn', 'Waiting'],
  completed: ['ok', 'Saved'],
  waived: ['danger', 'Released'],
  not_required: ['', 'Missed'],
};
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const periodLabel = (d) => (d === 1 ? 'Today' : `Last ${d} days`);

let refreshTimer = null;
let es = null;
let started = false;
const daysSel = $('#days');
const statusSel = $('#statusFilter');

init();

async function init() {
  const me = await api('/api/me?role=supervisor').catch(() => ({ role: null }));
  if (me.role === 'supervisor') showDashboard();
  else showLogin();
}

function showLogin(message) {
  es?.close();
  $('#dash').hidden = true;
  $('#login').hidden = false;
  const err = $('#loginError');
  err.hidden = !message;
  err.textContent = message || '';
  $('#password').value = '';
  $('#password').focus();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api('/api/supervisor/login', { method: 'POST', body: { password: $('#password').value } });
    showDashboard();
  } catch (err) {
    showLogin(err.message);
  } finally {
    btn.disabled = false;
  }
});

const VIEW_METAS = {
  dashboard: { title: 'Command Center', subtitle: 'Live contact center overview' },
  agents: { title: 'Agents & Team', subtitle: 'Live presence and PIN management' },
  calls: { title: 'Call History', subtitle: 'Detailed inbound & outbound call records' },
  dispositions: { title: 'Call Dispositions', subtitle: 'Manage categories and outcome workflows' },
  analytics: { title: 'Reports & Analytics', subtitle: 'Performance metrics and disposition compliance' },
};

function setupNavigation() {
  const navButtons = document.querySelectorAll('.sidebar-nav .nav-item');
  const viewPanels = document.querySelectorAll('.view-panel');
  const titleEl = $('#viewTitle');
  const subtitleEl = $('#viewSubtitle');

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const viewKey = btn.dataset.view;
      if (!viewKey) return;

      navButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      viewPanels.forEach((p) => {
        p.classList.toggle('active', p.id === `view-${viewKey}`);
      });

      if (VIEW_METAS[viewKey] && titleEl && subtitleEl) {
        titleEl.textContent = VIEW_METAS[viewKey].title;
        subtitleEl.textContent = VIEW_METAS[viewKey].subtitle;
      }
    });
  });
}

function showDashboard() {
  $('#login').hidden = true;
  $('#dash').hidden = false;
  setupNavigation();
  connect();
  refresh();
  if (started) return;
  started = true;
  daysSel.addEventListener('change', refresh);
  statusSel.addEventListener('change', refresh);
  $('#exportBtn').addEventListener('click', (e) => {
    e.preventDefault();
    location.href = `/api/export.csv?days=${Math.max(Number(daysSel.value), 30)}`;
  });
  $('#signOut').addEventListener('click', async () => {
    try { await api('/api/supervisor/logout', { method: 'POST' }); } catch {}
    showLogin();
  });
  $('#addAgent').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const ext = f.ext.value.trim();
    const name = f.name?.value.trim() || '';
    const pin = f.pin.value.trim();
    if (!/^\d{1,10}$/.test(ext)) return toast('Enter the extension number');
    if (await saveAgent(ext, pin, name)) { f.reset(); refresh(); }
  });
  $('#addDispositionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const selCat = $('#dispCategorySelect').value.trim();
    const newCat = $('#dispNewCategoryInput').value.trim();
    const category = newCat || selCat;
    const name = $('#dispOutcomeInput').value.trim();
    const requiresFollowUp = $('#dispFollowUpCheck').checked;

    if (!category) return toast('Select or enter a category name');
    if (!name) return toast('Enter the outcome name');

    try {
      await api('/api/supervisor/dispositions', {
        method: 'POST',
        body: { category, name, requiresFollowUp }
      });
      toast(`Added "${name}" to ${category}`);
      $('#dispOutcomeInput').value = '';
      $('#dispNewCategoryInput').value = '';
      $('#dispFollowUpCheck').checked = false;
      refresh();
    } catch (err) {
      toast(err.message);
    }
  });
  setInterval(() => { if (!$('#dash').hidden) refresh(); }, 30_000); // keeps "x minutes ago" honest
  setInterval(updateLiveTimers, 1000); // updates live call talk duration every second
}

function connect() {
  es?.close();
  es = new EventSource('/api/supervisor/events');
  const live = $('#live');
  es.onopen = () => { live.className = 'pill ok'; live.textContent = 'Live'; };
  es.onerror = () => { live.className = 'pill danger'; live.textContent = 'Reconnecting'; };
  es.addEventListener('changed', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 300);
  });
  es.addEventListener('dispositions_changed', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 300);
  });
}

function computeTimer(timestamp) {
  if (!timestamp) return '00:00';
  const started = new Date(timestamp).getTime();
  if (isNaN(started)) return '00:00';
  const diffSec = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const m = Math.floor(diffSec / 60);
  const s = diffSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateLiveTimers() {
  document.querySelectorAll('.live-timer[data-start]').forEach((el) => {
    el.textContent = computeTimer(el.getAttribute('data-start'));
  });
}

function renderActiveCalls(calls) {
  const box = $('#activeCallsContainer');
  const badge = $('#activeCallsBadge');
  if (!box) return;

  const count = calls && Array.isArray(calls) ? calls.length : 0;
  if (badge) {
    badge.textContent = `${count} On Call`;
    if (count > 0) {
      badge.className = 'pill ok sm live-pulse-pill';
    } else {
      badge.className = 'pill plain sm';
    }
  }

  if (!count) {
    box.innerHTML = `
      <div class="active-calls-empty">
        <div class="empty-icon-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
        </div>
        <div>
          <div class="empty-title">No Active Calls Right Now</div>
          <div class="muted sm">When an agent connects with a customer, real-time call details and live talk duration counters stream here.</div>
        </div>
      </div>
    `;
    return;
  }

  box.innerHTML = `
    <div class="active-calls-grid">
      ${calls.map((c) => {
        const agentName = c.agent_name && c.agent_name !== `Ext ${c.extension}` ? c.agent_name : `Ext ${c.extension}`;
        const dir = (c.direction || 'inbound').toLowerCase();
        const isOutbound = dir === 'outbound';
        const startTs = c.answered_at || c.started_at;
        return `
          <div class="active-call-card">
            <div class="active-call-head">
              <div class="agent-info">
                <span class="pulse-live-dot"></span>
                <strong>${esc(agentName)}</strong>
                <span class="ext-tag">Ext ${esc(c.extension)}</span>
              </div>
              <span class="pill ${isOutbound ? 'accent' : 'ok'} sm">${esc(directionLabel(dir))}</span>
            </div>
            <div class="customer-info">
              <span class="customer-phone">${esc(c.customer_number || 'Unknown Caller')}</span>
              ${c.customer_name ? `<span class="customer-name">${esc(c.customer_name)}</span>` : ''}
            </div>
            <div class="active-call-foot">
              <span class="timer-pill">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span class="live-timer" data-start="${esc(startTs)}">${computeTimer(startTs)}</span>
              </span>
              <span class="live-status-tag">Connected</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function refresh() {
  const days = Number(daysSel.value);
  try {
    const status = statusSel.value;
    const [stats, calls, agents, dispositions, activeCalls] = await Promise.all([
      api(`/api/stats?days=${days}`),
      api(`/api/calls?limit=100${status ? `&status=${status}` : ''}`),
      api('/api/supervisor/agents'),
      api('/api/supervisor/dispositions'),
      api('/api/calls?status=active&limit=50').catch(() => []),
    ]);
    $('#error').hidden = true;
    renderKpis(stats);
    renderActiveCalls(activeCalls);
    renderPending(stats);
    renderOutcomes(stats, days);
    renderAgents(stats, days);
    renderCalls(calls);
    renderPins(agents);
    renderDispositions(dispositions);
  } catch (err) {
    if (err.status === 401) return showLogin('Your session ended. Please sign in again.');
    const box = $('#error');
    box.textContent = err.message;
    box.hidden = false;
  }
}

async function saveAgent(ext, pin, name) {
  if (!/^\d{4,12}$/.test(pin)) { toast('PIN must be 4 to 12 digits'); return false; }
  try {
    await api(`/api/supervisor/agents/${ext}/pin`, { method: 'POST', body: { pin, name } });
    toast(`Agent ${name ? `${name} (` : ''}Ext ${ext}${name ? ')' : ''} saved`);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

function renderPins(agents) {
  const box = $('#pins');
  const summaryEl = $('#agentStatusSummary');
  const badgeEl = $('#sidebarOnlineBadge');
  const onlineCount = agents.filter((a) => a.online).length;
  if (badgeEl) {
    badgeEl.textContent = String(onlineCount);
    badgeEl.hidden = false;
  }
  if (summaryEl) {
    summaryEl.innerHTML = `<strong style="color:var(--ok)">${onlineCount}</strong> of <strong>${agents.length}</strong> agents online on extension / app · Manage PINs below`;
  }

  if (!agents.length) { box.innerHTML = '<div class="empty">No agents yet. Add one below.</div>'; return; }
  // Keep half-typed PINs when the table refreshes.
  const typed = Object.fromEntries([...box.querySelectorAll('input[data-pin]')].map((i) => [i.dataset.pin, i.value]));
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Agent</th><th>App Status</th><th>PIN</th><th>Queue</th><th>New PIN</th><th>Action</th></tr></thead>
    <tbody>${agents.map((a) => {
      const displayName = a.name && a.name !== `Ext ${a.ext}` ? a.name : `Ext ${a.ext}`;
      return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <strong>${esc(displayName)}</strong>
          <button class="btn-icon sm" data-edit-name="${esc(a.ext)}" data-current-name="${esc(a.name && a.name !== `Ext ${a.ext}` ? a.name : '')}" title="Edit agent name">✏️</button>
        </div>
        <div class="muted sm">Ext ${esc(a.ext)}</div>
      </td>
      <td>${a.online
        ? '<span class="pill ok">Online</span>'
        : '<span class="pill plain" style="color:var(--muted)">Offline</span>'}</td>
      <td>${a.hasPin ? `<span class="pill ok">Set</span><div class="muted sm">${esc(fmtDateTime(a.pinSetAt))}</div>` : '<span class="pill warn">Not set</span>'}</td>
      <td>${a.held ? '<span class="pill warn">Paused</span>' : '<span class="muted sm">—</span>'}</td>
      <td><div class="inline-form">
        <input data-pin="${esc(a.ext)}" type="password" inputmode="numeric" maxlength="12" placeholder="4–12 digits" aria-label="New PIN for extension ${esc(a.ext)}" autocomplete="new-password">
        <button class="btn sm" data-save-pin="${esc(a.ext)}">${a.hasPin ? 'Reset' : 'Set'}</button>
      </div></td>
      <td><button class="btn sm danger" data-delete-agent="${esc(a.ext)}">Delete</button></td>
    </tr>`;
    }).join('')}</tbody></table></div>`;
  for (const input of box.querySelectorAll('input[data-pin]')) input.value = typed[input.dataset.pin] || '';
  for (const btn of box.querySelectorAll('[data-save-pin]')) {
    btn.addEventListener('click', async () => {
      const ext = btn.dataset.savePin;
      const input = box.querySelector(`input[data-pin="${CSS.escape(ext)}"]`);
      if (await saveAgent(ext, input.value.trim())) { input.value = ''; refresh(); }
    });
  }
  for (const btn of box.querySelectorAll('[data-edit-name]')) {
    btn.addEventListener('click', async () => {
      const ext = btn.dataset.editName;
      const currentName = btn.dataset.currentName || '';
      const newName = prompt(`Enter name for extension ${ext}:`, currentName);
      if (newName === null) return;
      try {
        await api(`/api/supervisor/agents/${ext}/name`, { method: 'POST', body: { name: newName.trim() } });
        toast(`Name updated for extension ${ext}`);
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }
  for (const btn of box.querySelectorAll('[data-delete-agent]')) {
    btn.addEventListener('click', async () => {
      const ext = btn.dataset.deleteAgent;
      if (!confirm(`Are you sure you want to delete extension ${ext}?`)) return;
      try {
        await api(`/api/supervisor/agents/${ext}`, { method: 'DELETE' });
        toast(`Extension ${ext} deleted`);
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

function renderDispositions(catalog) {
  const box = $('#dispositionsCatalog');
  const catSelect = $('#dispCategorySelect');
  if (!catalog || !catalog.categories || !catalog.categories.length) {
    box.innerHTML = '<div class="empty">No dispositions configured. Add one below.</div>';
    return;
  }

  // Populate category select dropdown
  const currentCat = catSelect.value;
  catSelect.innerHTML = '<option value="">Select category...</option>' +
    catalog.categories.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  if (currentCat) catSelect.value = currentCat;

  // Render cards for each category
  box.innerHTML = `<div class="dispo-grid">${catalog.categories.map((cat) => `
    <div class="dispo-cat-card">
      <div class="dispo-cat-header">
        <strong>${esc(cat.name)}</strong>
        <span class="muted sm">(${cat.outcomes.length} option${cat.outcomes.length === 1 ? '' : 's'})</span>
      </div>
      <ul class="dispo-list">
        ${cat.outcomes.map((o) => `
          <li class="dispo-item">
            <span class="dispo-name">${esc(o.name)}</span>
            <div class="dispo-meta">
              ${o.requiresFollowUp ? '<span class="pill warn sm" title="Requires agent to specify follow-up date">Follow-up</span>' : ''}
              ${o.id ? `<button class="btn-icon danger sm" data-del-dispo="${o.id}" title="Remove this disposition">&times;</button>` : ''}
            </div>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('')}</div>`;

  // Bind delete handlers
  for (const btn of box.querySelectorAll('[data-del-dispo]')) {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delDispo;
      if (!confirm('Remove this disposition option? Agents will no longer see this choice.')) return;
      try {
        await api(`/api/supervisor/dispositions/${id}`, { method: 'DELETE' });
        toast('Disposition removed');
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

function renderKpis({ today, held, enforce }) {
  $('#kpis').innerHTML = `
    <div class="card kpi kpi-blue">
      <div class="kpi-top">
        <span class="kpi-label">CALLS TODAY</span>
        <span class="kpi-icon-pill kpi-icon-blue">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </span>
      </div>
      <div class="kpi-value">${today.total}</div>
      <div class="kpi-sub">${today.needing} needed an outcome</div>
    </div>
    <div class="card kpi kpi-green">
      <div class="kpi-top">
        <span class="kpi-label">RESOLUTION RATE</span>
        <span class="kpi-icon-pill kpi-icon-green">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </span>
      </div>
      <div class="kpi-value">${pct(today.done, today.needing)}</div>
      <div class="kpi-sub">${today.done} of ${today.needing}${today.waived ? ` · ${today.waived} released` : ' saved'}</div>
    </div>
    <div class="card kpi kpi-amber ${today.pending ? 'alert' : ''}">
      <div class="kpi-top">
        <span class="kpi-label">WAITING NOW</span>
        <span class="kpi-icon-pill kpi-icon-amber">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </span>
      </div>
      <div class="kpi-value">${today.pending}</div>
      <div class="kpi-sub">calls pending disposition</div>
    </div>
    <div class="card kpi kpi-purple ${held.length ? 'alert' : ''}">
      <div class="kpi-top">
        <span class="kpi-label">AGENTS PAUSED</span>
        <span class="kpi-icon-pill kpi-icon-purple">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </span>
      </div>
      <div class="kpi-value">${held.length}</div>
      <div class="kpi-sub">${enforce ? 'logged out of queues' : 'queue logout is off'}</div>
    </div>`;
}

function renderPending({ pending }) {
  const box = $('#pending');
  if (!pending.length) { box.innerHTML = '<div class="empty">Nothing waiting. Every finished call has an outcome.</div>'; return; }
  const byAgent = new Map();
  for (const c of pending) {
    if (!byAgent.has(c.extension)) byAgent.set(c.extension, []);
    byAgent.get(c.extension).push(c);
  }
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Agent</th><th>Customer</th><th>Call</th><th>Ended</th><th></th></tr></thead>
    <tbody>${[...byAgent.entries()].map(([ext, calls]) => calls.map((c, i) => `
      <tr>
        <td class="nowrap">${i === 0 ? `<strong>${esc(c.agent_name && c.agent_name !== `Ext ${ext}` ? c.agent_name : `Ext ${ext}`)}</strong><div class="muted sm">Ext ${esc(ext)}</div>` : ''}</td>
        <td class="nowrap">${esc(c.customer_number || 'Unknown')}${c.customer_name ? `<div class="muted sm">${esc(c.customer_name)}</div>` : ''}</td>
        <td class="nowrap">${esc(directionLabel(c.direction))}<div class="muted sm">${c.answered_at ? fmtDuration(c.talk_seconds) : 'Not answered'}</div></td>
        <td class="nowrap">${esc(fmtAgo(c.ended_at))}</td>
        <td class="num">${i === 0 ? `<button class="btn-release sm" data-release="${esc(ext)}" data-count="${calls.length}">Release agent</button>` : ''}</td>
      </tr>`).join('')).join('')}
    </tbody></table></div>`;
  for (const btn of box.querySelectorAll('[data-release]')) {
    btn.addEventListener('click', () => release(btn.dataset.release, Number(btn.dataset.count)));
  }
}

const PALETTE = ['#f97316', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#eab308'];

function renderOutcomes({ outcomes }, days) {
  $('#outcomesPeriod').textContent = periodLabel(days);
  const box = $('#outcomes');
  const analyticsBox = $('#analyticsOutcomes');
  const analyticsPeriod = $('#analyticsPeriod');
  if (analyticsPeriod) analyticsPeriod.textContent = periodLabel(days);

  if (!outcomes.length) {
    const emptyHtml = `
      <div class="donut-chart-container empty-donut-layout">
        <div class="donut-svg-wrapper">
          <svg viewBox="0 0 160 160" class="donut-svg">
            <circle cx="80" cy="80" r="58" class="donut-track" stroke-dasharray="364.4" stroke-dashoffset="0"/>
            <text x="80" y="74" class="donut-center-num">0</text>
            <text x="80" y="92" class="donut-center-lbl">CALLS</text>
          </svg>
        </div>
        <div class="donut-empty-text">
          <div class="empty-title">No Outcomes Saved Yet</div>
          <div class="muted sm">No calls have completed with a disposition for ${periodLabel(days)}. As agents select outcomes, real-time visual categorization and donut breakdown will render here.</div>
        </div>
      </div>
    `;
    box.innerHTML = emptyHtml;
    if (analyticsBox) analyticsBox.innerHTML = emptyHtml;
    return;
  }

  const total = outcomes.reduce((s, o) => s + o.n, 0);
  const C = 364.425;
  let accumulated = 0;
  const slices = outcomes.slice(0, 7).map((o, idx) => {
    const ratio = o.n / total;
    const dashLength = Math.max(ratio * C, 2);
    const strokeDash = `${dashLength.toFixed(1)} ${C.toFixed(1)}`;
    const strokeOffset = (-accumulated).toFixed(1);
    accumulated += ratio * C;
    const color = PALETTE[idx % PALETTE.length];
    return `<circle cx="80" cy="80" r="58" class="donut-slice" stroke="${color}" stroke-dasharray="${strokeDash}" stroke-dashoffset="${strokeOffset}"/>`;
  }).join('');

  const chartHtml = `
    <div class="donut-chart-container">
      <div class="donut-svg-wrapper">
        <svg viewBox="0 0 160 160" class="donut-svg">
          <circle cx="80" cy="80" r="58" class="donut-track"/>
          ${slices}
          <text x="80" y="74" class="donut-center-num">${total}</text>
          <text x="80" y="92" class="donut-center-lbl">TOTAL</text>
        </svg>
      </div>
      <div class="donut-legend-side">
        ${outcomes.slice(0, 5).map((o, idx) => {
          const share = Math.round((o.n / total) * 100);
          const color = PALETTE[idx % PALETTE.length];
          return `
            <div class="outcome-bar-item">
              <div class="outcome-bar-header">
                <span class="outcome-bar-title">
                  <span class="color-dot" style="background:${color}"></span>
                  <strong>${esc(o.disposition)}</strong>
                  <span class="muted sm">(${esc(o.category)})</span>
                </span>
                <span class="outcome-bar-metric"><strong>${o.n}</strong> (${share}%)</span>
              </div>
              <div class="outcome-bar-track">
                <div class="outcome-bar-fill" style="width: ${share}%; background: ${color};"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Outcome</th><th>Category</th><th class="num">Calls</th><th class="num">Share</th></tr></thead>
      <tbody>${outcomes.map((o) => `<tr>
        <td><strong>${esc(o.disposition)}</strong></td>
        <td><span class="cat-pill">${esc(o.category)}</span></td>
        <td class="num font-bold">${o.n}</td>
        <td class="num font-bold">${pct(o.n, total)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  `;

  box.innerHTML = chartHtml;
  if (analyticsBox) analyticsBox.innerHTML = chartHtml;
}

function renderAgents({ agents }, days) {
  $('#agentsPeriod').textContent = periodLabel(days);
  const box = $('#agents');
  const analyticsBox = $('#analyticsAgents');

  if (!agents.length) {
    const emptyHtml = '<div class="empty">No finished calls in this period yet.</div>';
    box.innerHTML = emptyHtml;
    if (analyticsBox) analyticsBox.innerHTML = emptyHtml;
    return;
  }
  const tableHtml = `<div class="table-wrap"><table>
    <thead><tr><th>Agent</th><th class="num">Calls</th><th class="num">Outcome saved</th><th class="num">Waiting</th><th class="num">Sales</th><th class="num">Avg talk</th></tr></thead>
    <tbody>${agents.map((a) => `<tr>
      <td><strong>${esc(a.name || `Ext ${a.extension}`)}</strong><div class="muted sm">Ext ${esc(a.extension)}</div></td>
      <td class="num">${a.calls}</td>
      <td class="num">${pct(a.dispositioned, a.calls)}</td>
      <td class="num">${a.pending || '—'}</td>
      <td class="num">${a.conversions}${a.dispositioned ? ` <span class="muted sm">(${pct(a.conversions, a.dispositioned)})</span>` : ''}</td>
      <td class="num">${a.avg_talk ? fmtDuration(a.avg_talk) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
  box.innerHTML = tableHtml;
  if (analyticsBox) analyticsBox.innerHTML = tableHtml;
}

function renderCalls(calls) {
  const box = $('#calls');
  if (!calls.length) { box.innerHTML = '<div class="empty">No calls to show.</div>'; return; }
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Started</th><th>Agent</th><th>Customer</th><th>Type</th><th class="num">Talk</th><th>Status</th><th>Outcome</th><th>Follow-up</th><th>Notes</th></tr></thead>
    <tbody>${calls.map((c) => {
      const [tone, label] = STATUS[c.status] || ['', c.status];
      const outcome = c.disposition
        ? `${esc(c.disposition)}<div class="muted sm">${esc(c.category || '')}${c.sub_disposition ? ` · ${esc(c.sub_disposition)}` : ''}</div>`
        : c.status === 'waived' ? `<span class="muted sm">${esc(c.waived_reason || 'No reason given')}</span>` : '';
      return `<tr>
        <td class="nowrap">${esc(fmtDateTime(c.started_at))}</td>
        <td class="nowrap"><strong>${esc(c.agent_name && c.agent_name !== `Ext ${c.extension}` ? c.agent_name : `Ext ${c.extension}`)}</strong>${c.agent_name && c.agent_name !== `Ext ${c.extension}` ? `<div class="muted sm">Ext ${esc(c.extension)}</div>` : ''}</td>
        <td class="nowrap">${esc(c.customer_number || 'Unknown')}${c.customer_name ? `<div class="muted sm">${esc(c.customer_name)}</div>` : ''}</td>
        <td class="nowrap">${esc(directionLabel(c.direction))}</td>
        <td class="num">${c.status === 'active' ? '' : c.answered_at ? fmtDuration(c.talk_seconds) : '—'}</td>
        <td class="nowrap"><span class="pill ${tone}">${esc(label)}</span></td>
        <td>${outcome}</td>
        <td class="nowrap">${esc(fmtDate(c.follow_up_date))}</td>
        <td class="notes">${esc((c.notes || '').slice(0, 160))}${(c.notes || '').length > 160 ? '…' : ''}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}
