# pcf-dev-proxy

HTTPS MITM proxy for PCF development against live Dataverse pages.

By default it intercepts control assets and serves local build output.
With `--hot`, it also enables deterministic in-place PCF control hot-reload (no full page refresh).

## Quick start

```bash
npx pcf-dev-proxy
```

This auto-detects `ControlManifest.Input.xml`, resolves `cc_<namespace>.<constructor>`, and serves files from `out/controls/<constructor>`.

## Hot mode (Chrome, no full page reload)

```bash
npx pcf-dev-proxy --hot --yes
```

Hot mode adds:

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
- `--browser <name>` `chrome` or `edge` (auto-detected)
- `--hot` Enable hot mode (Chrome only)
- `--watch-bundle` Watch `bundle.js` and enqueue reload (hot mode only)
- `-y, --yes` Skip launch prompt

Reload subcommand options:

- `--ws-port <number>` Control plane port
- `--control <name>` Required control name
- `--build-id <id>` Build identifier
- `--trigger <source>` Trigger label
- `--changed-files <csv>` Optional changed files metadata

## Browser profile

The proxy launches Chrome with a dedicated profile at `~/.pcf-dev-proxy/chrome-profile`. This profile is **persistent** — your Dataverse login, cookies, and session survive across proxy restarts. You only need to authenticate once.

The profile is separate from your normal Chrome profile, so proxy settings (certificate trust, `--proxy-server` flag) don't affect your daily browsing.

## Typical PCF workflow

```bash
# terminal 1 — build watcher
pcf-start

# terminal 2 — proxy
npx pcf-dev-proxy --hot

# terminal 3 (or post-build hook) — trigger reload after build completes
npx pcf-dev-proxy reload --control cc_Contoso.MyControl --trigger pcf-start
```

On first run, Chrome opens and you log into Dataverse. On subsequent runs, the session is already there.

## Troubleshooting

- **No reload applied**: check `GET /last-ack` for latest runtime status.
- **ACK timeout**: ensure Dataverse tab is open in the Chrome instance launched by the proxy.
- **Chrome won't launch**: if Chrome is already running with the proxy profile, the proxy skips launch. Close the existing proxy Chrome window first, or just reload the page.
- **Browser mismatch**: hot mode currently supports Chrome only (Edge works for non-hot proxy usage).
- **Multiple rapid builds**: queue is latest-wins per control; only newest pending reload is applied.
- **`pcf-scripts build` fails with Chrome profile errors**: this can happen if `.cache/` contains a Chrome profile. The proxy stores its Chrome profile at `~/.pcf-dev-proxy/chrome-profile` (outside the project) to avoid this.

## Requirements

- Node.js >= 18
- Chrome for hot mode (Edge remains supported for non-hot proxy usage)
- A PCF project with `ControlManifest.Input.xml`

## License

MIT
