# pcf-dev-proxy

> HTTPS proxy that intercepts deployed PCF bundle requests from Dynamics 365 and serves your local build instead. Zero config.

Skip the `pac pcf push` → wait → refresh cycle. Run `npx pcf-dev-proxy`, save your code, refresh the browser — see changes instantly against a live Dynamics 365 environment.

## Try it

```bash
npx pcf-dev-proxy
```

That's it. It reads your `ControlManifest.Input.xml`, figures out the control name, and starts intercepting.

```
Auto-detected control: cc_Contoso.MyControl
Restart Chrome with proxy PAC? [Y/n] y
Closing Chrome...
Relaunched Chrome with proxy PAC file.

PCF Dev Proxy running on port 8642
Intercepting: cc_Contoso.MyControl/*
Serving from: out/controls/MyControl/

  200  bundle.js (847 KB)
  200  bundle.js.map (1204 KB)
```

## Why

The standard PCF development loop is painfully slow:

1. Edit code
2. `npm run build`
3. `pac pcf push` (minutes)
4. Hard refresh browser
5. Repeat

With `pcf-dev-proxy`, step 3 disappears. Your local `out/controls/` directory is served directly to the browser.

### vs. Fiddler AutoResponder

Fiddler is the [officially recommended approach](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/debugging-custom-controls), but:

- Windows only (Fiddler Classic)
- System-wide proxy breaks Teams, triggers auth dialogs
- Manual regex rule setup per control
- Manual HTTPS certificate installation

### vs. Requestly

- Free tier limited to 3 rules
- $8-23/month for commercial use
- Manual rule configuration per control

### vs. pcf-cli-proxy-tools

- Requires separate Python/mitmproxy installation
- Manual `.env` configuration (CRM URL, Chrome path, ports)

### vs. Chrome DevTools Overrides

- Manual per-file setup, doesn't persist across sessions

## Features

- **Zero config** — auto-detects control name from `ControlManifest.Input.xml`
- **No external dependencies** — pure Node.js, everything installs via npm
- **Selective proxying** — PAC file routes only `*.dynamics.com` through the proxy; everything else is DIRECT
- **Auto CA trust** — generates and trusts the certificate on macOS and Windows
- **Source map support** — appends `sourceMappingURL` to JS responses when `.map` files exist
- **Chrome restart** — relaunches Chrome with the proxy PAC (with confirmation prompt)
- **Safe fallback** — if the proxy crashes, the PAC file falls back to DIRECT. No broken internet.

## How it works

```
Chrome (--proxy-pac-url) → PAC file (only *.dynamics.com) → MITM proxy (port 8642)
  ├── matching requests → serve from local out/controls/ directory
  └── all other requests → passthrough to real servers
```

1. Finds `ControlManifest.Input.xml` by walking up from your working directory
2. Parses `namespace` + `constructor` → builds intercept pattern (e.g. `cc_Contoso.MyControl`)
3. Generates a CA certificate (persisted in `.cache/`), trusts it in the OS keychain
4. Writes a PAC file that routes only `*.dynamics.com` through the proxy
5. Starts an HTTPS MITM proxy that intercepts matching bundle requests
6. Restarts Chrome with `--proxy-pac-url` pointing to the PAC

## Install

```bash
# Run directly (no install needed)
npx pcf-dev-proxy

# Or add to your project
npm install --save-dev pcf-dev-proxy
```

If installed as a devDependency, add to `package.json`:

```json
{
  "scripts": {
    "proxy": "pcf-dev-proxy"
  }
}
```

## Usage

```bash
# Start with auto-detection (most common)
npx pcf-dev-proxy

# Custom port
npx pcf-dev-proxy --port 9000

# Override control name
npx pcf-dev-proxy --control cc_Contoso.MyControl

# Custom serving directory
npx pcf-dev-proxy --dir ./my-build-output

# Don't configure system proxy
npx pcf-dev-proxy --no-system-proxy

# Disable proxy and exit
npx pcf-dev-proxy --off
```

## Typical workflow

```bash
# Terminal 1: watch mode
npm start

# Terminal 2: proxy
npx pcf-dev-proxy
```

Save a file → webpack rebuilds → refresh browser → see changes against live Dynamics 365.

## Platform support

| Feature | macOS | Windows |
|---------|-------|---------|
| Auto-proxy (PAC) | networksetup | Registry |
| CA trust | Keychain (sudo) | certutil |
| Chrome restart | osascript | taskkill |

## First run

On first run, the proxy will:

1. Generate a CA certificate (stored in `.cache/proxy-ca.pem`)
2. Ask for `sudo` (macOS) or admin elevation (Windows) to trust it
3. Prompt before restarting Chrome

The CA is persisted — subsequent runs skip steps 1-2.

## Requirements

- Node.js >= 18
- Chrome (or any Chromium browser)
- A PCF project with `ControlManifest.Input.xml`

## License

MIT

## Credits

Built on [mockttp](https://github.com/httptoolkit/mockttp) by [HTTP Toolkit](https://httptoolkit.com/).
