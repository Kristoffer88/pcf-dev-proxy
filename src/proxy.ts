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

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";
import * as mockttp from "mockttp";

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
const PAC_FILE_PATH = path.join(CACHE_DIR, "proxy.pac");

const CA_NAME = "PCF Dev Proxy CA";

type Browser = "chrome" | "edge";

// ---------------------------------------------------------------------------
// PAC file
// ---------------------------------------------------------------------------

function writePacFile(port: number) {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	fs.writeFileSync(PAC_FILE_PATH, `function FindProxyForURL(url, host) {
	if (shExpMatch(host, "*.dynamics.com"))
		return "PROXY 127.0.0.1:${port}; DIRECT";
	return "DIRECT";
}
`);
}

function servePacFileOverHttp(): Promise<string> {
	return new Promise((resolve, reject) => {
		const srv = http.createServer((_req, res) => {
			const pac = fs.readFileSync(PAC_FILE_PATH, "utf-8");
			res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" });
			res.end(pac);
		});
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (!addr || typeof addr === "string") return reject(new Error("Failed to bind PAC server"));
			resolve(`http://127.0.0.1:${addr.port}/proxy.pac`);
		});
	});
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

function isCATrusted(): boolean {
	if (!fs.existsSync(CA_CERT_PATH)) return false;
	try {
		if (process.platform === "darwin") {
			execSync(`security verify-cert -c "${CA_CERT_PATH}" 2>/dev/null`, { stdio: "pipe" });
		} else if (process.platform === "win32") {
			const out = execSync(`certutil -store Root "${CA_NAME}"`, { encoding: "utf-8", stdio: "pipe" });
			if (!out.includes(CA_NAME)) return false;
		} else {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function trustCA() {
	if (process.platform === "darwin") {
		console.log("Adding CA certificate to macOS keychain (requires sudo)...");
		execSync(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CA_CERT_PATH}"`, {
			stdio: "inherit",
		});
	} else if (process.platform === "win32") {
		console.log("Adding CA certificate to Windows certificate store...");
		execSync(`certutil -addstore -f Root "${CA_CERT_PATH}"`, { stdio: "inherit" });
	} else {
		console.log(`Unsupported platform. Manually trust: ${CA_CERT_PATH}`);
		process.exit(1);
	}
	console.log("CA certificate trusted.\n");
}

// ---------------------------------------------------------------------------
// Browser restart
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

const BROWSER_CONFIG = {
	chrome: {
		mac: { name: "Google Chrome", processName: "Google Chrome" },
		win: { exe: "chrome.exe", cmd: "start \"\" \"chrome\"" },
	},
	edge: {
		mac: { name: "Microsoft Edge", processName: "Microsoft Edge" },
		win: { exe: "msedge.exe", cmd: `start "" "${EDGE_PATHS_WIN.find((p) => fs.existsSync(p)) || "msedge"}"` },
	},
} as const;

function detectBrowser(): Browser {
	if (process.platform === "win32") {
		if (EDGE_PATHS_WIN.some((p) => fs.existsSync(p))) return "edge";
		return "chrome";
	}
	return "chrome";
}

async function restartBrowserWithProxy(browser: Browser) {
	const pacUrl = await servePacFileOverHttp();
	const config = BROWSER_CONFIG[browser];
	const label = browser === "edge" ? "Edge" : "Chrome";

	const shouldRestart = await confirm(`Restart ${label} with proxy PAC?`);
	if (!shouldRestart) {
		console.log(`Skipping ${label} restart. Launch manually with: --proxy-pac-url="${pacUrl}"`);
		return;
	}

	if (process.platform === "darwin") {
		const { name, processName } = config.mac;
		try {
			execSync(`osascript -e 'quit app "${name}"'`, { stdio: "pipe" });
			console.log(`Closing ${label}...`);
			for (let i = 0; i < 20; i++) {
				try { execSync(`pgrep -x '${processName}'`, { stdio: "pipe" }); } catch { break; }
				execSync("sleep 0.5");
			}
			execSync(`open -na "${name}" --args --proxy-pac-url="${pacUrl}"`, { stdio: "inherit" });
			console.log(`Relaunched ${label} with proxy PAC.`);
		} catch {
			console.log(`Could not restart ${label} automatically. Launch manually with: --proxy-pac-url="${pacUrl}"`);
		}
	} else if (process.platform === "win32") {
		const { exe, cmd } = config.win;
		try {
			execSync(`taskkill /IM ${exe}`, { stdio: "pipe" });
			console.log(`Closing ${label}...`);
			execSync("timeout /t 2 /nobreak >nul", { stdio: "pipe", shell: "cmd.exe" });
			execSync(`${cmd} --proxy-pac-url="${pacUrl}"`, { stdio: "inherit", shell: "cmd.exe" });
			console.log(`Relaunched ${label} with proxy PAC.`);
		} catch {
			console.log(`Could not restart ${label} automatically. Launch manually with: --proxy-pac-url="${pacUrl}"`);
		}
	}
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

async function startProxy(port: number, servingDir: string, controlName: string, browser: Browser) {
	const interceptRe = new RegExp(`${controlName.replace(".", "\\.")}\/([^?]+)`);

	if (!fs.existsSync(servingDir)) {
		console.error(`Serving directory does not exist: ${servingDir}\nRun your build command first.`);
		process.exit(1);
	}

	const ca = await loadOrCreateCA();

	if (!isCATrusted()) {
		console.log("CA certificate is not yet trusted by the OS.");
		trustCA();
	}

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
			const kb = Math.round(body.length / 1024);
			console.log(`  200  ${filename} (${kb} KB)`);

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

	writePacFile(port);
	await restartBrowserWithProxy(browser);

	function shutdown() {
		console.log("\nShutting down proxy...");
		process.exit(0);
	}

	process.on("exit", () => { console.error = _consoleError; });
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	console.log(`\nPCF Dev Proxy running on port ${port}`);
	console.log(`Intercepting: ${controlName}/*`);
	console.log(`Serving from: ${servingDir}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let port = 8642;
let dirOverride: string | null = null;
let controlOverride: string | null = null;
let browserOverride: Browser | null = null;

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) {
		const portArg = args[++i];
		port = parseInt(portArg, 10);
		if (isNaN(port) || port < 1 || port > 65535) { console.error(`Invalid port: ${portArg}`); process.exit(1); }
	}
	else if (args[i] === "--dir" && args[i + 1]) { dirOverride = args[++i]; }
	else if (args[i] === "--control" && args[i + 1]) { controlOverride = args[++i]; }
	else if (args[i] === "--browser" && args[i + 1]) {
		const b = args[++i].toLowerCase();
		if (b !== "chrome" && b !== "edge") { console.error(`Unknown browser: ${b}. Use "chrome" or "edge".`); process.exit(1); }
		browserOverride = b;
	}
	else if (args[i] === "--help" || args[i] === "-h") {
		const detected = detectControl(CWD);
		console.log(`PCF Dev Proxy - HTTPS MITM proxy for local PCF development

Usage: pcf-dev-proxy [options]

Options:
  --port <number>       Proxy port (default: 8642)
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

const servingDir = dirOverride || path.join(CWD, "out/controls", constructorName);
const browser = browserOverride || detectBrowser();

startProxy(port, servingDir, controlName, browser);
