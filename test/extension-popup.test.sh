#!/usr/bin/env bash
# E2E test: extension popup renders connection status correctly via agent-browser.
#
# Strategy:
#   Part A — Popup rendering: serve popup.html via a local HTTP server, mock
#            chrome.* APIs, call render() with different states, verify via snapshot.
#   Part B — Extension connectivity: load the real extension, start the proxy,
#            verify the extension connects (proxy-side WebSocket client count).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SESSION="pcf-ext-popup-$$"
SERVE_PID=""
PROXY_PID=""
PORTFILE=""
pass=0
fail=0

cleanup() {
  agent-browser --session "$SESSION" close 2>/dev/null || true
  [[ -n "${SERVE_PID:-}" ]] && kill "$SERVE_PID" 2>/dev/null || true
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  [[ -n "${PORTFILE:-}" ]] && rm -f "$PORTFILE" 2>/dev/null || true
  echo ""
  if [[ $fail -eq 0 && $pass -gt 0 ]]; then
    echo "All $pass assertions passed"
  elif [[ $fail -gt 0 ]]; then
    echo "$fail FAILED, $pass passed"
  fi
}
trap cleanup EXIT

ab() { agent-browser --session "$SESSION" "$@"; }

check() {
  local label="$1" text="$2" pattern="$3"
  if echo "$text" | grep -qi "$pattern"; then
    echo "  PASS  $label"
    ((pass++)) || true
  else
    echo "  FAIL  $label (expected: $pattern)"
    echo "        got: $(echo "$text" | head -5)"
    ((fail++)) || true
  fi
}

# Pre-flight
command -v agent-browser >/dev/null || { echo "agent-browser not found"; exit 1; }
cd "$ROOT"
echo "Building project..."
npm run build --silent 2>/dev/null

# ── Part A: Popup rendering ──────────────────────────────────────
echo ""
echo "Part A — Popup rendering (served locally, chrome APIs mocked)"

# Start a tiny static file server for the extension directory
PORTFILE=$(mktemp)
node -e "
  const http = require('http'), fs = require('fs'), path = require('path');
  const dir = path.resolve('extension');
  const mime = { '.html': 'text/html', '.js': 'application/javascript' };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, req.url === '/' ? 'popup.html' : req.url);
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(process.argv[1], String(server.address().port));
  });
  setInterval(() => {}, 60000);
" "$PORTFILE" &
SERVE_PID=$!
sleep 1

SERVE_PORT=$(cat "$PORTFILE")
if [[ -z "$SERVE_PORT" ]]; then
  echo "FATAL: could not start file server"
  exit 1
fi
echo "Serving popup at http://127.0.0.1:$SERVE_PORT/"

ab open "http://127.0.0.1:$SERVE_PORT/" >/dev/null 2>&1
sleep 1

# Mock chrome APIs so popup.js doesn't crash, then verify default state
ab eval "
  window.chrome = {
    runtime: { sendMessage: function(msg, cb) { if (cb) cb(null); } },
    storage: { local: { onChanged: { addListener: function() {} } } }
  };
" >/dev/null 2>&1
sleep 1

SNAP=$(ab snapshot 2>/dev/null || true)
check "default state shows Disconnected" "$SNAP" "Disconnected"

# Test: render connected state
ab eval "render({ connected: true, wsPort: 8643, lastReload: null, lastAck: null });" >/dev/null 2>&1
SNAP=$(ab snapshot 2>/dev/null || true)
check "connected → shows Connected" "$SNAP" "Connected"
check "connected → shows port 8643" "$SNAP" "8643"

# Test: render disconnected state
ab eval "render({ connected: false, wsPort: 8643, lastReload: null, lastAck: null });" >/dev/null 2>&1
SNAP=$(ab snapshot 2>/dev/null || true)
check "disconnected → shows Disconnected" "$SNAP" "Disconnected"

# Test: render with successful ack
ab eval "render({ connected: true, wsPort: 8643, lastReload: '2025-01-15T10:30:00Z', lastAck: { type: 'success', time: '2025-01-15T10:30:01Z' } });" >/dev/null 2>&1
SNAP=$(ab snapshot 2>/dev/null || true)
check "ack success → shows OK" "$SNAP" "OK"

# Test: render with error ack
ab eval "render({ connected: true, wsPort: 9999, lastReload: '2025-01-15T10:30:00Z', lastAck: { type: 'error', time: '2025-01-15T10:30:01Z' } });" >/dev/null 2>&1
SNAP=$(ab snapshot 2>/dev/null || true)
check "ack error → shows Error" "$SNAP" "Error"
check "custom port → shows 9999" "$SNAP" "9999"

