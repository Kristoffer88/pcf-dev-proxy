(() => {
  const PREFIX = "[PCF-HMR-CONTENT]";

  function log(...args) {
    console.log(PREFIX, ...args);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "pcf-hmr:init") {
      log("Bridge ready", message.wsPort ? `(ws-port ${message.wsPort})` : "");
      return;
    }

    if (message.type === "pcf-hmr:reload" && message.payload) {
      log("Reload received:", message.payload.id || "(no id)");
      window.postMessage({
        source: "pcf-hmr-ext",
        type: "pcf-hmr:reload",
        payload: message.payload
      }, "*");
      log("Reload posted to page");
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "pcf-hmr-runtime") return;

    if (data.type === "pcf-hmr:ack" || data.type === "pcf-hmr:error") {
      chrome.runtime.sendMessage({
        type: data.type,
        payload: data.payload
      }, () => {
        if (chrome.runtime.lastError) {
          // Background may be restarting.
        }
      });
    }
  });
})();
