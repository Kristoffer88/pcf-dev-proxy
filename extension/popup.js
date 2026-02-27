function render(state) {
  if (!state) return;

  const dot = document.getElementById("dot");
  const statusText = document.getElementById("status-text");
  const port = document.getElementById("port");
  const lastReload = document.getElementById("last-reload");
  const lastAck = document.getElementById("last-ack");

  dot.className = "dot " + (state.connected ? "on" : "off");
  statusText.textContent = state.connected ? "Connected" : "Disconnected";
  port.textContent = state.wsPort || "—";

  if (state.lastReload) {
    const d = new Date(state.lastReload);
    lastReload.textContent = d.toLocaleTimeString();
  } else {
    lastReload.textContent = "—";
  }

  if (state.lastAck) {
    const d = new Date(state.lastAck.time);
    lastAck.textContent = (state.lastAck.type === "success" ? "OK" : "Error") + " at " + d.toLocaleTimeString();
    lastAck.className = "value " + (state.lastAck.type === "success" ? "ack-success" : "ack-error");
  } else {
    lastAck.textContent = "—";
    lastAck.className = "value";
  }
}

// Initial load: query background for current state
chrome.runtime.sendMessage({ type: "pcf-hmr:get-status" }, render);

// Live updates via storage changes
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes["pcf-hmr-status"]) {
    render(changes["pcf-hmr-status"].newValue);
  }
});
