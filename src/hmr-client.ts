/**
 * PCF Hot Module Reload client.
 *
 * Compiled to JS, then read by the proxy and appended to every served bundle.js.
 * The proxy replaces __WS_PORT__ with the actual port at serve-time.
 */

export const HMR_CLIENT_SOURCE = `;(async () => {
  if (window.__pcfHmr) return;
  window.__pcfHmr = true;

  const WS_PORT = __WS_PORT__;
  const PREFIX  = "[PCF-HMR]";

  const log  = (...args) => console.log(PREFIX, ...args);
  const warn = (...args) => console.warn(PREFIX, ...args);
  const err  = (...args) => console.error(PREFIX, ...args);

  /* 1. Health-check — silently exit when the proxy is not reachable (production safety) */
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(\`http://127.0.0.1:\${WS_PORT}\`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return;
    const data = await r.json();
    if (data?.type !== "pcf-dev-proxy-hmr") return;
    log("Proxy detected — starting hot-reload client");
  } catch { return; /* proxy not running or blocked, silently bail */ }

  /* 2. WebSocket connection with reconnect */
  let attempts = 0;

  const connect = () => {
    if (attempts > 20) { warn("Gave up reconnecting."); return; }
    attempts++;
    let ws;
    try { ws = new WebSocket(\`ws://127.0.0.1:\${WS_PORT}\`); } catch { return; }

    ws.onopen = () => {
      log("Connected to proxy HMR server");
      attempts = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "pcf-reload") {
          log("Reload signal for:", msg.controlName);
          reload(msg.controlName);
        }
      } catch (e) { err("Bad WS message", e); }
    };
    ws.onclose = () => {
      log("Disconnected — reconnecting in 3s");
      setTimeout(connect, 3000);
    };
    ws.onerror = () => { /* onclose fires after this */ };
  };

  connect();

  /* 3. Hot-reload logic */
  function reload(controlName) {
    /* 3a. Find old <script> tag for this control's bundle */
    const scripts   = document.querySelectorAll("script[src]");
    const shortName = controlName.replace(/^cc_/, "");
    const pattern   = new RegExp(controlName.replace(/\\./g, "\\\\\\\\.") + "/bundle\\\\\\\\.js");
    let oldScript = null;

    for (const s of scripts) {
      if (pattern.test(s.src)) { oldScript = s; break; }
    }

    if (!oldScript) {
      warn("Could not find <script> tag for", controlName, "— trying broader search");
      for (const s of scripts) {
        if (s.src.includes("bundle.js")) { oldScript = s; break; }
      }
    }

    if (!oldScript) {
      err("No bundle.js script tag found on page");
      return;
    }

    /* 3b. Collect live control instances BEFORE loading new script */
    const instances = findControlInstances(shortName);
    log(\`Found \${instances.length} live instance(s)\`);

    /* 3c. Destroy old instances */
    for (const info of instances) {
      try {
        if (typeof info.controlInstance?.destroy === "function") {
          info.controlInstance.destroy();
          log("Destroyed old instance");
        }
      } catch (e) { warn("destroy() threw:", e); }
      if (info.container) { info.container.innerHTML = ""; }
    }

    /* 3d. Remove old script, insert new with cache-bust */
    const url = new URL(oldScript.src);
    url.searchParams.set("_hmr", Date.now().toString());
    oldScript.remove();

    const newScript = document.createElement("script");
    newScript.src = url.toString();

    const loadTimeout = setTimeout(() => {
      err(\`Bundle load timed out after 10s — \${url}\`);
    }, 10000);

    newScript.onload = () => {
      clearTimeout(loadTimeout);
      log("New bundle loaded");

      /* 3e. Get updated constructor from registry */
      const NewCtor = window.ComponentFramework?.getRegisteredControl?.(shortName);

      if (!NewCtor) {
        err(\`New constructor not found in registry for \${shortName}\`);
        return;
      }

      /* 3f. Re-init each instance */
      for (const info of instances) {
        try {
          const ctl = new NewCtor();
          if (!info.container) {
            warn("No container reference — skipping re-init");
            continue;
          }
          const ctx = info.context || {};
          const notify = info.notifyOutputChanged || (() => {});
          ctl.init(ctx, notify, info.state || null, info.container);
          if (typeof ctl.updateView === "function") {
            ctl.updateView(ctx);
          }
          log("Re-initialized instance successfully");
        } catch (e) {
          err("Re-init failed:", e);
        }
      }
    };

    newScript.onerror = () => {
      clearTimeout(loadTimeout);
      err(\`Failed to load new bundle from \${url}\`);
    };

    document.head.appendChild(newScript);
  }

  /* 4. Find live control instances by walking React fiber tree */
  function findControlInstances(shortName) {
    const results = [];
    const candidates = document.querySelectorAll(
      ".customControl, [data-lp-id], [data-control-name]"
    );

    for (const el of candidates) {
      const info = extractFromFiber(el);
      if (info?.controlInstance) {
        results.push(info);
      }
    }

    /* Deduplicate by controlInstance identity */
    const seen = new Set();
    return results.filter((r) => {
      if (seen.has(r.controlInstance)) return false;
      seen.add(r.controlInstance);
      return true;
    });
  }

  function extractFromFiber(el) {
    const fiberKey = Object.keys(el).find((k) =>
      k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;

    let current = el[fiberKey];
    let maxDepth = 50;

    while (current && maxDepth-- > 0) {
      const state = current.stateNode;
      if (state?._controlInstance) {
        const container = state._standardControlContainer || state._rootElement || null;
        let context = null;

        if (state._propertyBag) {
          try { context = state._propertyBag; } catch {}
        }
        if (!context && current.memoizedProps?.propBagData) {
          const pbd = current.memoizedProps.propBagData;
          context = {
            parameters: pbd.parameters || {},
            mode: pbd.modeData || {},
            client: pbd.clientData || {}
          };
        }

        return {
          controlInstance: state._controlInstance,
          container,
          context,
          notifyOutputChanged: null,
          state: null
        };
      }
      current = current.return;
    }

    return null;
  }
})();
`;
