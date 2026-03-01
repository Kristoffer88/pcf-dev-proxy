# PCF Build Optimization

## Two Modes: Agent vs Human

### Agent mode (recommended for automation)

Agent controls when the reload fires — no reload spam during multi-file edits.

```bash
# Terminal 1: webpack watch (incremental rebuilds)
cd example/DevProxySample
npx pcf-scripts start watch

# Terminal 2: proxy (hot reload is on by default)
npx pcf-dev-proxy \
  --control "cc_Example.DevProxySample" \
  --dir "example/DevProxySample/out/controls/DevProxySample"
```

**Agent workflow:**
```bash
# 1. Make all edits (webpack auto-rebuilds in background)
edit src/index.ts
edit src/helper.ts
edit src/styles.css

# 2. Wait for webpack to finish (~1-2s)
sleep 2

# 3. Trigger ONE reload when ready
curl -s -X POST http://127.0.0.1:8643/reload \
  -H "Content-Type: application/json" \
  -d '{"controlName":"cc_Example.DevProxySample","trigger":"agent"}'

# 4. Verify success
curl -s http://127.0.0.1:8643/last-ack
# → {"status":"success","durationMs":62}
```

**Flow:** edit source(s) → webpack incremental rebuild (~200ms) → agent triggers reload → hot-reload (~60-80ms)

### Human mode (auto-reload on save)

Every save triggers an immediate reload — instant feedback for VS Code editing.

```bash
# Same as above but ADD --watch-bundle
npx pcf-dev-proxy \
  --control "cc_Example.DevProxySample" \
  --dir "example/DevProxySample/out/controls/DevProxySample" \
  --watch-bundle
```

**Flow:** save file → webpack rebuild (~200ms) → watch-bundle detects `bundle.js` change (500ms debounce) → auto-reload (~70ms). Total: **~700ms from save to UI update**.

## Babel `node_modules` Exclusion

`pcf-scripts` runs Babel on **all** `.js` files including `node_modules` with no `exclude` rule (as of v1.51.1). For controls with large dependencies (Fluent UI, ExcelJS) this is the biggest initial-build bottleneck.

**Fix** (only affects initial build; incremental rebuilds are already fast):

`featureconfig.json`:
```json
{
  "pcfAllowCustomWebpack": "on"
}
```

`webpack.config.js`:
```js
module.exports = {
  module: {
    rules: [
      {
        test: /\.(jsx?|mjsx?)$/,
        use: [require.resolve("babel-loader")],
        exclude: /node_modules/,
      },
    ],
  },
};
```

Benchmark from [hajekj.net](https://hajekj.net/2025/03/01/speeding-up-pcf-build/): 22s → 3.3s (85% reduction) on a 47-control repo.

### `targets` in `pcfconfig.json`

`pcf-scripts` v1.51.1 supports a `targets` field in `pcfconfig.json` passed to `@babel/preset-env`. Default is `{ "esmodules": true }`. Setting explicit modern targets reduces unnecessary transforms but doesn't eliminate the node_modules parsing overhead — the Babel exclusion above is still needed.

## esbuild (`pcfUseESBuild`) — Evaluate When Stable

`pcf-scripts` has an experimental `pcfUseESBuild` feature flag that replaces webpack entirely with esbuild.

**Status (as of v1.51.1, Dec 2025):** experimental, off by default.

**Known issues:**
- Requires manual `ComponentFramework.registerControl()` call — pcf-scripts doesn't inject it like webpack does
- No custom webpack config support (obviously — it bypasses webpack)
- "If it builds, doesn't mean it will work" — incomplete runtime registration
- esbuild-loader (hybrid approach) was tried in v1.18.4 and reverted in v1.21.4 due to invalid bundle issues

**When to revisit:** when `pcfUseESBuild` moves out of experimental/preview and handles control registration automatically. Track via `pcf-scripts` npm releases and [Microsoft PCF docs](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview).

**Potential impact:** esbuild is 10-100x faster than webpack+babel for bundling. For controls with 20MB+ dev bundles, initial build could drop from ~20s to <1s. Incremental rebuilds would also be faster, though webpack watch is already adequate (~200ms).

## References

- [Speeding up PCF build (Babel exclusion)](https://hajekj.net/2025/03/01/speeding-up-pcf-build/)
- [Speeding up PCF build with esbuild](https://hajekj.net/2025/10/05/speeding-up-pcf-build-with-esbuild/)
- [Custom webpack configurations](https://lavandensway.substack.com/p/advanced-webpack-techniques)
- [esbuild-loader tried & reverted](https://itmustbecode.com/the-pcf-control-framework-chooses-esbuild-loader-for-faster-build-time/)
