# Analysis: Is pcf-dev-proxy Smart and Useful?

> An honest evaluation of this project against Microsoft's official tooling and every known community alternative.

---

## The Problem This Solves

PCF (PowerApps Component Framework) development has a fundamental tension: **you need real Dataverse data and APIs to meaningfully test your control, but the only official way to get that is to deploy to Dataverse, which is slow.** The local test harness (`npm start watch`) gives you instant feedback but fakes everything -- no real WebAPI calls, no dataset paging/sorting/filtering, no field-level security, no navigation APIs. The `pac pcf push` command gives you real data but takes minutes per iteration and has a history of bugs.

Every tool in this space -- official or community -- is fundamentally trying to bridge that gap.

---

## How Microsoft Says You Should Do It

### 1. Local Test Harness (`npm start watch`)

Microsoft's primary recommendation. Runs a browser sandbox at `localhost:8181`.

**What it gives you:**
- Instant rebuild on save
- Source map debugging in DevTools
- Property editing panel

**What it can't do:**
- Access real Dataverse data (`context.webAPI.*` throws "not implemented")
- Dataset paging, sorting, filtering (throws exceptions)
- Complex data types (choices, lookups return minimal metadata)
- Model-driven app behavior (field-level security, read-only, command bar)
- Navigation and Utility APIs
- Match production styling

**Verdict:** Good for pure UI iteration. Useless for anything that touches real data or platform APIs.

### 2. `pac pcf push`

Deploys your control to Dataverse for live testing.

**Pain points:**
- Slow (creates temp solution, imports, publishes all customizations)
- Requires version increment in `ControlManifest.xml`
- Known bugs: certain CLI versions silently stop publishing
- Incremental push exists but is hidden behind an undocumented feature flag (`verbPcfPushIncremental: "on"`)

**Verdict:** Necessary for final validation. Too slow for inner-loop development.

### 3. Fiddler AutoResponder (Official recommendation)

Microsoft's own docs recommend Fiddler for live debugging against Dataverse.

**The workflow:**
1. Deploy once with `pac pcf push`
2. Run `npm start watch` locally
3. Configure Fiddler HTTPS decryption
4. Set up AutoResponder rules with complex REGEX to redirect `bundle.js` to local files
5. Hard refresh browser
6. Repeat

**Pain points:**
- **Windows only** -- no Mac/Linux support
- Rewrites the **system-level proxy**, breaking Microsoft Teams desktop and other apps
- Requires HTTPS certificate installation and decryption setup
- Complex REGEX patterns for the AutoResponder rules
- Manual CORS header overrides needed for Canvas Apps
- Must remember to disable when done

**Verdict:** It works, but the setup is fragile, invasive, and Windows-locked.

### 4. Requestly (Mentioned in official docs)

Browser extension alternative to Fiddler.

**Pain points:**
- Free only for non-commercial use, limited to 3 active rules
- Paid plans: $8-$23/month
- Extension-based approach is subject to Chrome Manifest V3 restrictions

**Verdict:** Lighter than Fiddler but carries licensing costs for professional use.

---

## Community Alternatives

### pcf-cli-proxy-tools (mitmproxy-based, by David Ovrelid)

The closest comparable tool. Uses Python's mitmproxy.

