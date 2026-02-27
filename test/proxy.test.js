const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { WebSocket } = require("ws");

const {
  createHmrControlPlane,
  toReloadRequest,
  toReloadAck,
} = require("../dist/proxy.js");

const { HMR_CLIENT_SOURCE } = require("../dist/hmr-client.js");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not resolve port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpJson(method, port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const parsed = raw ? JSON.parse(raw) : {};
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("toReloadRequest applies fallback defaults", () => {
  const req = toReloadRequest({ trigger: "pcf-start" }, "cc_Test.Control");
  assert.equal(req.controlName, "cc_Test.Control");
  assert.equal(req.trigger, "pcf-start");
  assert.ok(typeof req.buildId === "string");
});

test("toReloadAck validates status", () => {
  assert.throws(() => toReloadAck({ id: "x", controlName: "c", buildId: "b", status: "nope" }), /Invalid ACK status/);

  const ack = toReloadAck({
    id: "r-1",
    controlName: "cc_Test.Control",
    buildId: "b1",
    status: "success",
    instancesTotal: 1,
    instancesReloaded: 1,
    durationMs: 5,
  });
  assert.equal(ack.status, "success");
  assert.equal(ack.instancesReloaded, 1);
});

test("queue coalesces to latest reload per control", async () => {
  const port = await getFreePort();
  const plane = await createHmrControlPlane(port, "cc_Test.Control");

  try {
    const received = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    ws.on("message", (data) => {
      received.push(JSON.parse(String(data)));
    });

    const first = plane.enqueueReload({
      controlName: "cc_Test.Control",
      buildId: "b1",
      trigger: "test",
    });
    const second = plane.enqueueReload({
      controlName: "cc_Test.Control",
      buildId: "b2",
      trigger: "test",
    });

    await wait(120);
    assert.equal(received.length, 1);
    assert.equal(received[0].payload.id, first.id);

    await httpJson("POST", port, "/ack", {
      id: first.id,
      controlName: "cc_Test.Control",
      buildId: "b1",
      status: "success",
      instancesTotal: 1,
      instancesReloaded: 1,
      durationMs: 10,
    });

    await wait(120);
    assert.equal(received.length, 2);
    assert.equal(received[1].payload.id, second.id);

    ws.close();
  } finally {
    await plane.close();
  }
});

test("ack endpoint stores latest status", async () => {
  const port = await getFreePort();
  const plane = await createHmrControlPlane(port, "cc_Test.Control");

  try {
    await httpJson("POST", port, "/ack", {
      id: "r-200",
      controlName: "cc_Test.Control",
      buildId: "b200",
      status: "failed",
      instancesTotal: 0,
      instancesReloaded: 0,
      durationMs: 30,
      error: "boom",
    });

    const map = await httpJson("GET", port, "/last-ack");
    assert.equal(map["cc_Test.Control"].id, "r-200");
    assert.equal(map["cc_Test.Control"].status, "failed");
  } finally {
    await plane.close();
  }
});

// --- Direct WS / CSP stripping tests ---

test("HMR_CLIENT_SOURCE contains direct WS connection code", () => {
  assert.ok(HMR_CLIENT_SOURCE.includes("__pcfHmrWsPort"), "should reference __pcfHmrWsPort");
  assert.ok(HMR_CLIENT_SOURCE.includes("connectWs"), "should define connectWs");
  assert.ok(HMR_CLIENT_SOURCE.includes('ws://127.0.0.1:'), "should connect to ws://127.0.0.1");
  assert.ok(HMR_CLIENT_SOURCE.includes("pcf-hmr:ack"), "should send ACK over WS");
});

test("direct WS client receives reload via WS and ACKs via WS", async () => {
  const port = await getFreePort();
  const plane = await createHmrControlPlane(port, "cc_Test.Control");

  try {
    // Simulate the in-page direct WS client
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received = [];
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.on("message", (data) => received.push(JSON.parse(String(data))));

    // Trigger a reload
    const msg = plane.enqueueReload({
      controlName: "cc_Test.Control",
      buildId: "direct-b1",
      trigger: "test-direct",
    });

    await wait(120);
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "pcf-hmr:reload");
    assert.equal(received[0].payload.id, msg.id);

    // ACK via WS message (same as the in-page HMR client does)
    ws.send(JSON.stringify({
      type: "pcf-hmr:ack",
      payload: {
        id: msg.id,
        controlName: "cc_Test.Control",
        buildId: "direct-b1",
        status: "success",
        instancesTotal: 1,
        instancesReloaded: 1,
        durationMs: 42,
      },
    }));

    await wait(120);
    const map = await httpJson("GET", port, "/last-ack");
    assert.equal(map["cc_Test.Control"].id, msg.id);
    assert.equal(map["cc_Test.Control"].status, "success");

    ws.close();
  } finally {
    await plane.close();
  }
});

test("port injection: __pcfHmrWsPort var is prepended to bundle in hot mode", () => {
  // Verify the proxy source injects __pcfHmrWsPort before HMR_CLIENT_SOURCE
  const proxySource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "dist", "proxy.js"),
    "utf-8"
  );
  assert.ok(proxySource.includes("__pcfHmrWsPort"), "proxy should inject __pcfHmrWsPort variable");
  assert.ok(proxySource.includes("content-security-policy"), "proxy should reference CSP headers for stripping");
});
