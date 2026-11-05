const SERVER_URL = 'https://dispositions.getus.ca';
let catalog = null;
let currentPendingCallId = null;
let pollTimer = null;
let es = null;

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  setupEvents();
  await checkAuth();
});

function setupEvents() {
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ext = $('extInput').value.trim();
    const pin = $('pinInput').value.trim();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    $('loginError').hidden = true;

    try {
      const res = await fetch(`${SERVER_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ext, pin }),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Wrong extension or PIN');
      }

      await chrome.storage.local.set({ ext, loggedIn: true, serverUrl: SERVER_URL });
      await checkAuth();
    } catch (err) {
      $('loginError').textContent = err.message;
      $('loginError').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try {
      await fetch(`${SERVER_URL}/api/logout?role=agent`, { method: 'POST', credentials: 'include' });
    } catch {}
    try {
      if (chrome.cookies) {
        await chrome.cookies.remove({ url: SERVER_URL, name: 'getus_agent_session' });
        await chrome.cookies.remove({ url: SERVER_URL, name: 'getus_session' });
      }
    } catch (e) {
      console.warn('Cookie remove failed:', e);
    }
    if (es) {
      es.close();
      es = null;
    }
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ loggedIn: false });
    chrome.action.setBadgeText({ text: '' });
    clearInterval(pollTimer);
    $('extInput').value = '';
    $('pinInput').value = '';
    showLoginView();
  });

  $('catSelect').addEventListener('change', (e) => {
    populateOutcomes(e.target.value);
  });

  $('outcomeSelect').addEventListener('change', (e) => {
    const cat = catalog?.categories.find((c) => c.name === $('catSelect').value);
    const outcome = cat?.outcomes.find((o) => o.name === e.target.value);
    $('followUpGroup').hidden = !outcome?.requiresFollowUp;
  });

  $('dispositionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentPendingCallId) return;

    const btn = $('saveOutcomeBtn');
    btn.disabled = true;

    try {
      const res = await fetch(`${SERVER_URL}/api/calls/${currentPendingCallId}/disposition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: $('catSelect').value,
          disposition: $('outcomeSelect').value,
          followUpDate: $('followUpDate').value || null,
          notes: $('notesInput').value.trim()
        }),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to save outcome');
      }

      // Reset form and badge
      $('dispositionForm').reset();
      $('outcomeFormCard').hidden = true;
      currentPendingCallId = null;
      chrome.action.setBadgeText({ text: '' });

      // Refresh agent state
      const { ext } = await chrome.storage.local.get(['ext']);
      if (ext) await refreshAgentState(ext);

      // If opened as a separate popup window, close window automatically after saving
      if (window.outerWidth < 500) {
        window.close();
      }
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

async function checkAuth() {
  const { loggedIn } = await chrome.storage.local.get(['loggedIn']);
  if (!loggedIn) {
    showLoginView();
    return;
  }

  try {
    const cfgRes = await fetch(`${SERVER_URL}/api/config`);
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      catalog = cfg.catalog;
      populateCategories();
    }

    const meRes = await fetch(`${SERVER_URL}/api/me?role=agent`, { credentials: 'include' });
    const me = await meRes.json().catch(() => ({}));

    if (me?.role === 'agent') {
      showAgentView(me.ext, me.name);
      return;
    }
  } catch (err) {
    console.warn('Auth check error:', err);
  }

  // Not logged in or invalid session
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ loggedIn: false });
  showLoginView();
}

function showLoginView() {
  if (es) {
    es.close();
    es = null;
  }
  $('loginView').hidden = false;
  $('agentView').hidden = true;
  $('logoutBtn').hidden = true;
  $('agentDisplay').textContent = 'Not signed in';
}

function showAgentView(ext, name) {
  $('loginView').hidden = true;
  $('agentView').hidden = false;
  $('logoutBtn').hidden = false;
  $('agentDisplay').textContent = name && name !== `Ext ${ext}` ? `${name} (Ext ${ext})` : `Ext ${ext}`;

  connectSSE(ext);
  refreshAgentState(ext);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refreshAgentState(ext), 2000);
}

function connectSSE(ext) {
  if (es) es.close();
  try {
    es = new EventSource(`${SERVER_URL}/api/agents/${encodeURIComponent(ext)}/events`, { withCredentials: true });
    es.addEventListener('state', (e) => {
      try {
        const data = JSON.parse(e.data);
        handleAgentState(data);
      } catch (err) {
        console.warn('SSE parse error:', err);
      }
    });
    es.onerror = () => {
      // EventSource automatically retries
    };
  } catch (e) {
    console.warn('EventSource failed:', e);
  }
}

async function refreshAgentState(ext) {
  try {
    const res = await fetch(`${SERVER_URL}/api/agents/${ext}/state`, { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    handleAgentState(data);
  } catch (err) {
    console.warn('Poll error:', err);
  }
}

function handleAgentState(data) {
  if (!data) return;
  const pending = data.pending || data.pendingCalls || [];
  const active = data.active || data.activeCalls || [];

  if (pending.length > 0) {
    renderPendingCall(pending[0]);
  } else if (active.length > 0) {
    renderActiveCall(active[0]);
  } else {
    $('outcomeFormCard').hidden = true;
    $('callContainer').innerHTML = '';
    $('idleState').hidden = false;
  }
}

function renderActiveCall(call) {
  $('idleState').hidden = true;
  $('outcomeFormCard').hidden = true;
  const caller = call.customer_number || 'Active Call';
  const name = call.customer_name || (call.direction === 'outbound' ? 'Outbound Call' : 'Inbound Call');
  $('callContainer').innerHTML = `
    <div class="card active-call">
      <div class="pill active">On Call</div>
      <h3>${caller}</h3>
      <p class="muted sm">${name}</p>
    </div>
  `;
}

function renderPendingCall(call) {
  $('idleState').hidden = true;
  $('callContainer').innerHTML = '';
  currentPendingCallId = call.id;

  const durationText = call.talk_seconds != null ? `${call.talk_seconds}s duration` : 'Ended';
  const customer = call.customer_number || call.customer_name || 'Customer';
  $('pendingCustomer').textContent = `Call with ${customer} (${durationText})`;
  $('outcomeFormCard').hidden = false;
}

function populateCategories() {
  if (!catalog?.categories) return;
  const sel = $('catSelect');
  sel.innerHTML = '<option value="">Select category...</option>';
  catalog.categories.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
}

function populateOutcomes(categoryName) {
  const sel = $('outcomeSelect');
  sel.innerHTML = '<option value="">Select outcome...</option>';
  const cat = catalog?.categories.find((c) => c.name === categoryName);

  if (!cat || !cat.outcomes.length) {
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  cat.outcomes.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o.name;
    opt.textContent = o.name;
    sel.appendChild(opt);
  });
}
