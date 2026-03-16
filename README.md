# pcf-dev-proxy

HTTPS MITM proxy for PCF development against live Dataverse pages.

By default it intercepts control assets and serves local build output.
With `--hot`, it also enables deterministic in-place PCF control hot-reload (no full page refresh).

## Quick start

```bash
npx pcf-dev-proxy
```

This auto-detects `ControlManifest.Input.xml`, resolves `cc_<namespace>.<constructor>`, and serves files from `out/controls/<constructor>`.

## Hot mode (no full page reload)

```bash
npx pcf-dev-proxy --hot
```

Hot mode injects an HMR client into `bundle.js` — any browser connecting through the proxy gets live reload automatically. It adds:

- local HMR control plane on `127.0.0.1` (default port `8643`)
- direct WebSocket from page to control plane
- in-page runtime instrumentation for PCF instance swap
- CSP header stripping on passthrough responses (hot mode only)

### Trigger reload from your build pipeline

Primary workflow is explicit trigger from build completion:

```bash
npx pcf-dev-proxy reload \
  --control cc_Contoso.MyControl \
  --trigger pcf-start \
  --build-id "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Optional fallback watcher:

```bash
npx pcf-dev-proxy --hot --watch-bundle
```

## Control plane API

When hot mode is enabled (`--hot`):

- `GET /health`
- `POST /reload`
- `POST /ack`
- `GET /last-ack`

Example reload payload:

```json
{ "controlName": "cc_Contoso.MyControl", "buildId": "2026-02-27T12:34:56.789Z", "trigger": "pcf-start" }
```

Example ACK payload from runtime:

```json
{ "id": "r-123", "controlName": "cc_Contoso.MyControl", "buildId": "2026-02-27T12:34:56.789Z", "status": "success", "instancesTotal": 2, "instancesReloaded": 2, "durationMs": 184 }
```

## CLI

```bash
# start proxy
npx pcf-dev-proxy [options]

# enqueue a reload (no proxy startup)
npx pcf-dev-proxy reload --control <name> [options]
```

Options:

- `--port <number>` Proxy port (default `8642`)
- `--ws-port <number>` HMR control plane port (default `8643`)
- `--dir <path>` Directory to serve files from
- `--control <name>` Override control name
- `--hot` Enable hot mode (default: on). Injects HMR client into `bundle.js` so any browser through the proxy gets live reload.
- `--no-hot` Disable hot mode
- `--watch-bundle` Watch `bundle.js` and auto-trigger reload (hot mode only)

Reload subcommand options:

- `--ws-port <number>` Control plane port
- `--control <name>` Required control name
- `--build-id <id>` Build identifier
- `--trigger <source>` Trigger label
- `--changed-files <csv>` Optional changed files metadata

## Connecting a browser

The proxy prints connection commands on startup. Use a dedicated profile so proxy settings don't affect your daily browsing:

```bash
# Chrome (macOS)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --proxy-server=127.0.0.1:8642 \
  --ignore-certificate-errors-spki-list=<SPKI from proxy output> \
  --user-data-dir=~/.pcf-dev-proxy/chrome-profile \
  --disable-session-crashed-bubble
```

The profile at `~/.pcf-dev-proxy/chrome-profile` is **persistent** — your Dataverse login, cookies, and session survive across proxy restarts.

Playwright and agent-browser work too — see the proxy startup output for copy-pasteable commands.

## Typical PCF workflow

```bash
# terminal 1 — build watcher
pcf-start

# terminal 2 — proxy (prints connection commands)
npx pcf-dev-proxy --hot

# terminal 3 — launch browser using the command from proxy output

# terminal 4 (or post-build hook) — trigger reload after build completes
npx pcf-dev-proxy reload --control cc_Contoso.MyControl --trigger pcf-start
```

## Troubleshooting

- **No reload applied**: check `GET /last-ack` for latest runtime status.
- **ACK timeout**: ensure Dataverse tab is open in a browser connected through the proxy.
- **Multiple rapid builds**: queue is latest-wins per control; only newest pending reload is applied.

## Requirements

- Node.js >= 18
- A Chromium-based browser (Chrome, Edge, Playwright, agent-browser)
- A PCF project with `ControlManifest.Input.xml`

## License

MIT
