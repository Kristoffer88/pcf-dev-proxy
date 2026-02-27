#!/usr/bin/env bash
# E2E test: direct WebSocket reload via HMR control plane.
#
# Starts a control plane, connects a WS client, triggers a reload via HTTP,
# verifies the reload arrives over WS, sends ACK over WS, verifies ACK recorded.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PROXY_PID=""
pass=0
fail=0

cleanup() {
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo ""
  if [[ $fail -eq 0 && $pass -gt 0 ]]; then
    echo "All $pass assertions passed"
  elif [[ $fail -gt 0 ]]; then
    echo "$fail FAILED, $pass passed"
  fi
}
trap cleanup EXIT

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

cd "$ROOT"
echo "Building project..."
npm run build --silent 2>/dev/null

echo ""
echo "Direct WS reload test"

# Start a fresh control plane on a free port
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
check "control plane is running" "$PROXY_UP" "yes"

# Connect as a direct WS client and verify reload arrives over WS
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

echo ""
echo "Done."

[[ $fail -eq 0 ]]
