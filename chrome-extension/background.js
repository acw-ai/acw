const DEFAULT_SERVER = 'https://dispositions.getus.ca';
let popupWindowId = null;
let lastNotifiedCallId = null;
let streamAbortController = null;

chrome.runtime.onInstalled.addListener(() => {
  console.log('GETUS Dispositions extension installed.');
  initConnection();
});

chrome.runtime.onStartup.addListener(() => {
  initConnection();
});

// Reconnect whenever configuration changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.ext || changes.serverUrl || changes.loggedIn) {
    initConnection();
  }
});

async function initConnection() {
  const { ext, serverUrl = DEFAULT_SERVER, loggedIn } = await chrome.storage.local.get(['ext', 'serverUrl', 'loggedIn']);
  
  if (!ext || !loggedIn) {
    if (streamAbortController) {
      streamAbortController.abort();
      streamAbortController = null;
    }
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  // Poll state and listen for updates
  await checkAgentState(serverUrl, ext);
  listenSSE(serverUrl, ext);
}

// Background alarm to keep state synced and ensure connection stays alive
chrome.alarms.create('check-state', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check-state') {
    const { ext, serverUrl = DEFAULT_SERVER, loggedIn } = await chrome.storage.local.get(['ext', 'serverUrl', 'loggedIn']);
    if (ext && loggedIn) {
      await checkAgentState(serverUrl, ext);
      if (!streamAbortController) {
        listenSSE(serverUrl, ext);
      }
    }
  }
});

async function checkAgentState(serverUrl, ext) {
  try {
    const res = await fetch(`${serverUrl}/api/agents/${ext}/state`, { credentials: 'include' });
    if (res.status === 401 || res.status === 403) {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ loggedIn: false });
      chrome.action.setBadgeText({ text: '' });
      if (streamAbortController) {
        streamAbortController.abort();
        streamAbortController = null;
      }
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    handleState(data);
  } catch (err) {
    console.warn('State check failed:', err);
  }
}

function handleState(data) {
  if (!data) return;
  const pending = data.pending || data.pendingCalls || [];
  const active = data.active || data.activeCalls || [];

  if (pending.length > 0) {
    chrome.action.setBadgeText({ text: String(pending.length) });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });

    // If a call is pending, trigger notification & popup window
    triggerDispositionNotice(pending[0]);
  } else if (active.length > 0) {
    lastNotifiedCallId = null;
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  } else {
    lastNotifiedCallId = null;
    chrome.action.setBadgeText({ text: '' });
  }
}

async function listenSSE(serverUrl, ext) {
  if (streamAbortController) {
    streamAbortController.abort();
  }
  streamAbortController = new AbortController();

  try {
    const res = await fetch(`${serverUrl}/api/agents/${ext}/events`, {
      signal: streamAbortController.signal,
      credentials: 'include'
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({ loggedIn: false });
        chrome.action.setBadgeText({ text: '' });
      }
      streamAbortController = null;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop(); // keep remainder

      for (const block of blocks) {
        const lines = block.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event: '));
        const dataLine = lines.find((l) => l.startsWith('data: '));
        if (eventLine && dataLine) {
          const eventType = eventLine.slice(7).trim();
          if (eventType === 'state') {
            try {
              const data = JSON.parse(dataLine.slice(6));
              handleState(data);
            } catch (e) {
              console.warn('SSE parse error:', e);
            }
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('SSE stream disconnected, will reconnect:', err);
    }
  } finally {
    streamAbortController = null;
  }
}

function triggerDispositionNotice(call) {
  if (!call || !call.id) return;

  if (lastNotifiedCallId !== call.id) {
    lastNotifiedCallId = call.id;

    chrome.notifications.create(`disposition-${call.id}`, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Call Ended - Outcome Required',
      message: `Call with ${call.customer_number || call.customer_name || 'Customer'} ended. Please save outcome.`,
      priority: 2,
      requireInteraction: true
    });
  }

  // Open small floating popup window automatically if not already opened
  if (!popupWindowId) {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 440,
      height: 700,
      focused: true
    }, (win) => {
      popupWindowId = win?.id || null;
    });
  }
}

chrome.windows.onRemoved.addListener((winId) => {
  if (winId === popupWindowId) {
    popupWindowId = null;
  }
});
