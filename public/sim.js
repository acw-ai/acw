import { $, esc, api } from './common.js';

const form = $('#callForm');
const target = $('#target');
const submitBtn = form.querySelector('button[type="submit"]');
let lastAgentsKey = '';

const showError = (msg) => {
  const box = $('#error');
  box.textContent = msg || '';
  box.hidden = !msg;
};
const run = async (fn) => {
  try { showError(''); await fn(); await refresh(); } catch (err) { showError(err.message); }
};

const syncButton = () => {
  const isQueue = target.value === 'queue';
  $('#direction').disabled = isQueue;
  if (isQueue) $('#direction').value = 'inbound';
  submitBtn.textContent = isQueue ? 'Send queue call' : $('#direction').value === 'outbound' ? 'Agent dials out' : 'Ring this agent';
};
target.addEventListener('change', syncButton);
$('#direction').addEventListener('change', syncButton);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(() => api('/api/sim/calls', {
    method: 'POST',
    body: { ext: target.value, direction: $('#direction').value, number: $('#number').value, name: $('#name').value },
  }));
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, id, ext, status } = b.dataset;
  if (act === 'answer' || act === 'hangup') run(() => api(`/api/sim/calls/${id}/${act}`, { method: 'POST' }));
  if (act === 'queue') run(() => api(`/api/sim/agents/${ext}/queue`, { method: 'POST', body: { status } }));
});

async function refresh() {
  let state;
  try { state = await api('/api/sim/state'); } catch (err) { return showError(err.message); }
  const { agents, calls } = state;

  const key = agents.map((a) => a.ext).join(',');
  if (key !== lastAgentsKey) {
    lastAgentsKey = key;
    target.innerHTML = '<option value="queue">Sales queue (next free agent)</option>' +
      agents.map((a) => `<option value="${esc(a.ext)}">${esc(a.name)} · Ext ${esc(a.ext)}</option>`).join('');
    syncButton();
  }

  $('#agents').innerHTML = agents.map((a) => {
    const inQueue = a.queueStatus === 'LoggedIn';
    return `<div class="card sim-agent">
      <div class="sim-agent-head"><div><strong>${esc(a.name)}</strong><div class="muted sm">Ext ${esc(a.ext)}</div></div>
        <span class="pill ${inQueue ? 'ok' : 'warn'}">${inQueue ? 'In queue' : 'Logged out'}</span></div>
      <div class="muted sm">${a.busy ? 'On a call' : 'Not on a call'}</div>
      <div class="row-actions">
        <a class="btn sm" href="/agent.html?ext=${encodeURIComponent(a.ext)}" target="acw-dispo-${esc(a.ext)}">Open popup</a>
        <button class="btn sm ghost" data-act="queue" data-ext="${esc(a.ext)}" data-status="${inQueue ? 'LoggedOut' : 'LoggedIn'}"
          title="${inQueue ? 'Log out of the queue' : 'Pretend the agent logs back in from the 3CX app'}">${inQueue ? 'Log out' : 'Log in from 3CX app'}</button>
      </div>
    </div>`;
  }).join('');

  const names = Object.fromEntries(agents.map((a) => [a.ext, a.name]));
  $('#calls').innerHTML = calls.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Agent</th><th>Customer</th><th>Type</th><th>Status</th><th></th></tr></thead>
    <tbody>${calls.map((c) => `<tr>
      <td>${esc(names[c.ext] || c.ext)} <span class="muted sm">Ext ${esc(c.ext)}</span></td>
      <td>${esc(c.number)}${c.name ? ` <span class="muted sm">${esc(c.name)}</span>` : ''}</td>
      <td>${c.direction === 'outbound' ? 'Outbound' : 'Inbound'}</td>
      <td><span class="pill ${c.status === 'Connected' ? 'ok' : 'accent'}">${esc(c.status)}</span></td>
      <td class="num"><div class="row-actions" style="justify-content:flex-end">
        ${c.status !== 'Connected' ? `<button class="btn sm" data-act="answer" data-id="${c.id}">${c.direction === 'outbound' ? 'Customer answers' : 'Answer'}</button>` : ''}
        <button class="btn sm danger" data-act="hangup" data-id="${c.id}">${c.status === 'Connected' ? 'Hang up' : 'No answer / cancel'}</button>
      </div></td>
    </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No calls right now.</div>';
}

refresh();
setInterval(refresh, 1000);
