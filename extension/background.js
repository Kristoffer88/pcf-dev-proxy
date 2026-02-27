const PREFIX = "[PCF-HMR-EXT]";
let wsPort = 8643;
let ws = null;
let isConnecting = false;
let connected = false;
let lastReload = null;
let lastAck = null;

function log(...args) {
  console.log(PREFIX, ...args);
}

function updateBadge(isConnected) {
  connected = isConnected;
  chrome.action.setBadgeText({ text: isConnected ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({
    color: isConnected ? "#2d7d46" : "#b91c1c"
  });
  persistState();
}

function persistState() {
  chrome.storage.local.set({
    "pcf-hmr-status": { connected, wsPort, lastReload, lastAck }
  });
}

function getState() {
  return { connected, wsPort, lastReload, lastAck };
}

function warn(...args) {
  console.warn(PREFIX, ...args);
}

function postAck(payload) {
  return fetch(`http://127.0.0.1:${wsPort}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch((error) => {
    warn("ACK post failed:", error);
  });
}

function sendToDynamicsTabs(message) {
  chrome.tabs.query({ url: ["https://*.dynamics.com/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, message, () => {
        if (chrome.runtime.lastError) {
          // Tab may not have content script yet.
        }
      });
    }
  });
}

function scheduleReconnect() {
  chrome.alarms.create("pcf-hmr-reconnect", { delayInMinutes: 0.05 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pcf-hmr-reconnect" || alarm.name === "pcf-hmr-keepalive") {
    connectWebSocket();
  }
});

function connectWebSocket() {
  if (isConnecting) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isConnecting = true;
  const url = `ws://127.0.0.1:${wsPort}/ws`;
  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    isConnecting = false;
    log("Connected to", url);
    updateBadge(true);
    sendToDynamicsTabs({ type: "pcf-hmr:init", wsPort });
  };

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message && message.type === "pcf-hmr:reload") {
        lastReload = new Date().toISOString();
        lastAck = null;
        persistState();
        sendToDynamicsTabs({ type: "pcf-hmr:reload", payload: message.payload });
      }
    } catch (error) {
      warn("Bad WS message:", error);
    }
  };

  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
    }
    isConnecting = false;
    updateBadge(false);
    log("Disconnected, retrying in 3s");
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose handles retries.
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("pcf-hmr-keepalive", { periodInMinutes: 0.5 });
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("pcf-hmr-keepalive", { periodInMinutes: 0.5 });
  connectWebSocket();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !tab.url.includes(".dynamics.com")) return;
  chrome.tabs.sendMessage(tabId, { type: "pcf-hmr:init", wsPort }, () => {
    if (chrome.runtime.lastError) {
      // Content script might not be ready.
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "pcf-hmr:ack" || message.type === "pcf-hmr:error") {
    lastAck = {
      type: message.type === "pcf-hmr:ack" ? "success" : "error",
      time: new Date().toISOString()
    };
    persistState();
    postAck(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "pcf-hmr:get-status") {
    sendResponse(getState());
    return;
  }

  if (message.type === "pcf-hmr:set-port" && typeof message.wsPort === "number") {
    wsPort = message.wsPort;
    connectWebSocket();
    sendResponse({ ok: true });
  }
});

try { updateBadge(false); } catch (e) { log("updateBadge init error:", e); }
connectWebSocket();
