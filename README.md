# pcf-dev-proxy

HTTPS MITM proxy with deterministic hot reload for PCF controls on live Dataverse pages.

## Quick start

```bash
# Terminal 1: webpack watch (incremental rebuilds)
npx pcf-scripts start watch

# Terminal 2: proxy with hot reload
npx pcf-dev-proxy
```

Auto-detects `ControlManifest.Input.xml`, resolves `cc_<namespace>.<constructor>`, and serves files from `out/controls/<constructor>`.

Default ports: `8642` (proxy), `8643` (control plane).

## Agent workflow

Edit source → webpack rebuilds (~200ms) → POST /reload → GET /last-ack → verify success.

```bash
# 1. Edit files (webpack auto-rebuilds in background)

# 2. Trigger reload
curl -s -X POST http://127.0.0.1:8643/reload \
  -H "Content-Type: application/json" \
  -d '{"controlName":"cc_Contoso.MyControl","trigger":"agent"}'
# → {"accepted":true,"id":"r-1234567890-1"}

# 3. Verify
curl -s http://127.0.0.1:8643/last-ack
# → {"cc_Contoso.MyControl":{"status":"success","durationMs":62,...}}
```

Hot reload cycle: ~60-80ms. No full page refresh.

The queue is latest-wins per control — rapid consecutive POSTs coalesce to the newest pending reload (no reload spam).

## Control plane API

Bound to `127.0.0.1:8643` (override with `--ws-port`).

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Liveness check |
| POST | /reload | Enqueue a hot reload |
| POST | /ack | Runtime acknowledgement (internal) |
| GET | /last-ack | Latest ACK per control |
| WS | /ws | Real-time reload/ack stream |

### POST /reload

```json
{
  "controlName": "cc_Contoso.MyControl",
  "buildId": "2026-02-27T12:34:56.789Z",
  "trigger": "agent",
  "changedFiles": ["src/index.ts"]
}
```

`controlName` defaults to the auto-detected control. `buildId` defaults to ISO timestamp. `trigger` defaults to `"manual"`. `changedFiles` is optional metadata.

Response: `{"accepted": true, "id": "r-..."}`.

### GET /last-ack

Returns a map keyed by control name:

```json
{
  "cc_Contoso.MyControl": {
    "id": "r-123",
    "controlName": "cc_Contoso.MyControl",
    "buildId": "2026-02-27T12:34:56.789Z",
    "status": "success",
    "instancesTotal": 2,
    "instancesReloaded": 2,
    "durationMs": 184
  }
}
```

`status` is `"success"`, `"partial"`, or `"failed"`. On timeout (15s), status is `"failed"` with `error: "Timed out waiting for runtime ACK"`.

## CLI

```
npx pcf-dev-proxy [options]
npx pcf-dev-proxy reload --control <name> [options]
```

### Proxy options

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `8642` | Proxy port |
| `--ws-port <n>` | `8643` | Control plane port |
| `--dir <path>` | auto-detected | Directory to serve files from |
| `--control <name>` | auto-detected | Override control name |
| `--browser <name>` | auto-detected | `chrome` or `edge` |
| `--no-hot` | — | Disable hot reload (proxy-only, supports Edge) |
| `--watch-bundle` | off | Auto-reload on bundle.js change (human mode) |
| `--prompt` | off | Show browser launch confirmation prompt |

### Reload subcommand

| Flag | Default | Description |
|------|---------|-------------|
| `--control <name>` | required | Control name |
| `--ws-port <n>` | `8643` | Control plane port |
| `--build-id <id>` | ISO timestamp | Build identifier |
| `--trigger <source>` | `"manual"` | Trigger label |
| `--changed-files <csv>` | — | Changed files metadata |

## Human mode (optional)

For interactive development without an agent, add `--watch-bundle` to auto-reload when webpack writes `bundle.js`:

```bash
npx pcf-dev-proxy --watch-bundle
```

Monitors the serving directory with a 500ms debounce, then enqueues a reload automatically. Flow: save file → webpack rebuild (~200ms) → watch detects change → hot reload (~70ms). Total: ~700ms from save to UI update.

## Proxy-only mode (advanced)

To intercept and serve local files without hot reload:

```bash
npx pcf-dev-proxy --no-hot
```

Supports Chrome and Edge. No control plane, no WebSocket, no CSP stripping.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Reload not applied | `GET /last-ack` — look for `"status":"failed"` |
| ACK timeout (15s) | Ensure Dataverse tab is open in the launched Chrome |
| Port in use | `lsof -ti:8642 \| xargs kill` or use `--port` |
| Multiple rapid reloads | Queue is latest-wins per control; only newest applies |
| Browser mismatch | Hot mode requires Chrome (`--browser chrome`) |

## Requirements

- Node.js >= 18
- Chrome (hot mode requires Chrome for WebSocket injection)
- PCF project with `ControlManifest.Input.xml`

## License

MIT
