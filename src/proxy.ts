#!/usr/bin/env node
/**
 * HTTPS MITM proxy that intercepts deployed PCF bundle requests and serves local files instead.
 *
 * Auto-detects the PCF control name from ControlManifest.Input.xml in the consuming repo.
 *
 * Usage:
 *   npx @pum/pcf-dev-proxy                # Start proxy (auto-detect control from manifest)
 *   npx @pum/pcf-dev-proxy --port 9000    # Custom port
 *   npx @pum/pcf-dev-proxy --control cc_Projectum.PowerRoadmap  # Override control name
 *   npx @pum/pcf-dev-proxy --no-system-proxy  # Don't touch system proxy settings
 *   npx @pum/pcf-dev-proxy --off          # Disable auto-proxy and exit
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
		// Look for ControlManifest.Input.xml in any subdirectory
		const candidates = findManifestFiles(dir);
		if (candidates.length > 0) return candidates[0];

		const parent = path.dirname(dir);
		if (parent === dir) break; // reached filesystem root
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
	controlName: string; // e.g. "cc_Projectum.PowerRoadmap"
}

function parseManifest(manifestPath: string): ControlInfo | null {
	const xml = fs.readFileSync(manifestPath, "utf-8");
	const match = xml.match(/<control\s+[^>]*namespace="([^"]+)"[^>]*constructor="([^"]+)"/);
	if (!match) return null;
	const namespace = match[1];
	const constructor = match[2];
	return {
		namespace,
		constructor,
		controlName: `cc_${namespace}.${constructor}`,
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

const WIN_INET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

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

let _pacServer: http.Server | null = null;

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
			_pacServer = srv;
			resolve(`http://127.0.0.1:${addr.port}/proxy.pac`);
		});
	});
}

// ---------------------------------------------------------------------------
// System proxy -- macOS
// ---------------------------------------------------------------------------

function macGetActiveNetworkService(): string | null {
	try {
		const routeOutput = execSync("route -n get default 2>/dev/null", { encoding: "utf-8" });
		const ifaceMatch = routeOutput.match(/interface:\s*(\S+)/);
		if (!ifaceMatch) return null;
		const iface = ifaceMatch[1];

		const hwPorts = execSync("networksetup -listallhardwareports", { encoding: "utf-8" });
		const sections = hwPorts.split(/(?=Hardware Port:)/);
		for (const section of sections) {
			if (section.includes(`Device: ${iface}`)) {
				const nameMatch = section.match(/Hardware Port:\s*(.+)/);
				if (nameMatch) return nameMatch[1].trim();
			}
		}
	} catch {
		// ignore
	}
	return null;
}

let _macNetworkService: string | null = null;

function macEnableAutoproxy(port: number): boolean {
	_macNetworkService = macGetActiveNetworkService();
	if (!_macNetworkService) return false;
	writePacFile(port);
	const pacUrl = "file://" + PAC_FILE_PATH;
	execSync(`networksetup -setautoproxyurl "${_macNetworkService}" "${pacUrl}"`, { stdio: "inherit" });
	console.log(`Auto-proxy enabled on "${_macNetworkService}" (PAC with DIRECT fallback)`);
	return true;
}

function macDisableAutoproxy() {
	const svc = _macNetworkService || macGetActiveNetworkService();
	if (!svc) return;
	try {
		execSync(`networksetup -setautoproxystate "${svc}" off`, { stdio: "inherit" });
	} catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// System proxy -- Windows
// ---------------------------------------------------------------------------

async function winEnableAutoproxy(port: number): Promise<boolean> {
	try {
		writePacFile(port);
		const pacUrl = await servePacFileOverHttp();
		execSync(`reg add "${WIN_INET_SETTINGS}" /v AutoConfigURL /t REG_SZ /d "${pacUrl}" /f`, { stdio: "inherit" });
		winRefreshProxy();
		console.log(`Auto-proxy enabled (PAC at ${pacUrl} with DIRECT fallback)`);
		return true;
	} catch {
		return false;
	}
}

function winDisableAutoproxy() {
	try {
		execSync(`reg delete "${WIN_INET_SETTINGS}" /v AutoConfigURL /f 2>nul`, { stdio: "inherit" });
		winRefreshProxy();
	} catch { /* best-effort */ }
	if (_pacServer) { _pacServer.close(); _pacServer = null; }
}

