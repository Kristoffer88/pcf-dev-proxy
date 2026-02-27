#!/usr/bin/env node
/**
 * HTTPS MITM proxy that intercepts deployed PCF bundle requests and serves local files instead.
 *
 * Auto-detects the PCF control name from ControlManifest.Input.xml in the consuming repo.
 *
 * Usage:
 *   npx pcf-dev-proxy                      # Start proxy (auto-detect control from manifest)
 *   npx pcf-dev-proxy --port 9000          # Custom port
 *   npx pcf-dev-proxy --control cc_Ns.Ctl  # Override control name
 *   npx pcf-dev-proxy --browser edge       # Use Edge instead of Chrome
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
	// Chrome on Windows — check common paths
	const chromePaths = [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	];
	return chromePaths.find((p) => fs.existsSync(p)) || "chrome";
}

async function launchBrowserWithProxy(port: number, certPem: string, browser: Browser, autoYes = false) {
	const label = browser === "edge" ? "Edge" : "Chrome";
	const spki = getSpkiFingerprint(certPem);
	const dataDir = getBrowserDataDir();
	const binary = getBrowserBinary(browser);

	const browserArgs = [
		`--proxy-server=127.0.0.1:${port}`,
		`--ignore-certificate-errors-spki-list=${spki}`,
		`--user-data-dir=${dataDir}`,
	];

	const shouldLaunch = autoYes || await confirm(`Launch ${label} with proxy?`);
	if (!shouldLaunch) {
		console.log(`Skipping ${label} launch. Start manually with:\n  "${binary}" ${browserArgs.join(" ")}`);
		return;
	}

	const fullCmd = `"${binary}" ${browserArgs.join(" ")}`;

	try {
		if (process.platform === "win32") {
			// Use schtasks to launch in the interactive desktop session (not Session 0)
			const taskName = "PCFDevProxyBrowser";
			execSync(`schtasks /Create /TN "${taskName}" /TR "${fullCmd.replace(/"/g, '\\"')}" /SC ONCE /ST 00:00 /F /RL HIGHEST`, { stdio: "pipe" });
			execSync(`schtasks /Run /TN "${taskName}"`, { stdio: "pipe" });
			execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: "pipe" });
		} else {
			const child = spawn(binary, browserArgs, { detached: true, stdio: "ignore" });
			child.unref();
		}
		console.log(`Launched ${label} with proxy (isolated profile).`);
	} catch (err) {
		console.log(`Could not launch ${label}. Start manually with:\n  ${fullCmd}`);
	}
}

// ---------------------------------------------------------------------------
// HMR: WebSocket server + file watcher
// ---------------------------------------------------------------------------

interface HmrServer {
	wss: InstanceType<typeof WebSocketServer>;
	httpServer: http.Server;
}

function broadcastReload(wss: InstanceType<typeof WebSocketServer>, controlName: string) {
	const message = JSON.stringify({
		type: "pcf-reload",
		controlName,
		timestamp: Date.now(),
	});
	let sent = 0;
	wss.clients.forEach((client) => {
		if (client.readyState === WsWebSocket.OPEN) {
			client.send(message);
			sent++;
		}
	});
	console.log(`  [HMR] bundle.js changed — notified ${sent} client(s)`);
}

async function startHmrServer(wsPort: number, controlName: string): Promise<HmrServer> {
	const wss = new WebSocketServer({ noServer: true });

	const httpServer = http.createServer((req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.method === "GET" && (req.url === "/" || req.url === "")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok", type: "pcf-dev-proxy-hmr" }));
			return;
		}

		if (req.method === "POST" && req.url === "/reload") {
			broadcastReload(wss, controlName);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, clients: wss.clients.size }));
			return;
		}

		res.writeHead(404);
		res.end();
	});

	httpServer.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
	});

	wss.on("connection", () => {
		console.log("  [HMR] Browser client connected");
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				reject(new Error(`Port ${wsPort} is already in use. Use --ws-port to specify a different HMR port.`));
			} else {
				reject(err);
			}
		});
		httpServer.listen(wsPort, "127.0.0.1", () => resolve());
	});

	console.log(`  [HMR] WebSocket server on ws://127.0.0.1:${wsPort}`);
	console.log(`  [HMR] Trigger reload: curl -X POST http://127.0.0.1:${wsPort}/reload`);

	return { wss, httpServer };
}

function watchBundleAndBroadcast(
	wss: InstanceType<typeof WebSocketServer>,
	servingDir: string,
	controlName: string,
): fs.FSWatcher {
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const watcher = fs.watch(servingDir, { recursive: false }, (_eventType, filename) => {
		if (filename !== null && filename !== "bundle.js") return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => broadcastReload(wss, controlName), 300);
	});

	console.log(`  [HMR] Watching ${path.join(servingDir, "bundle.js")} for changes`);
	return watcher;
}

function getHmrSnippet(wsPort: number): string {
	return HMR_CLIENT_SOURCE.replace(/__WS_PORT__/g, String(wsPort));
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

async function startProxy(port: number, servingDir: string, controlName: string, browser: Browser, autoYes = false, wsPort?: number) {
	const interceptRe = new RegExp(`${controlName.replace(".", "\\.")}\/([^?]+)`);
	const effectiveWsPort = wsPort ?? port + 1;
	const hmrSnippet = getHmrSnippet(effectiveWsPort);

	if (!fs.existsSync(servingDir)) {
		console.error(`Serving directory does not exist: ${servingDir}\nRun your build command first.`);
		process.exit(1);
	}

	const ca = await loadOrCreateCA();

	const server = mockttp.getLocal({
		https: { key: ca.key, cert: ca.cert },
	});

	await server.start(port);

	await server
		.forAnyRequest()
		.matching((req) => interceptRe.test(req.url))
		.thenCallback((req) => {
			const filename = req.url.match(interceptRe)?.[1];
			if (!filename) return { statusCode: 404, body: "No match" };
			const filePath = path.join(servingDir, filename);
			if (!path.resolve(filePath).startsWith(path.resolve(servingDir) + path.sep)) {
				console.log(`  403  ${filename} (path traversal blocked)`);
				return { statusCode: 403, body: "Forbidden" };
			}

			if (!fs.existsSync(filePath)) {
				console.log(`  404  ${filename} (not found in ${servingDir})`);
				return { statusCode: 404, body: `File not found: ${filename}` };
			}

			let body = fs.readFileSync(filePath);
			if (filename.endsWith(".js") && fs.existsSync(filePath + ".map")) {
				body = Buffer.concat([body, Buffer.from(`\n//# sourceMappingURL=${filename}.map\n`)]);
			}

			// Inject HMR client into bundle.js
			if (filename === "bundle.js") {
				body = Buffer.concat([body, Buffer.from(`\n${hmrSnippet}\n`)]);
			}

			const kb = Math.round(body.length / 1024);
			console.log(`  200  ${filename} (${kb} KB)${filename === "bundle.js" ? " [+HMR]" : ""}`);

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

	await server.forUnmatchedRequest().thenPassThrough();

	// Suppress mockttp's noisy passthrough errors
	const _consoleError = console.error;
	console.error = (...args: unknown[]) => {
		if (typeof args[0] === "string" && args[0].startsWith("Failed to handle request")) return;
		_consoleError(...args);
	};

	// Start HMR WebSocket server + file watcher
	const hmr = await startHmrServer(effectiveWsPort, controlName);
	const watcher = watchBundleAndBroadcast(hmr.wss, servingDir, controlName);

	await launchBrowserWithProxy(port, ca.cert, browser, autoYes);

	async function shutdown() {
		console.log("\nShutting down proxy...");
		watcher.close();
		for (const client of hmr.wss.clients) {
			client.terminate();
		}
		await new Promise<void>((resolve) => hmr.wss.close(() => resolve()));
		await new Promise<void>((resolve) => hmr.httpServer.close(() => resolve()));
		await server.stop();
		process.exit(0);
	}

	process.on("exit", () => { console.error = _consoleError; });
	process.on("SIGINT", () => { shutdown(); });
	process.on("SIGTERM", () => { shutdown(); });

	console.log(`\nPCF Dev Proxy running on port ${port}`);
	console.log(`Intercepting: ${controlName}/*`);
	console.log(`Serving from: ${servingDir}`);
	console.log(`Hot reload: ws://127.0.0.1:${effectiveWsPort}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let port = 8642;
let wsPortOverride: number | undefined;
let dirOverride: string | null = null;
let controlOverride: string | null = null;
let browserOverride: Browser | null = null;
let skipPrompt = false;

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) {
		const portArg = args[++i];
		port = parseInt(portArg, 10);
		if (isNaN(port) || port < 1 || port > 65535) { console.error(`Invalid port: ${portArg}`); process.exit(1); }
	}
	else if (args[i] === "--ws-port" && args[i + 1]) {
		wsPortOverride = parseInt(args[++i], 10);
		if (isNaN(wsPortOverride) || wsPortOverride < 1 || wsPortOverride > 65535) { console.error(`Invalid ws-port`); process.exit(1); }
	}
	else if (args[i] === "--dir" && args[i + 1]) { dirOverride = args[++i]; }
	else if (args[i] === "--control" && args[i + 1]) { controlOverride = args[++i]; }
	else if (args[i] === "--browser" && args[i + 1]) {
		const b = args[++i].toLowerCase();
		if (b !== "chrome" && b !== "edge") { console.error(`Unknown browser: ${b}. Use "chrome" or "edge".`); process.exit(1); }
		browserOverride = b;
	}
	else if (args[i] === "--yes" || args[i] === "-y") { skipPrompt = true; }
	else if (args[i] === "--help" || args[i] === "-h") {
		const detected = detectControl(CWD);
		console.log(`PCF Dev Proxy - HTTPS MITM proxy for local PCF development

Usage: pcf-dev-proxy [options]

Options:
  --port <number>       Proxy port (default: 8642)
  --ws-port <number>    HMR WebSocket port (default: proxy port + 1)
  --dir <path>          Directory to serve files from (auto-detected from manifest)
  --control <name>      Override control name (e.g. cc_Projectum.PowerRoadmap)
  --browser <name>      Browser to use: chrome, edge (default: auto-detect)
  -h, --help            Show this help

Auto-detected: ${detected ? `${detected.controlName} (from ${detected.manifestDir})` : "no manifest found"}
Browser: ${browserOverride || detectBrowser()}`);
		process.exit(0);
	}
}

// Resolve control name and serving directory
let controlName: string;
let constructorName: string;

if (controlOverride) {
	controlName = controlOverride;
	const ctorMatch = controlOverride.match(/\.(\w+)$/);
	constructorName = ctorMatch ? ctorMatch[1] : "";
} else {
	const detected = detectControl(CWD);
	if (!detected) {
		console.error("Could not find ControlManifest.Input.xml. Use --control to specify the control name manually.");
		process.exit(1);
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
		// Fallback: if only one folder in out/controls/, use it
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
const browser = browserOverride || detectBrowser();

startProxy(port, servingDir, controlName, browser, skipPrompt, wsPortOverride);