- Cross-platform (Mac, Linux, Windows)
- CLI-driven
- Opens pre-configured Chrome window
- Documented at [pcfproxy.dev](https://pcfproxy.dev/)

**Key differences from pcf-dev-proxy:**

| Aspect | pcf-cli-proxy-tools | pcf-dev-proxy |
|--------|-------------------|---------------|
| Proxy engine | mitmproxy (Python) | mockttp (Node.js) |
| Runtime dependency | Python + mitmproxy installed | Node.js only (zero external deps) |
| Certificate setup | Manual system keychain install | Auto-generated, SPKI pinning (no system install) |
| Hot reload | No | Yes (WebSocket-based HMR) |
| Browser isolation | Separate Chrome profile | Separate Chrome profile |
| Control detection | Manual `.env` config | Auto-detect from `ControlManifest.Input.xml` |
| Reload mechanism | Full page refresh | In-place HMR (destroy/recreate instances) |
| API for automation | No | Yes (REST + WebSocket control plane) |

### Resource Override (Chrome extension, by Kyle Paulsen)

- Was the easiest option (simple URL redirect rules)
- **Discontinued** due to Chrome Manifest V3 deprecation

### pcf-reloader-transformer

- Injects auto-refresh logic into model-driven apps
- Debug mode with `debugger` breakpoints
- No proxy -- works differently (webpack transformer)

---

## What pcf-dev-proxy Does Differently

### 1. Zero-friction certificate handling

Every other proxy-based solution requires manual certificate installation into the system keychain. pcf-dev-proxy generates a self-signed CA, caches it locally, and passes the SPKI fingerprint to Chrome via `--ignore-certificate-errors-spki-list`. **No system-level certificate changes. No keychain. No cleanup.**

This is genuinely clever. It means the proxy only affects the isolated browser instance it launches -- nothing else on the system is touched.

### 2. True hot module reload for PCF

No other tool in the PCF ecosystem offers this. The HMR system:

1. Patches `ComponentFramework.registerControl()` at the framework level
2. Tracks all active control instances per control name
3. On reload: calls `destroy()` on all instances, clears DOM, fetches new bundle with cache-busting, waits for new constructor registration, creates new instances with original context/state, calls `updateView()`
4. Reports back via WebSocket with success/partial/failed status, instance counts, duration

This matches what modern web frameworks (React Fast Refresh, Vite HMR) do -- but adapted for the PCF lifecycle where you don't control the host page. The "latest-wins" queue prevents reload spam during multi-file edits.

**Compare this to every other approach:** Fiddler, Requestly, pcf-cli-proxy-tools -- they all require a **full page refresh**, which means:
- Losing page state (form data, scroll position, navigation context)
- Re-authenticating if session expired
- Waiting for the entire Dataverse page to reload (which is slow)

### 3. Agent-friendly control plane

The REST API (`POST /reload`, `GET /last-ack`) and WebSocket interface make this tool composable. An AI coding agent or CI system can:
- Trigger reloads programmatically after builds
- Check reload status and get structured feedback
- Chain reloads with other operations

No other PCF tool has this. The "agent mode" vs "human mode" distinction (explicit trigger vs watch-based auto-reload) is a forward-looking design choice.

### 4. Pure Node.js, zero external dependencies

pcf-cli-proxy-tools requires Python and mitmproxy installed. Fiddler is a standalone Windows application. pcf-dev-proxy is `npx pcf-dev-proxy` -- it runs in the same Node.js environment PCF developers already have. No Python. No system tools. No installer.

### 5. Auto-detection

Finds the `ControlManifest.Input.xml`, extracts namespace and constructor, resolves the serving directory -- all automatically. Compare this to pcf-cli-proxy-tools which requires manual `.env` configuration with the CRM URL path, proxy port, HTTP server port, Chrome exe path, and mitmproxy path.

---

## Honest Weaknesses

### 1. Chrome-only for hot mode

Hot reload requires Chrome. Edge works for standard proxy mode but not HMR. This is a limitation of the `--ignore-certificate-errors-spki-list` flag and the HMR runtime injection approach. In practice, most developers use Chrome DevTools, so this is acceptable but worth noting.

### 2. MITM proxy is inherently complex

The approach intercepts HTTPS traffic. While the isolated browser profile limits the blast radius, users need to understand what's happening. A misconfigured proxy could theoretically intercept unintended traffic (though the URL matching is scoped to the control name pattern).

### 3. CSP header stripping in hot mode

The proxy strips Content-Security-Policy headers to allow WebSocket communication for HMR. This changes the security posture of the page during development. Acceptable for dev, but developers should be aware.

### 4. No Canvas App special handling (yet)

Microsoft's docs note that Canvas Apps serve PCF resources from blob storage with different CORS requirements. Fiddler's docs show special CORS header injection for this case. pcf-dev-proxy doesn't appear to have Canvas-specific handling.

---

## Is It Smart?

**Yes.** The architectural decisions are sound:

1. **SPKI pinning instead of system cert installation** -- eliminates the biggest friction point in every other proxy tool. This alone makes the DX dramatically better.

2. **HMR via registerControl patching** -- this is the correct interception point. The PCF framework uses a registration pattern, and wrapping it lets the HMR system track instances without modifying the host page's code.

3. **mockttp over mitmproxy** -- staying in the Node.js ecosystem means no cross-language dependency management. PCF developers already have Node.js; asking them to also install Python is friction.

4. **Separation of proxy and control plane** -- the proxy (port 8642) and HMR control plane (port 8643) are independent. You can use the proxy without HMR, or trigger reloads from external tools. This composability is good architecture.

5. **Latest-wins reload queue** -- prevents the common problem where rapid saves trigger cascading reloads. Only the final build matters.

---

## Is It Useful?

**Very.** Here's the competitive landscape mapped to developer needs:

| Need | Test Harness | pac pcf push | Fiddler | Requestly | pcf-cli-proxy | pcf-dev-proxy |
|------|:-----------:|:------------:|:-------:|:---------:|:-------------:|:-------------:|
| Real Dataverse data | - | Yes | Yes | Yes | Yes | Yes |
| Fast iteration | Yes | - | Medium | Medium | Medium | **Fast (HMR)** |
| Cross-platform | Yes | Yes | - | Yes | Yes | Yes |
| Zero setup friction | Yes | Medium | - | Medium | Low | **High** |
| No system changes | Yes | Yes | - | Yes | - | **Yes** |
| Works with AI agents | - | - | - | - | - | **Yes** |
| Free for commercial | Yes | Yes | Yes | - | Yes | Yes |
| Active/maintained | Yes | Yes | Yes | Yes | ? | Yes |

pcf-dev-proxy occupies a unique position: it's the **only tool that combines real-data testing, sub-second HMR feedback, zero system modifications, and programmatic control**. Every other tool requires either giving up real data (test harness), accepting slow iteration (pac pcf push), invasive system changes (Fiddler), recurring costs (Requestly), or external runtime dependencies (pcf-cli-proxy-tools).

### Who benefits most?

1. **PCF developers who test against live Dataverse pages daily** -- the HMR alone saves minutes per iteration cycle, compounding across hundreds of daily saves.

2. **Teams on Mac/Linux** -- Fiddler (the official recommendation) doesn't work. pcf-cli-proxy-tools requires Python. This is pure Node.js.

3. **AI-assisted development workflows** -- the control plane API is purpose-built for agent orchestration. No other tool in this space has considered this use case.

4. **Developers who are frustrated with Fiddler's system proxy rewriting** -- the isolated browser approach means Teams keeps working, other apps keep working, and there's nothing to clean up.

---

## Bottom Line

This project identifies a real, well-documented pain point in PCF development and solves it with a technically sound approach that is meaningfully better than every existing alternative. The HMR system is the standout feature -- nobody else has it. The zero-setup certificate handling and Node.js-native stack remove the friction that makes developers avoid proxy-based debugging entirely. The agent-friendly API is forward-looking in a way that other tools haven't considered.

It's not just smart -- it's the most complete solution to PCF live debugging that currently exists.