function winRefreshProxy() {
	try {
		execSync(`powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WI { [DllImport(\\"wininet.dll\\")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }'; [WI]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0); [WI]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)"`, { stdio: "pipe" });
	} catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// System proxy -- cross-platform
// ---------------------------------------------------------------------------

async function enableSystemProxy(port: number): Promise<boolean> {
	if (process.platform === "darwin") return macEnableAutoproxy(port);
	if (process.platform === "win32") return winEnableAutoproxy(port);
	return false;
}

function disableSystemProxy() {
	if (process.platform === "darwin") macDisableAutoproxy();
	else if (process.platform === "win32") winDisableAutoproxy();
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
// Chrome restart
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

async function restartChromeWithProxy() {
	const chromePacUrl = await servePacFileOverHttp();

	const shouldRestart = await confirm("Restart Chrome with proxy PAC?");
	if (!shouldRestart) {
		console.log("Skipping Chrome restart. You may need to restart it manually with the proxy PAC.");
		return;
	}

	if (process.platform === "darwin") {
		try {
			execSync(`osascript -e 'quit app "Google Chrome"'`, { stdio: "pipe" });
			console.log("Closing Chrome...");
			for (let i = 0; i < 20; i++) {
				try { execSync("pgrep -x 'Google Chrome'", { stdio: "pipe" }); } catch { break; }
				execSync("sleep 0.5");
			}
			execSync(`open -na "Google Chrome" --args --proxy-pac-url="${chromePacUrl}"`, { stdio: "inherit" });
			console.log("Relaunched Chrome with proxy PAC file.");
		} catch {
			console.log("Could not restart Chrome automatically. Restart Chrome manually.");
		}
	} else if (process.platform === "win32") {
		try {
			execSync(`taskkill /IM chrome.exe`, { stdio: "pipe" });
			console.log("Closing Chrome...");
			execSync("timeout /t 2 /nobreak >nul", { stdio: "pipe", shell: "cmd.exe" });
			execSync(`start "" "chrome" --proxy-pac-url="${chromePacUrl}"`, { stdio: "inherit", shell: "cmd.exe" });
			console.log("Relaunched Chrome with proxy PAC file.");
		} catch {
			console.log("Could not restart Chrome automatically. Restart Chrome manually.");
		}
	}
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

async function startProxy(port: number, servingDir: string, controlName: string, useSystemProxy: boolean) {
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

	let proxyEnabled = false;
	if (useSystemProxy) {
		proxyEnabled = await enableSystemProxy(port);
		if (!proxyEnabled) {
			console.log("Could not auto-configure system proxy. Configure manually: 127.0.0.1:" + port);
		}
	}

	await restartChromeWithProxy();

	function shutdown() {
		console.log("\nShutting down proxy...");
		process.exit(0);
	}

	process.on("exit", () => {
		console.error = _consoleError;
		if (proxyEnabled) disableSystemProxy();
	});
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
let useSystemProxy = process.platform === "darwin" || process.platform === "win32";
let offMode = false;

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) {
		const portArg = args[++i];
		port = parseInt(portArg, 10);
		if (isNaN(port) || port < 1 || port > 65535) { console.error(`Invalid port: ${portArg}`); process.exit(1); }
	}
	else if (args[i] === "--dir" && args[i + 1]) { dirOverride = args[++i]; }
	else if (args[i] === "--control" && args[i + 1]) { controlOverride = args[++i]; }
	else if (args[i] === "--no-system-proxy") useSystemProxy = false;
	else if (args[i] === "--off") offMode = true;
	else if (args[i] === "--help" || args[i] === "-h") {
		const detected = detectControl(CWD);
		console.log(`PCF Dev Proxy - HTTPS MITM proxy for local PCF development

Usage: pcf-dev-proxy [options]

Options:
  --port <number>     Proxy port (default: 8642)
  --dir <path>        Directory to serve files from (auto-detected from manifest)
  --control <name>    Override control name (e.g. cc_Projectum.PowerRoadmap)
  --no-system-proxy   Don't auto-configure system proxy
  --off               Disable auto-proxy configuration and exit
  -h, --help          Show this help

Auto-detected: ${detected ? `${detected.controlName} (from ${detected.manifestDir})` : "no manifest found"}`);
		process.exit(0);
	}
}

if (offMode) {
	disableSystemProxy();
	console.log("Auto-proxy disabled.");
	process.exit(0);
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

startProxy(port, servingDir, controlName, useSystemProxy);
