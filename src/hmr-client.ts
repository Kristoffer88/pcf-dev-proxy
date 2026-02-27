/**
 * In-page runtime for PCF hot reload.
 *
 * Loaded by appending this snippet to intercepted bundle.js in hot mode.
 * Connects directly to the proxy control plane via WebSocket.
 */

export const HMR_CLIENT_SOURCE = `;(function () {
  if (window.__pcfHmrRuntimeInstalled) return;
  window.__pcfHmrRuntimeInstalled = true;

  var PREFIX = "[PCF-HMR]";
  var registry = Object.create(null);
  var reloadStates = Object.create(null);

  function log() {
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, [PREFIX].concat(args));
  }
  function warn() {
    var args = Array.prototype.slice.call(arguments);
    console.warn.apply(console, [PREFIX].concat(args));
  }
  function err() {
    var args = Array.prototype.slice.call(arguments);
    console.error.apply(console, [PREFIX].concat(args));
  }

  function shortNameFromControl(controlName) {
    return String(controlName || "").replace(/^cc_/, "");
  }

  function getOrCreateEntry(shortName) {
    if (!registry[shortName]) {
      registry[shortName] = {
        shortName: shortName,
        ctor: null,
        instances: []
      };
    }
    return registry[shortName];
  }

  function upsertInstance(entry, record) {
    for (var i = 0; i < entry.instances.length; i++) {
      if (entry.instances[i].instance === record.instance) {
        entry.instances[i] = record;
        return;
      }
    }
    entry.instances.push(record);
  }

  function removeInstance(entry, instance) {
    var result = [];
    for (var i = 0; i < entry.instances.length; i++) {
      if (entry.instances[i].instance !== instance) result.push(entry.instances[i]);
    }
    entry.instances = result;
  }

  function patchCtor(shortName, Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    var entry = getOrCreateEntry(shortName);
    entry.ctor = Ctor;

    var proto = Ctor.prototype;
    if (proto.__pcfHmrWrapped) return;

    var originalInit = typeof proto.init === "function" ? proto.init : null;
    var originalDestroy = typeof proto.destroy === "function" ? proto.destroy : null;

    proto.init = function (context, notifyOutputChanged, state, container) {
      var result = originalInit ? originalInit.apply(this, arguments) : undefined;
      upsertInstance(entry, {
        instance: this,
        context: context,
        notifyOutputChanged: notifyOutputChanged,
        state: state,
        container: container
      });
      return result;
    };

    proto.destroy = function () {
      removeInstance(entry, this);
      if (originalDestroy) {
        return originalDestroy.apply(this, arguments);
      }
    };

    proto.__pcfHmrWrapped = true;
    log("Instrumented control:", shortName);
  }

  function installFrameworkPatch() {
    var cf = window.ComponentFramework;
    if (!cf || typeof cf.registerControl !== "function") return false;
    if (cf.__pcfHmrRegisterPatched) return true;

    var originalRegister = cf.registerControl;
    cf.registerControl = function (name, ctor) {
      try {
        var shortName = shortNameFromControl(name);
        // Patch before framework registration so init() wrapping is active
        // even if the framework instantiates synchronously during registerControl().
        if (ctor) {
          patchCtor(shortName, ctor);
        }
      } catch (e) {
        warn("registerControl pre-patch failed:", e);
      }

      var result = originalRegister.apply(this, arguments);

      try {
        var resolved = ctor;
        if (!resolved && typeof cf.getRegisteredControl === "function") {
          resolved = cf.getRegisteredControl(shortName);
        }
        if (resolved) {
          patchCtor(shortName, resolved);
        }
      } catch (e) {
        warn("registerControl post-patch failed:", e);
      }
      return result;
    };

    cf.__pcfHmrRegisterPatched = true;
    log("Patched ComponentFramework.registerControl");
    return true;
  }

  function waitForCtor(shortName, timeoutMs) {
    return new Promise(function (resolve) {
      var started = Date.now();
      var timer = setInterval(function () {
        try {
          var cf = window.ComponentFramework;
          var ctor = cf && typeof cf.getRegisteredControl === "function"
            ? cf.getRegisteredControl(shortName)
            : null;
          if (ctor) {
            clearInterval(timer);
            patchCtor(shortName, ctor);
            resolve(ctor);
            return;
          }
        } catch (_) {}

        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 50);
    });
  }

  function findBundleScript(controlName) {
    var scripts = document.querySelectorAll("script[src]");
    var suffix = "/" + controlName + "/bundle.js";

    for (var i = 0; i < scripts.length; i++) {
      try {
        var url = new URL(scripts[i].src, window.location.href);
        if (url.pathname.indexOf(suffix) !== -1) {
          return scripts[i];
        }
      } catch (_) {}
    }

    return null;
  }

  var _wsPort = window.__pcfHmrWsPort || 8643;
  var _ws = null;

  function emit(type, payload) {
    if (_ws && _ws.readyState === 1) {
      try {
        _ws.send(JSON.stringify({ type: type, payload: payload }));
        return;
      } catch (_) {}
    }
    warn("WS not connected, dropping " + type);
  }

  function getReloadState(shortName) {
    if (!reloadStates[shortName]) {
      reloadStates[shortName] = {
        inFlight: false,
        pending: null
      };
    }
    return reloadStates[shortName];
  }

  function runReload(payload) {
    var startedAt = Date.now();
    var controlName = payload.controlName;
    var shortName = shortNameFromControl(controlName);
    var id = payload.id;
    var buildId = payload.buildId;

    var state = getReloadState(shortName);
    if (state.inFlight) {
      state.pending = payload;
      log("Reload already in flight; coalescing to latest:", id);
      return;
    }

    state.inFlight = true;

    Promise.resolve()
      .then(function () {
        installFrameworkPatch();

        var script = findBundleScript(controlName);
        if (!script) {
          throw new Error("Could not locate control bundle script for " + controlName);
        }

        var entry = getOrCreateEntry(shortName);
        var instances = entry.instances.slice();
        var total = instances.length;

        for (var ri = 0; ri < instances.length; ri++) {
          var record = instances[ri];
          try {
            if (record.instance && typeof record.instance.destroy === "function") {
              record.instance.destroy();
            }
          } catch (e) {
            warn("destroy() failed:", e);
          }

          try {
            if (record.container) {
              record.container.innerHTML = "";
            }
          } catch (_) {}
        }

        var oldUrl = new URL(script.src, window.location.href);
        oldUrl.searchParams.set("_hmr", String(Date.now()));
        script.remove();

        return new Promise(function (resolve, reject) {
          var nextScript = document.createElement("script");
          nextScript.src = oldUrl.toString();
          nextScript.onload = function () {
            waitForCtor(shortName, 2500).then(function (NewCtor) {
              if (!NewCtor) {
                reject(new Error("New constructor not found for " + shortName));
                return;
              }

              var reloaded = 0;
              instances.forEach(function (record) {
                try {
                  if (!record.container) throw new Error("Missing container");
                  var ctl = new NewCtor();
                  var ctx = record.context || {};
                  var notify = record.notifyOutputChanged || function () {};
                  ctl.init(ctx, notify, record.state || null, record.container);
                  if (typeof ctl.updateView === "function") {
                    ctl.updateView(ctx);
                  }
                  reloaded++;
                } catch (e) {
                  warn("Re-init failed:", e);
                }
              });

              var status = "failed";
              if (reloaded === total) status = "success";
              else if (reloaded > 0) status = "partial";

              resolve({
                id: id,
                controlName: controlName,
                buildId: buildId,
                status: status,
                instancesTotal: total,
                instancesReloaded: reloaded,
                durationMs: Date.now() - startedAt,
                timestamp: Date.now()
              });
            });
          };
          nextScript.onerror = function () {
            reject(new Error("Failed to load updated bundle.js"));
          };
          document.head.appendChild(nextScript);
        });
      })
      .then(function (ack) {
        emit("pcf-hmr:ack", ack);
      })
      .catch(function (error) {
        var ack = {
          id: id,
          controlName: controlName,
          buildId: buildId,
          status: "failed",
          instancesTotal: 0,
          instancesReloaded: 0,
          durationMs: Date.now() - startedAt,
          error: error && error.message ? error.message : String(error),
          timestamp: Date.now()
        };
        emit("pcf-hmr:ack", ack);
      })
      .finally(function () {
        state.inFlight = false;
        if (state.pending) {
          var next = state.pending;
          state.pending = null;
          runReload(next);
        }
      });
  }

  // Direct WebSocket connection to proxy control plane
  function connectWs() {
    try {
      var ws = new WebSocket("ws://127.0.0.1:" + _wsPort + "/ws");
      ws.onopen = function () {
        _ws = ws;
        log("Direct WS connected (port " + _wsPort + ")");
      };
      ws.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);
          if (msg.type === "pcf-hmr:reload" && msg.payload) {
            runReload(msg.payload);
          }
        } catch (_) {}
      };
      ws.onclose = function () {
        if (_ws === ws) _ws = null;
        log("Direct WS closed, reconnecting in 3s");
        setTimeout(connectWs, 3000);
      };
      ws.onerror = function () {
        // onclose will fire after this
      };
    } catch (_) {
      setTimeout(connectWs, 3000);
    }
  }
  connectWs();

  // Eagerly trap ComponentFramework so we patch registerControl the instant
  // it appears, before the bundle's own registerControl call at the bottom.
  if (!installFrameworkPatch()) {
    var _cfValue = window.ComponentFramework;
    var _trapped = false;
    try {
      Object.defineProperty(window, "ComponentFramework", {
        configurable: true,
        enumerable: true,
        get: function () { return _cfValue; },
        set: function (v) {
          _cfValue = v;
          if (!_trapped && v && typeof v.registerControl === "function") {
            _trapped = true;
            // Restore as normal property before patching
            Object.defineProperty(window, "ComponentFramework", {
              configurable: true, enumerable: true, writable: true, value: v
            });
            installFrameworkPatch();
          }
        }
      });
    } catch (e) {
      // Fallback to polling if defineProperty fails
      var patchAttempts = 0;
      var patchTimer = setInterval(function () {
        patchAttempts++;
        if (installFrameworkPatch() || patchAttempts > 120) {
          clearInterval(patchTimer);
        }
      }, 250);
    }
  }

  log("Runtime installed");
})();`;
