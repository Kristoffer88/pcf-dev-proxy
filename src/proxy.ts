#!/usr/bin/env node
/**
 * HTTPS MITM proxy that intercepts deployed PCF bundle requests and serves local files instead.
 *
 * Auto-detects the PCF control name from ControlManifest.Input.xml in the consuming repo.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { execSync, spawn } from "child_process";
import * as mockttp from "mockttp";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { HMR_CLIENT_SOURCE } from "./hmr-client";

// ---------------------------------------------------------------------------
// Auto-detect control name from ControlManifest.Input.xml
// ---------------------------------------------------------------------------

function findManifest(startDir: string): string | null {
	let dir = startDir;
	while (true) {
		const candidates = findManifestFiles(dir);
		if (candidates.length > 0) return candidates[0];

		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function findManifestFiles(dir: string): string[] {
	const results: string[] = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "out") continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...findManifestFiles(fullPath));
			} else if (entry.name === "ControlManifest.Input.xml") {
				results.push(fullPath);
			}
		}
	} catch {
		// permission errors, etc.
	}
	return results;
}

interface ControlInfo {
	namespace: string;
	constructor: string;
	controlName: string;
}

function parseManifest(manifestPath: string): ControlInfo | null {
	const xml = fs.readFileSync(manifestPath, "utf-8");
	const match = xml.match(/<control\s+[^>]*namespace="([^"]+)"[^>]*constructor="([^"]+)"/);
	if (!match) return null;
	return {
		namespace: match[1],
		constructor: match[2],
		controlName: `cc_${match[1]}.${match[2]}`,
	};
}

function detectControl(cwd: string): { controlName: string; constructor: string; manifestDir: string } | null {
	const manifest = findManifest(cwd);
	if (!manifest) return null;
	const info = parseManifest(manifest);
	if (!info) return null;
	return {
		controlName: info.controlName,
		constructor: info.constructor,
		manifestDir: path.dirname(manifest),
	};
}

// ---------------------------------------------------------------------------
// Resolve paths relative to consuming repo (cwd), NOT this package
// ---------------------------------------------------------------------------

const CWD = process.cwd();
const CACHE_DIR = path.join(CWD, ".cache");
const CA_CERT_PATH = path.join(CACHE_DIR, "proxy-ca.pem");
const CA_KEY_PATH = path.join(CACHE_DIR, "proxy-ca.key");
const CA_NAME = "PCF Dev Proxy CA";

type Browser = "chrome" | "edge";

interface ProxyOptions {
	port: number;
	wsPort: number;
	servingDir: string;
	controlName: string;
	browser: Browser;
	autoYes: boolean;
	hotMode: boolean;
	watchBundle: boolean;
}

interface ReloadRequest {
	controlName: string;
	buildId: string;
	trigger: string;
	changedFiles?: string[];
}

interface ReloadMessage extends ReloadRequest {
	id: string;
	timestamp: number;
}

interface ReloadAck {
	id: string;
	controlName: string;
	buildId: string;
	status: "success" | "partial" | "failed";
	instancesTotal: number;
	instancesReloaded: number;
	durationMs: number;
	error?: string;
	timestamp: number;
}

interface ControlQueueState {
	active: boolean;
	current: ReloadMessage | null;
	pending: ReloadMessage | null;
	timer: ReturnType<typeof setTimeout> | null;
}

interface HmrControlPlane {
	httpServer: http.Server;
	wss: WebSocketServer;
	enqueueReload: (request: ReloadRequest) => ReloadMessage;
	close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Browser data dir (isolated profile like HTTP Toolkit)
// ---------------------------------------------------------------------------

function getBrowserDataDir(): string {
	const dir = path.join(os.tmpdir(), "pcf-dev-proxy-browser");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// CA certificate
// ---------------------------------------------------------------------------

async function loadOrCreateCA() {
	if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH)) {
		return {
			cert: fs.readFileSync(CA_CERT_PATH, "utf-8"),
			key: fs.readFileSync(CA_KEY_PATH, "utf-8"),
		};
	}

	const ca = await mockttp.generateCACertificate({ subject: { commonName: CA_NAME } });

	fs.mkdirSync(CACHE_DIR, { recursive: true });
	fs.writeFileSync(CA_CERT_PATH, ca.cert);
	fs.writeFileSync(CA_KEY_PATH, ca.key, { mode: 0o600 });

	return ca;
}

function getSpkiFingerprint(certPem: string): string {
	const cert = new crypto.X509Certificate(certPem);
	const spki = cert.publicKey.export({ type: "spki", format: "der" });
	return crypto.createHash("sha256").update(spki).digest("base64");
}

// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------

function confirm(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(`${question} [Y/n] `, (answer: string) => {
			rl.close();
			resolve(!answer || answer.toLowerCase().startsWith("y"));
		});
	});
}

const EDGE_PATHS_WIN = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function detectBrowser(): Browser {
	try {
		if (process.platform === "win32") {
			const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId', { encoding: "utf-8", stdio: "pipe" });
			if (out.includes("MSEdgeHTM")) return "edge";
			if (out.includes("ChromeHTML")) return "chrome";
		} else if (process.platform === "darwin") {
			const out = execSync("defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null || true", { encoding: "utf-8", stdio: "pipe" });
			if (out.includes("com.microsoft.edgemac")) return "edge";
		}
	} catch {
		// Fall through to defaults
	}
	return "chrome";
}

function getBrowserBinary(browser: Browser): string {
	if (process.platform === "darwin") {
		const name = browser === "edge" ? "Microsoft Edge" : "Google Chrome";
		return `/Applications/${name}.app/Contents/MacOS/${name}`;
	}
	if (browser === "edge") {
		return EDGE_PATHS_WIN.find((p) => fs.existsSync(p)) || "msedge";
	}
	const chromePaths = [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	];
	return chromePaths.find((p) => fs.existsSync(p)) || "chrome";
}

function resolveExtensionPath(): string {
	const extensionPath = path.resolve(__dirname, "..", "extension");
	if (!fs.existsSync(path.join(extensionPath, "manifest.json"))) {
		throw new Error(`Hot mode requires extension files at ${extensionPath}`);
	}
	return extensionPath;
}

function isBrowserAlreadyRunning(dataDir: string): boolean {
	try {
		if (process.platform === "win32") {
			const out = execSync("tasklist /FO CSV /NH", { encoding: "utf-8", stdio: "pipe" });
			// On Windows we can't easily check args via tasklist; check the lock file instead.
			// Chrome holds a lock on <dataDir>/lockfile while running.
			const lockFile = path.join(dataDir, "lockfile");
			return fs.existsSync(lockFile);
		} else {
			// macOS / Linux: pgrep -f matches against full command line
			execSync(`pgrep -f "user-data-dir=${dataDir}"`, { encoding: "utf-8", stdio: "pipe" });
			return true; // pgrep exits 0 → match found
		}
	} catch {
		return false; // pgrep exits 1 → no match
	}
}

async function launchBrowserWithProxy(
	port: number,
	certPem: string,
	browser: Browser,
	autoYes = false,
	hotMode = false,
) {
	const label = browser === "edge" ? "Edge" : "Chrome";
	const spki = getSpkiFingerprint(certPem);
	const dataDir = getBrowserDataDir();
	const binary = getBrowserBinary(browser);

	if (isBrowserAlreadyRunning(dataDir)) {
		console.log(`${label} already running with proxy profile — skipping launch.`);
		return;
	}

	const browserArgs = [
		`--proxy-server=127.0.0.1:${port}`,
		`--ignore-certificate-errors-spki-list=${spki}`,
		`--user-data-dir=${dataDir}`,
	];

	// Extension is loaded manually by the user via chrome://extensions.
	// CLI --load-extension flags conflict with manually loaded extensions.

	const shouldLaunch = autoYes || await confirm(`Launch ${label} with proxy?`);
	if (!shouldLaunch) {
		console.log(`Skipping ${label} launch. Start manually with:\n  "${binary}" ${browserArgs.join(" ")}`);
		return;
	}

	const fullCmd = `"${binary}" ${browserArgs.join(" ")}`;

	try {
		if (process.platform === "win32") {
			const taskName = "PCFDevProxyBrowser";
			execSync(`schtasks /Create /TN "${taskName}" /TR "${fullCmd.replace(/"/g, '\\"')}" /SC ONCE /ST 00:00 /F /RL HIGHEST`, { stdio: "pipe" });
			execSync(`schtasks /Run /TN "${taskName}"`, { stdio: "pipe" });
			execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: "pipe" });
		} else {
			const child = spawn(binary, browserArgs, { detached: true, stdio: "ignore" });
			child.unref();
		}
		console.log(`Launched ${label} with proxy (isolated profile).`);
		if (hotMode) {
			console.log("Hot mode enabled: Chrome extension bridge loaded.");
		}
	} catch {
		console.log(`Could not launch ${label}. Start manually with:\n  ${fullCmd}`);
	}
}

// ---------------------------------------------------------------------------
// HMR control plane (local HTTP + WS)
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
	res.writeHead(statusCode, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
	res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	if (chunks.length === 0) return {};
	const raw = Buffer.concat(chunks).toString("utf-8").trim();
	if (!raw) return {};
	return JSON.parse(raw);
}

export function toReloadRequest(body: unknown, fallbackControlName: string): ReloadRequest {
	const payload = (body && typeof body === "object") ? (body as Record<string, unknown>) : {};
	const controlNameValue = typeof payload.controlName === "string" && payload.controlName.trim().length > 0
		? payload.controlName.trim()
		: fallbackControlName;
	const buildId = typeof payload.buildId === "string" && payload.buildId.trim().length > 0
		? payload.buildId.trim()
		: new Date().toISOString();
	const trigger = typeof payload.trigger === "string" && payload.trigger.trim().length > 0
		? payload.trigger.trim()
		: "manual";
	const changedFiles = Array.isArray(payload.changedFiles)
		? payload.changedFiles.filter((v): v is string => typeof v === "string")
		: undefined;

	return {
		controlName: controlNameValue,
		buildId,
		trigger,
		changedFiles,
	};
}

export function toReloadAck(body: unknown): ReloadAck {
	const payload = (body && typeof body === "object") ? (body as Record<string, unknown>) : {};
	const status = payload.status;
	if (status !== "success" && status !== "partial" && status !== "failed") {
		throw new Error("Invalid ACK status");
	}

	if (typeof payload.id !== "string" || typeof payload.controlName !== "string" || typeof payload.buildId !== "string") {
		throw new Error("ACK missing required fields");
	}

	const instancesTotal = typeof payload.instancesTotal === "number" ? payload.instancesTotal : 0;
	const instancesReloaded = typeof payload.instancesReloaded === "number" ? payload.instancesReloaded : 0;
	const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : 0;
	const error = typeof payload.error === "string" ? payload.error : undefined;

	return {
		id: payload.id,
		controlName: payload.controlName,
		buildId: payload.buildId,
		status,
		instancesTotal,
		instancesReloaded,
		durationMs,
		error,
		timestamp: Date.now(),
	};
}

function createTimeoutAck(current: ReloadMessage): ReloadAck {
	return {
		id: current.id,
		controlName: current.controlName,
		buildId: current.buildId,
		status: "failed",
		instancesTotal: 0,
		instancesReloaded: 0,
		durationMs: 15_000,
		error: "Timed out waiting for runtime ACK",
		timestamp: Date.now(),
	};
}

export function createHmrControlPlane(wsPort: number, fallbackControlName: string): Promise<HmrControlPlane> {
	const wss = new WebSocketServer({ noServer: true });
	const httpServer = http.createServer();
	const queues = new Map<string, ControlQueueState>();
	const lastAckByControl = new Map<string, ReloadAck>();
	let nextId = 1;

	function toAckMap(): Record<string, ReloadAck> {
		const output: Record<string, ReloadAck> = {};
		for (const [key, value] of lastAckByControl.entries()) {
			output[key] = value;
		}
		return output;
	}

	function getQueue(controlName: string): ControlQueueState {
		const existing = queues.get(controlName);
		if (existing) return existing;
		const created: ControlQueueState = { active: false, current: null, pending: null, timer: null };
		queues.set(controlName, created);
		return created;
	}

	function broadcastReload(message: ReloadMessage): void {
		const event = JSON.stringify({ type: "pcf-hmr:reload", payload: message });
		let sent = 0;
		wss.clients.forEach((client) => {
			if (client.readyState === WsWebSocket.OPEN) {
				client.send(event);
				sent++;
			}
		});
		console.log(`  [HMR] Dispatch ${message.id} (${message.controlName}, trigger=${message.trigger}) -> ${sent} client(s)`);
	}

	function processQueue(controlName: string): void {
		const queue = getQueue(controlName);
		if (queue.active || !queue.pending) return;
		const current = queue.pending;
		queue.pending = null;
		queue.active = true;
		queue.current = current;

		broadcastReload(current);

		if (queue.timer) clearTimeout(queue.timer);
		queue.timer = setTimeout(() => {
			if (!queue.current || queue.current.id !== current.id) return;
			const timeoutAck = createTimeoutAck(current);
			lastAckByControl.set(controlName, timeoutAck);
			queue.active = false;
			queue.current = null;
			queue.timer = null;
			console.warn(`  [HMR] ${current.id} timed out waiting for ACK`);
			processQueue(controlName);
		}, 15_000);
	}

	function enqueueReload(request: ReloadRequest): ReloadMessage {
		const controlName = request.controlName || fallbackControlName;
		const message: ReloadMessage = {
			id: `r-${Date.now()}-${nextId++}`,
			controlName,
			buildId: request.buildId,
			trigger: request.trigger,
			changedFiles: request.changedFiles,
			timestamp: Date.now(),
		};
		const queue = getQueue(controlName);
		queue.pending = message;
		processQueue(controlName);
		return message;
	}

	function completeAck(ack: ReloadAck): void {
		lastAckByControl.set(ack.controlName, ack);
		const queue = getQueue(ack.controlName);
		if (!queue.active || !queue.current) return;
		if (queue.current.id !== ack.id) {
			console.warn(`  [HMR] Ignoring stale ACK ${ack.id}; waiting for ${queue.current.id}`);
			return;
		}

		if (queue.timer) clearTimeout(queue.timer);
		queue.timer = null;
		queue.active = false;
		queue.current = null;

		console.log(`  [HMR] ACK ${ack.id}: ${ack.status} (${ack.instancesReloaded}/${ack.instancesTotal}) in ${ack.durationMs}ms`);
		processQueue(ack.controlName);
	}

	httpServer.on("request", async (req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (!req.url || !req.method) {
			sendJson(res, 400, { error: "Bad request" });
			return;
		}

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.method === "GET" && req.url === "/health") {
			sendJson(res, 200, { status: "ok", type: "pcf-dev-proxy-hmr" });
			return;
		}

		if (req.method === "GET" && req.url === "/last-ack") {
			sendJson(res, 200, toAckMap());
			return;
		}

		if (req.method === "GET" && req.url === "/runtime.js") {
			res.writeHead(200, {
				"Content-Type": "application/javascript; charset=utf-8",
				"Cache-Control": "no-cache, no-store, must-revalidate",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(`${HMR_CLIENT_SOURCE}\n`);
			return;
		}

		if (req.method === "POST" && req.url === "/reload") {
			try {
				const body = await readJsonBody(req);
				const request = toReloadRequest(body, fallbackControlName);
				const message = enqueueReload(request);
				sendJson(res, 200, { accepted: true, id: message.id });
			} catch (err) {
				sendJson(res, 400, { error: `Invalid reload payload: ${(err as Error).message}` });
			}
			return;
		}

		if (req.method === "POST" && req.url === "/ack") {
			try {
				const body = await readJsonBody(req);
				const ack = toReloadAck(body);
				completeAck(ack);
				sendJson(res, 200, { ok: true });
			} catch (err) {
				sendJson(res, 400, { error: `Invalid ACK payload: ${(err as Error).message}` });
			}
			return;
		}

		sendJson(res, 404, { error: "Not found" });
	});

	httpServer.on("upgrade", (req, socket, head) => {
		const requestUrl = req.url || "/";
		if (requestUrl !== "/ws") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
	});

	wss.on("connection", (ws) => {
		console.log(`  [HMR] Client connected (${wss.clients.size} total)`);

		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(String(data));
				if (msg.type === "pcf-hmr:ack" && msg.payload) {
					const ack = toReloadAck(msg.payload);
					completeAck(ack);
				}
			} catch {
				// Ignore malformed messages
			}
		});
	});

	return new Promise((resolve, reject) => {
		const onError = (err: Error) => {
			httpServer.off("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			httpServer.off("error", onError);
			console.log(`  [HMR] Control plane on http://127.0.0.1:${wsPort}`);
			console.log(`  [HMR] WS endpoint: ws://127.0.0.1:${wsPort}/ws`);
			resolve({
				httpServer,
				wss,
				enqueueReload,
				close: async () => {
					for (const queue of queues.values()) {
						if (queue.timer) clearTimeout(queue.timer);
					}
					await new Promise<void>((done) => wss.close(() => done()));
					await new Promise<void>((done) => httpServer.close(() => done()));
				},
			});
		};

		httpServer.once("error", onError);
		httpServer.once("listening", onListening);
		httpServer.listen(wsPort, "127.0.0.1");
	});
}

function watchBundleAndEnqueue(
	servingDir: string,
	controlName: string,
	enqueueReload: (request: ReloadRequest) => ReloadMessage,
): fs.FSWatcher {
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	const target = path.join(servingDir, "bundle.js");
	console.log(`  [HMR] Watching ${target} for changes`);
	const watcher = fs.watch(servingDir, { recursive: false }, (_eventType, filename) => {
		if (String(filename) !== "bundle.js") return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			enqueueReload({
				controlName,
				buildId: new Date().toISOString(),
				trigger: "watch-bundle",
			});
		}, 500);
	});
	return watcher;
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

async function startProxy(options: ProxyOptions): Promise<void> {
	const interceptRe = new RegExp(`${options.controlName.replace(".", "\\.")}\/([^?]+)`);

	if (!fs.existsSync(options.servingDir)) {
		console.error(`Serving directory does not exist: ${options.servingDir}\nRun your build command first.`);
		process.exit(1);
	}

	const ca = await loadOrCreateCA();
	const server = mockttp.getLocal({
		https: { key: ca.key, cert: ca.cert },
	});

	try {
		await server.start(options.port);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "EADDRINUSE") {
			console.error(`ERROR: Port ${options.port} is already in use. Kill the existing proxy first:\n  lsof -ti:${options.port} | xargs kill`);
		} else {
			console.error(`ERROR: Could not start proxy: ${e.message}`);
		}
		process.exit(1);
	}

	await server
		.forAnyRequest()
		.matching((req) => interceptRe.test(req.url))
		.thenCallback((req) => {
			const filename = req.url.match(interceptRe)?.[1];
			if (!filename) return { statusCode: 404, body: "No match" };
			const filePath = path.join(options.servingDir, filename);
			if (!path.resolve(filePath).startsWith(path.resolve(options.servingDir) + path.sep)) {
				console.log(`  403  ${filename} (path traversal blocked)`);
				return { statusCode: 403, body: "Forbidden" };
			}

			if (!fs.existsSync(filePath)) {
				console.log(`  404  ${filename} (not found in ${options.servingDir})`);
				return { statusCode: 404, body: `File not found: ${filename}` };
			}

			let body = fs.readFileSync(filePath);
			if (options.hotMode && filename === "bundle.js") {
				// Inject WS port + HMR client before bundle so registerControl is patched before bundle executes.
				const portDecl = `var __pcfHmrWsPort = ${options.wsPort};\n`;
				body = Buffer.concat([Buffer.from(portDecl), Buffer.from(`${HMR_CLIENT_SOURCE}\n`), body]);
			}
			if (filename.endsWith(".js") && fs.existsSync(filePath + ".map")) {
				body = Buffer.concat([body, Buffer.from(`\n//# sourceMappingURL=${filename}.map\n`)]);
			}

			const kb = Math.round(body.length / 1024);
			console.log(`  200  ${filename} (${kb} KB)${options.hotMode && filename === "bundle.js" ? " [+HMR]" : ""}`);

			return {
				statusCode: 200,
				headers: {
					"content-type": filename.endsWith(".map") ? "application/json" : "application/javascript",
					"cache-control": "no-cache, no-store, must-revalidate",
					"access-control-allow-origin": "*",
				},
				rawBody: body,
			};
		});

	await server.forUnmatchedRequest().thenPassThrough(options.hotMode ? {
		beforeResponse: (response) => {
			const headers = { ...response.headers };
			delete headers["content-security-policy"];
			delete headers["content-security-policy-report-only"];
			return { headers };
		},
	} : undefined);

	const _consoleError = console.error;
	console.error = (...args: unknown[]) => {
		if (typeof args[0] === "string" && args[0].startsWith("Failed to handle request")) return;
		_consoleError(...args);
	};

	let controlPlane: HmrControlPlane | null = null;
	let watcher: fs.FSWatcher | null = null;

	if (options.hotMode) {
		try {
			controlPlane = await createHmrControlPlane(options.wsPort, options.controlName);
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code === "EADDRINUSE") {
				console.error(`HMR ws-port ${options.wsPort} is already in use. Use --ws-port to choose another port.`);
			} else {
				console.error(`Could not start HMR control plane: ${e.message}`);
			}
			await server.stop();
			process.exit(1);
		}

		if (options.watchBundle && controlPlane) {
			watcher = watchBundleAndEnqueue(options.servingDir, options.controlName, controlPlane.enqueueReload);
		}
	}

	await launchBrowserWithProxy(options.port, ca.cert, options.browser, options.autoYes, options.hotMode);

	let shuttingDown = false;
	async function shutdown() {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log("\nShutting down proxy...");
		if (watcher) watcher.close();
		if (controlPlane) await controlPlane.close();
		await server.stop();
		process.exit(0);
	}

	process.on("exit", () => { console.error = _consoleError; });
	process.on("SIGINT", () => { shutdown(); });
	process.on("SIGTERM", () => { shutdown(); });

	console.log(`\nPCF Dev Proxy running on port ${options.port}`);
	console.log(`Intercepting: ${options.controlName}/*`);
	console.log(`Serving from: ${options.servingDir}`);
	if (options.hotMode) {
		console.log(`Hot mode: ON (control plane http://127.0.0.1:${options.wsPort})`);
		console.log(`Hot fallback watcher: ${options.watchBundle ? "ON" : "OFF"}`);
	} else {
		console.log("Hot mode: OFF");
	}
	console.log();
}

// ---------------------------------------------------------------------------
// Reload command
// ---------------------------------------------------------------------------

export function parsePort(value: string, label: string): number {
	const parsed = parseInt(value, 10);
	if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return parsed;
}

function requestJson(method: "POST" | "GET", port: number, pathname: string, payload?: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const body = payload === undefined ? "" : JSON.stringify(payload);
		const req = http.request({
			hostname: "127.0.0.1",
			port,
			path: pathname,
			method,
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
			},
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8").trim();
				const parsed = raw ? JSON.parse(raw) : {};
				if ((res.statusCode || 500) >= 400) {
					reject(new Error(`HTTP ${res.statusCode}: ${raw || "request failed"}`));
					return;
				}
				resolve(parsed);
			});
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

export async function runReloadCommand(args: string[]): Promise<void> {
	let wsPort = 8643;
	let controlName: string | null = null;
	let buildId = new Date().toISOString();
	let trigger = "manual";
	let changedFiles: string[] | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--ws-port" && args[i + 1]) {
			wsPort = parsePort(args[++i], "ws-port");
		} else if (args[i] === "--control" && args[i + 1]) {
			controlName = args[++i];
		} else if (args[i] === "--build-id" && args[i + 1]) {
			buildId = args[++i];
		} else if (args[i] === "--trigger" && args[i + 1]) {
			trigger = args[++i];
		} else if (args[i] === "--changed-files" && args[i + 1]) {
			changedFiles = args[++i].split(",").map((v) => v.trim()).filter(Boolean);
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log(`Usage: pcf-dev-proxy reload --control <name> [options]

Options:
  --ws-port <number>      HMR control plane port (default: 8643)
  --control <name>        Control name (e.g. cc_Contoso.MyControl)
  --build-id <id>         Build identifier (default: ISO timestamp)
  --trigger <source>      Trigger label (default: manual)
  --changed-files <list>  Comma-separated changed files\n`);
			return;
		}
	}

	if (!controlName) {
		throw new Error("reload command requires --control <name>");
	}

	const payload: ReloadRequest = {
		controlName,
		buildId,
		trigger,
		changedFiles,
	};

	const response = await requestJson("POST", wsPort, "/reload", payload) as { accepted?: boolean; id?: string };
	if (!response.accepted || !response.id) {
		throw new Error("Reload request rejected");
	}
	console.log(`Queued reload ${response.id} for ${controlName}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp(detectedBrowser: Browser, detectedControl: { controlName: string; constructor: string; manifestDir: string } | null): void {
	console.log(`PCF Dev Proxy - HTTPS MITM proxy for local PCF development

Usage:
  pcf-dev-proxy [options]
  pcf-dev-proxy reload --control <name> [options]

Options:
  --port <number>         Proxy port (default: 8642)
  --ws-port <number>      HMR control plane port (default: 8643)
  --dir <path>            Directory to serve files from (auto-detected from manifest)
  --control <name>        Override control name (e.g. cc_Projectum.PowerRoadmap)
  --browser <name>        Browser to use: chrome, edge (default: auto-detect)
  --hot                   Enable hot-reload mode (Chrome only)
  --watch-bundle          Watch bundle.js and emit reload (only with --hot)
  -y, --yes               Skip browser launch prompt
  -h, --help              Show this help

Reload subcommand:
  pcf-dev-proxy reload --control <name> [--ws-port <number>] [--build-id <id>] [--trigger <source>]

Auto-detected: ${detectedControl ? `${detectedControl.controlName} (from ${detectedControl.manifestDir})` : "no manifest found"}
Browser: ${detectedBrowser}`);
}

function resolveControlAndServingDir(controlOverride: string | null, dirOverride: string | null): { controlName: string; servingDir: string } {
	let controlName: string;
	let constructorName: string;

	if (controlOverride) {
		controlName = controlOverride;
		const ctorMatch = controlOverride.match(/\.(\w+)$/);
		constructorName = ctorMatch ? ctorMatch[1] : "";
	} else {
		const detected = detectControl(CWD);
		if (!detected) {
			throw new Error("Could not find ControlManifest.Input.xml. Use --control to specify the control name manually.");
		}
		controlName = detected.controlName;
		constructorName = detected.constructor;
		console.log(`Auto-detected control: ${controlName}`);
	}

	let servingDir: string;
	if (dirOverride) {
		servingDir = dirOverride;
	} else {
		const defaultDir = path.join(CWD, "out/controls", constructorName);
		if (fs.existsSync(defaultDir)) {
			servingDir = defaultDir;
		} else {
			const controlsDir = path.join(CWD, "out/controls");
			const dirs = fs.existsSync(controlsDir)
				? fs.readdirSync(controlsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
				: [];
			if (dirs.length === 1) {
				servingDir = path.join(controlsDir, dirs[0]);
			} else {
				servingDir = defaultDir;
			}
		}
	}

	return { controlName, servingDir };
}

export async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "reload") {
		await runReloadCommand(args.slice(1));
		return;
	}

	let port = 8642;
	let wsPort = 8643;
	let dirOverride: string | null = null;
	let controlOverride: string | null = null;
	let browserOverride: Browser | null = null;
	let skipPrompt = false;
	let hotMode = false;
	let watchBundle = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = parsePort(args[++i], "port");
		} else if (args[i] === "--ws-port" && args[i + 1]) {
			wsPort = parsePort(args[++i], "ws-port");
		} else if (args[i] === "--dir" && args[i + 1]) {
			dirOverride = args[++i];
		} else if (args[i] === "--control" && args[i + 1]) {
			controlOverride = args[++i];
		} else if (args[i] === "--browser" && args[i + 1]) {
			const b = args[++i].toLowerCase();
			if (b !== "chrome" && b !== "edge") {
				throw new Error(`Unknown browser: ${b}. Use "chrome" or "edge".`);
			}
			browserOverride = b;
		} else if (args[i] === "--hot") {
			hotMode = true;
		} else if (args[i] === "--watch-bundle") {
			watchBundle = true;
		} else if (args[i] === "--yes" || args[i] === "-y") {
			skipPrompt = true;
		} else if (args[i] === "--help" || args[i] === "-h") {
			const detected = detectControl(CWD);
			printHelp(browserOverride || detectBrowser(), detected);
			return;
		}
	}

	if (watchBundle && !hotMode) {
		throw new Error("--watch-bundle can only be used with --hot");
	}

	const browser = browserOverride || detectBrowser();
	if (hotMode && browser !== "chrome") {
		throw new Error("Hot mode currently supports Chrome only. Use --browser chrome.");
	}

	const resolved = resolveControlAndServingDir(controlOverride, dirOverride);

	await startProxy({
		port,
		wsPort,
		servingDir: resolved.servingDir,
		controlName: resolved.controlName,
		browser,
		autoYes: skipPrompt,
		hotMode,
		watchBundle,
	});
}

if (require.main === module) {
	main().catch((err) => {
		console.error((err as Error).message);
		process.exit(1);
	});
}
