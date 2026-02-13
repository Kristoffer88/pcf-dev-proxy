# pcf-dev-proxy

HTTPS proxy that intercepts deployed PCF bundle requests from Dynamics 365 and serves your local build instead.

## Quick start

```bash
npx pcf-dev-proxy
```

Reads your `ControlManifest.Input.xml`, detects the control name, and starts intercepting.

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

Or install as a devDependency:

```bash
npm install --save-dev pcf-dev-proxy
```

```json
{
  "scripts": {
    "proxy": "pcf-dev-proxy"
  }
}
```

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

## CLI options

```bash
npx pcf-dev-proxy                              # auto-detect everything
npx pcf-dev-proxy --port 9000                  # custom port
npx pcf-dev-proxy --control cc_Contoso.MyCtrl  # override control name
npx pcf-dev-proxy --dir ./my-build-output      # custom serving directory
npx pcf-dev-proxy --no-system-proxy            # don't configure system proxy
npx pcf-dev-proxy --off                        # disable proxy and exit
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

## Requirements

- Node.js >= 18
- Chrome (or any Chromium browser)
- A PCF project with `ControlManifest.Input.xml`

## License

MIT

## Credits

Built on [mockttp](https://github.com/httptoolkit/mockttp) by [HTTP Toolkit](https://httptoolkit.com/).