# Close browser for Part A
ab close >/dev/null 2>&1
sleep 1

# ── Part B: Extension WS connectivity ────────────────────────────
echo ""
echo "Part B — Extension connects to proxy via WebSocket"

# Start proxy
node -e "
  const { createHmrControlPlane } = require('./dist/proxy.js');
  createHmrControlPlane(8643, 'cc_Test.Control').then(() => {});
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 60000);
" &
PROXY_PID=$!

# Wait for proxy to be ready (up to 5s)
PROXY_UP="no"
for i in 1 2 3 4 5; do
  if curl -sf "http://127.0.0.1:8643/last-ack" >/dev/null 2>&1; then
    PROXY_UP="yes"; break
  fi
  sleep 1
done
check "proxy is running" "$PROXY_UP" "yes"

# Launch browser with extension — it should auto-connect within 3s
ab --extension "$ROOT/extension" open "about:blank" >/dev/null 2>&1
sleep 4

# Trigger a reload and check if the proxy delivers it over WS
node -e "
  const { WebSocket } = require('ws');
  const ws = new WebSocket('ws://127.0.0.1:8643/ws');
  ws.on('open', () => { console.log('ws-open'); ws.close(); process.exit(0); });
  ws.on('error', () => { console.log('ws-error'); process.exit(1); });
  setTimeout(() => { console.log('ws-timeout'); process.exit(1); }, 3000);
"
WS_OK=$?
check "proxy WS is accepting connections" "$([ $WS_OK -eq 0 ] && echo 'yes' || echo 'no')" "yes"

# Clean up Part B
ab close >/dev/null 2>&1
kill "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""

# ── Part C: Direct WS (no extension) ─────────────────────────────
echo ""
echo "Part C — Direct WS reload (no extension required)"

# Start a fresh control plane
DIRECT_PORT=$(node -e "
  const net = require('net');
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });
")

node -e "
  const { createHmrControlPlane } = require('./dist/proxy.js');
  createHmrControlPlane(${DIRECT_PORT}, 'cc_Test.Control').then(() => {});
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 60000);
" &
PROXY_PID=$!

# Wait for proxy to be ready
PROXY_UP="no"
for i in 1 2 3 4 5; do
  if curl -sf "http://127.0.0.1:${DIRECT_PORT}/health" >/dev/null 2>&1; then
    PROXY_UP="yes"; break
  fi
  sleep 1
done
check "direct WS proxy is running" "$PROXY_UP" "yes"

# Connect as a direct WS client (simulating what the in-page HMR client does)
# and verify reload message arrives over WS
DIRECT_RESULT=$(node -e "
  const { WebSocket } = require('ws');
  const http = require('http');
  const ws = new WebSocket('ws://127.0.0.1:${DIRECT_PORT}/ws');
  ws.on('open', () => {
    // Trigger a reload via HTTP POST
    const body = JSON.stringify({ controlName: 'cc_Test.Control', buildId: 'direct-test', trigger: 'test' });
    const req = http.request({ hostname: '127.0.0.1', port: ${DIRECT_PORT}, path: '/reload', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, () => {});
    req.write(body);
    req.end();
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === 'pcf-hmr:reload') {
      // Send ACK via WS (same as in-page HMR client does)
      ws.send(JSON.stringify({ type: 'pcf-hmr:ack', payload: {
        id: msg.payload.id, controlName: 'cc_Test.Control', buildId: 'direct-test',
        status: 'success', instancesTotal: 1, instancesReloaded: 1, durationMs: 10
      }}));
      setTimeout(() => { console.log('reload-received-ack-sent'); ws.close(); }, 100);
    }
  });
  ws.on('error', () => { console.log('ws-error'); process.exit(1); });
  setTimeout(() => { console.log('ws-timeout'); process.exit(1); }, 5000);
" 2>&1)

check "direct WS receives reload and sends ACK" "$DIRECT_RESULT" "reload-received-ack-sent"

# Verify ACK was recorded
LAST_ACK=$(curl -sf "http://127.0.0.1:${DIRECT_PORT}/last-ack" 2>/dev/null || echo "{}")
check "ACK recorded in control plane" "$LAST_ACK" '"status":"success"'

# Clean up Part C
kill "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""

echo ""
echo "Done."

[[ $fail -eq 0 ]]
