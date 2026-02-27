/**
 * PCF Hot Module Reload client.
 *
 * Compiled to JS, then read by the proxy and appended to every served bundle.js.
 * The proxy replaces __WS_PORT__ with the actual port at serve-time.
 */

export const HMR_CLIENT_SOURCE = `;(function () {
  if (window.__pcfHmr) return;
  window.__pcfHmr = true;

  var WS_PORT = __WS_PORT__;
  var PREFIX  = "[PCF-HMR]";

  function log()  { console.log.apply(console,   [PREFIX].concat(Array.prototype.slice.call(arguments))); }
  function warn() { console.warn.apply(console,  [PREFIX].concat(Array.prototype.slice.call(arguments))); }
  function err()  { console.error.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments))); }

  /* 1. Health-check — silently exit when the proxy is not reachable (production safety) */
  try {
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, 3000);
    fetch("http://127.0.0.1:" + WS_PORT, { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(tid);
        if (!r.ok) return;
        return r.json();
      })
      .then(function (data) {
        if (data && data.type === "pcf-dev-proxy-hmr") {
          log("Proxy detected — starting hot-reload client");
          startHmr();
        }
      })
      .catch(function () { /* proxy not running, silently bail */ });
  } catch (_) { /* old browser / blocked, bail */ }

  /* 2. WebSocket connection with reconnect */
  function startHmr() {
    var attempts = 0;

    function connect() {
      if (attempts > 20) { warn("Gave up reconnecting."); return; }
      attempts++;
      var ws;
      try { ws = new WebSocket("ws://127.0.0.1:" + WS_PORT); } catch(_) { return; }

      ws.onopen = function () {
        log("Connected to proxy HMR server");
        attempts = 0;
      };
      ws.onmessage = function (ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg.type === "pcf-reload") {
            log("Reload signal for:", msg.controlName);
            reload(msg.controlName);
          }
        } catch (e) { err("Bad WS message", e); }
      };
      ws.onclose = function () {
        log("Disconnected — reconnecting in 3s");
        setTimeout(connect, 3000);
      };
      ws.onerror = function () { /* onclose fires after this */ };
    }

    connect();
  }

  /* 3. Hot-reload logic */
  function reload(controlName) {
    /* 3a. Find old <script> tag for this control's bundle */
    var scripts   = document.querySelectorAll("script[src]");
    var shortName = controlName.replace(/^cc_/, "");
    var pattern   = new RegExp(controlName.replace(/\\./g, "\\\\\\\\.") + "/bundle\\\\\\\\.js");
    var oldScript = null;
    for (var i = 0; i < scripts.length; i++) {
      if (pattern.test(scripts[i].src)) { oldScript = scripts[i]; break; }
    }

    if (!oldScript) {
      warn("Could not find <script> tag for", controlName, "— trying broader search");
      for (var j = 0; j < scripts.length; j++) {
        if (scripts[j].src.indexOf("bundle.js") !== -1) { oldScript = scripts[j]; break; }
      }
    }

    if (!oldScript) {
      err("No bundle.js script tag found on page");
      return;
    }

    /* 3b. Collect live control instances BEFORE loading new script */
    var instances = findControlInstances(shortName);
    log("Found", instances.length, "live instance(s)");

    /* 3c. Destroy old instances */
    instances.forEach(function (info) {
      try {
        if (info.controlInstance && typeof info.controlInstance.destroy === "function") {
          info.controlInstance.destroy();
          log("Destroyed old instance");
        }
      } catch (e) { warn("destroy() threw:", e); }
      if (info.container) { info.container.innerHTML = ""; }
    });

    /* 3d. Remove old script, insert new with cache-bust */
    var url = new URL(oldScript.src);
    url.searchParams.set("_hmr", Date.now().toString());
    oldScript.remove();

    var newScript = document.createElement("script");
    newScript.src = url.toString();

    newScript.onload = function () {
      log("New bundle loaded");

      /* 3e. Get updated constructor from registry */
      var NewCtor = null;
      if (window.ComponentFramework && window.ComponentFramework.getRegisteredControl) {
        NewCtor = window.ComponentFramework.getRegisteredControl(shortName);
      }

      if (!NewCtor) {
        err("New constructor not found in registry for", shortName);
        return;
      }

      /* 3f. Re-init each instance */
      instances.forEach(function (info) {
        try {
          var ctl = new NewCtor();
          var container = info.container;
          if (!container) {
            warn("No container reference — skipping re-init");
            return;
          }
          var ctx = info.context || {};
          var notify = info.notifyOutputChanged || function () {};
          ctl.init(ctx, notify, info.state || null, container);
          if (typeof ctl.updateView === "function") {
            ctl.updateView(ctx);
          }
          log("Re-initialized instance successfully");
        } catch (e) {
          err("Re-init failed:", e);
        }
      });
    };

    newScript.onerror = function () {
      err("Failed to load new bundle from", url.toString());
    };

    document.head.appendChild(newScript);
  }

  /* 4. Find live control instances by walking React fiber tree */
  function findControlInstances(shortName) {
    var results = [];
    var candidates = document.querySelectorAll(
      ".customControl, [data-lp-id], [data-control-name]"
    );

    for (var i = 0; i < candidates.length; i++) {
      var info = extractFromFiber(candidates[i]);
      if (info && info.controlInstance) {
        results.push(info);
      }
    }

    /* Deduplicate by controlInstance identity */
    var seen = [];
    return results.filter(function (r) {
      if (seen.indexOf(r.controlInstance) !== -1) return false;
      seen.push(r.controlInstance);
      return true;
    });
  }

  function extractFromFiber(el) {
    var fiberKey = Object.keys(el).find(function (k) {
      return k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0;
    });
    if (!fiberKey) return null;

    var fiber = el[fiberKey];
    var current = fiber;
    var maxDepth = 50;

    while (current && maxDepth-- > 0) {
      var state = current.stateNode;
      if (state && state._controlInstance) {
        var container = state._standardControlContainer || state._rootElement || null;
        var context = null;

        if (state._propertyBag) {
          try { context = state._propertyBag; } catch (_) {}
        }
        if (!context && current.memoizedProps && current.memoizedProps.propBagData) {
          var pbd = current.memoizedProps.propBagData;
          context = {
            parameters: pbd.parameters || {},
            mode: pbd.modeData || {},
            client: pbd.clientData || {}
          };
        }

        return {
          controlInstance: state._controlInstance,
          container: container,
          context: context,
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
