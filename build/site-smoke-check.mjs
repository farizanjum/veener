import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITE_DIR = path.join(DEFAULT_ROOT_DIR, "site");

/** @type {Record<string, string>} */
const REQUIRED_PAGE_TITLES = {
	"/privacy": "Privacy Policy | Veneer for Obsidian",
	"/privacy.html": "Privacy Policy | Veneer for Obsidian",
	"/security": "Security Policy &amp; Cryptographic Specification | Veneer for Obsidian",
	"/security.html": "Security Policy &amp; Cryptographic Specification | Veneer for Obsidian",
	"/terms": "Terms &amp; Conditions | Veneer for Obsidian",
	"/terms.html": "Terms &amp; Conditions | Veneer for Obsidian",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @type {Record<string, string>} */
const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
};

/**
 * Parses and validates the width and height of a PNG buffer from its `IHDR` chunk.
 *
 * @param {Buffer | Uint8Array} buffer - Raw PNG image bytes.
 * @returns {{ width: number; height: number }} Image dimensions in pixels.
 */
export function parsePngDimensions(buffer) {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (buf.length < 24) {
		throw new Error(`Invalid PNG: buffer too short (${buf.length} bytes, expected >= 24)`);
	}
	if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error("Invalid PNG: missing 8-byte PNG signature");
	}
	const chunkType = buf.subarray(12, 16).toString("ascii");
	if (chunkType !== "IHDR") {
		throw new Error(`Invalid PNG: expected IHDR chunk at offset 12, found "${chunkType}"`);
	}
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	if (width <= 0 || height <= 0) {
		throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
	}
	return { width, height };
}

/**
 * Verifies that an HTML page includes required mobile viewport, title, Open Graph,
 * Twitter Card, and responsive CSS media query markers.
 *
 * @param {string} html - Raw HTML markup.
 * @param {string} [pagePath="/"] - Request path being checked.
 * @returns {{ ok: boolean; errors: string[] }} Smoke validation result.
 */
export function verifyHtmlSmoke(html, pagePath = "/") {
	/** @type {string[]} */
	const errors = [];
	if (typeof html !== "string" || html.trim().length === 0) {
		errors.push(`${pagePath}: HTML body is empty`);
		return { ok: false, errors };
	}

	if (!html.includes('<meta name="viewport"') || !html.includes("width=device-width")) {
		errors.push(`${pagePath}: missing mobile viewport meta tag (<meta name="viewport" ... width=device-width>)`);
	}
	if (!html.includes("<title>") || !html.includes("Veneer")) {
		errors.push(`${pagePath}: missing <title> containing "Veneer"`);
	}
	const expectedTitle = REQUIRED_PAGE_TITLES[pagePath];
	if (expectedTitle && !html.includes(`<title>${expectedTitle}</title>`)) {
		errors.push(`${pagePath}: response is not the required page`);
	}

	if (pagePath === "/" || pagePath === "/index.html") {
		if (!html.includes('property="og:image"') || !html.includes("og-image.png")) {
			errors.push(`${pagePath}: missing og:image meta tag pointing to og-image.png`);
		}
		if (!/<meta\s+property=["']og:image:width["']\s+content=["']1200["']/.test(html)) {
			errors.push(`${pagePath}: missing og:image:width="1200" meta tag`);
		}
		if (!/<meta\s+property=["']og:image:height["']\s+content=["']630["']/.test(html)) {
			errors.push(`${pagePath}: missing og:image:height="630" meta tag`);
		}
		if (!/<meta\s+name=["']twitter:card["']\s+content=["']summary_large_image["']/.test(html)) {
			errors.push(`${pagePath}: missing twitter:card="summary_large_image" meta tag`);
		}
		if (!html.includes("@media (max-width:")) {
			errors.push(`${pagePath}: missing responsive mobile CSS media query (@media (max-width: ...))`);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
	};
}

/**
 * Starts an ephemeral local HTTP static server bound to `127.0.0.1:0` serving `siteDir`.
 *
 * @param {string} [siteDir=DEFAULT_SITE_DIR] - Directory containing static site files.
 * @returns {Promise<{ baseUrl: string; close: () => Promise<void> }>} Active server handle.
 */
export function startLocalSiteServer(siteDir = DEFAULT_SITE_DIR) {
	const resolvedSiteDir = path.resolve(siteDir);
	const realRootDir = fs.existsSync(resolvedSiteDir)
		? fs.realpathSync(resolvedSiteDir)
		: resolvedSiteDir;

	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			try {
				const rawUrl = req.url ?? "/";
				const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
				/** @type {string} */
				let reqPath;
				try {
					reqPath = decodeURIComponent(parsedUrl.pathname);
				} catch {
					res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Bad Request");
					return;
				}
				if (reqPath.includes("\0")) {
					res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Bad Request");
					return;
				}
				if (reqPath === "/") {
					reqPath = "/index.html";
				}

				const normalizedRel = reqPath.replace(/^[\\/]+/, "");
				let candidatePath = path.resolve(resolvedSiteDir, normalizedRel);

				const relativeToRoot = path.relative(resolvedSiteDir, candidatePath);
				const isInsideRoot =
					candidatePath === resolvedSiteDir ||
					candidatePath.startsWith(`${resolvedSiteDir}${path.sep}`);
				if (
					!isInsideRoot ||
					relativeToRoot === ".." ||
					relativeToRoot.startsWith(`..${path.sep}`) ||
					path.isAbsolute(relativeToRoot)
				) {
					res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Forbidden");
					return;
				}

				if (
					!fs.existsSync(candidatePath) &&
					!path.extname(candidatePath) &&
					fs.existsSync(`${candidatePath}.html`)
				) {
					candidatePath = `${candidatePath}.html`;
				}

				if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
					res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Not Found");
					return;
				}

				const realCandidate = fs.realpathSync(candidatePath);
				if (
					realCandidate !== realRootDir &&
					!realCandidate.startsWith(`${realRootDir}${path.sep}`)
				) {
					res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Forbidden");
					return;
				}

				const ext = path.extname(candidatePath).toLowerCase();
				const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
				const body = fs.readFileSync(candidatePath);
				res.writeHead(200, {
					"Content-Type": contentType,
					"Content-Length": body.length,
					"X-Content-Type-Options": "nosniff",
					"Referrer-Policy": "strict-origin-when-cross-origin",
					"X-Frame-Options": "DENY",
				});
				res.end(body);
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal Server Error");
			}
		});

		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Failed to resolve ephemeral server port"));
				return;
			}
			const baseUrl = `http://127.0.0.1:${addr.port}`;
			resolve({
				baseUrl,
				close: () =>
					new Promise((closeResolve, closeReject) => {
						server.close((err) => {
							if (err) closeReject(err);
							else closeResolve();
						});
					}),
			});
		});
	});
}

/**
 * Runs the HTTP, HTML, mobile viewport, and `og-image.png` binary smoke check
 * against either a local `siteDir` or a deployed `baseUrl`.
 *
 * @param {{
 *   siteDir?: string | undefined;
 *   baseUrl?: string | undefined;
 *   timeoutMs?: number | undefined;
 * }} [options={}] - Smoke check options.
 * @returns {Promise<{
 *   ok: boolean;
 *   errors: string[];
 *   checkedPaths: string[];
 *   ogDimensions: { width: number; height: number } | null;
 * }>} Smoke check summary.
 */
export async function runSiteSmokeCheck(options = {}) {
	const siteDir = options.siteDir ? path.resolve(options.siteDir) : DEFAULT_SITE_DIR;
	const timeoutMs = options.timeoutMs ?? 15_000;

	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const checkedPaths = [];
	/** @type {{ width: number; height: number } | null} */
	let ogDimensions = null;

	/** @type {{ baseUrl: string; close: () => Promise<void> } | null} */
	let localServer = null;
	let targetBaseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, "") : "";

	try {
		if (!targetBaseUrl) {
			if (!fs.existsSync(siteDir)) {
				return {
					ok: false,
					errors: [`Site directory does not exist: ${siteDir}`],
					checkedPaths,
					ogDimensions: null,
				};
			}
			localServer = await startLocalSiteServer(siteDir);
			targetBaseUrl = localServer.baseUrl;
		}

		const htmlPages = ["/", "/privacy.html", "/security.html", "/terms.html"];
		for (const pagePath of htmlPages) {
			const url = `${targetBaseUrl}${pagePath}`;
			try {
				let res = await fetch(url, {
					redirect: "manual",
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (
					(res.status === 301 || res.status === 308) &&
					pagePath.endsWith(".html") &&
					res.headers.get("location") === pagePath.slice(0, -5)
				) {
					res = await fetch(`${targetBaseUrl}${pagePath.slice(0, -5)}`, {
						redirect: "manual",
						signal: AbortSignal.timeout(timeoutMs),
					});
				}
				checkedPaths.push(pagePath);
				if (res.status !== 200) {
					errors.push(`${pagePath}: expected HTTP 200, got ${res.status}`);
					continue;
				}
				const html = await res.text();
				const htmlCheck = verifyHtmlSmoke(html, pagePath);
				if (!htmlCheck.ok) {
					errors.push(...htmlCheck.errors);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push(`${pagePath}: fetch failed (${message})`);
			}
		}

		// Binary OG image check
		const ogPath = "/og-image.png";
		try {
			const res = await fetch(`${targetBaseUrl}${ogPath}`, {
				signal: AbortSignal.timeout(timeoutMs),
			});
			checkedPaths.push(ogPath);
			if (res.status !== 200) {
				errors.push(`${ogPath}: expected HTTP 200, got ${res.status}`);
			} else {
				const arrayBuf = await res.arrayBuffer();
				const pngBuffer = Buffer.from(arrayBuf);
				if (pngBuffer.length === 0) {
					errors.push(`${ogPath}: response body is empty`);
				} else {
					try {
						ogDimensions = parsePngDimensions(pngBuffer);
						if (ogDimensions.width !== 1200 || ogDimensions.height !== 630) {
							errors.push(
								`${ogPath}: expected dimensions 1200x630, got ${ogDimensions.width}x${ogDimensions.height}`,
							);
						}
					} catch (pngErr) {
						const message = pngErr instanceof Error ? pngErr.message : String(pngErr);
						errors.push(`${ogPath}: ${message}`);
					}
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${ogPath}: fetch failed (${message})`);
		}

		// Supporting static assets
		const assetPaths = [
			"/robots.txt",
			"/sitemap.xml",
			"/llms.txt",
			"/llms-full.txt",
			"/manifest.webmanifest",
		];
		for (const assetPath of assetPaths) {
			try {
				const res = await fetch(`${targetBaseUrl}${assetPath}`, {
					signal: AbortSignal.timeout(timeoutMs),
				});
				checkedPaths.push(assetPath);
				if (res.status !== 200) {
					errors.push(`${assetPath}: expected HTTP 200, got ${res.status}`);
					continue;
				}
				const text = await res.text();
				if (text.trim().length === 0) {
					errors.push(`${assetPath}: response body is empty`);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push(`${assetPath}: fetch failed (${message})`);
			}
		}
	} finally {
		if (localServer) {
			await localServer.close();
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		checkedPaths,
		ogDimensions,
	};
}

/**
 * Parses CLI arguments for the site smoke check script.
 *
 * @param {string[]} argv - Command-line arguments (`process.argv.slice(2)`).
 * @returns {{ baseUrl: string | undefined; siteDir: string | undefined }}
 */
export function parseCliArgs(argv) {
	/** @type {string | undefined} */
	let baseUrl;
	/** @type {string | undefined} */
	let siteDir;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--url") {
			const next = argv[i + 1];
			if (!next || next.trim().length === 0 || next.startsWith("--")) {
				throw new Error("Missing or invalid value for --url");
			}
			baseUrl = next;
			i += 1;
		} else if (arg.startsWith("--url=")) {
			const val = arg.slice("--url=".length);
			if (val.trim().length === 0 || val.startsWith("--")) {
				throw new Error("Missing or invalid value for --url");
			}
			baseUrl = val;
		} else if (arg === "--site-dir") {
			const next = argv[i + 1];
			if (!next || next.trim().length === 0 || next.startsWith("--")) {
				throw new Error("Missing or invalid value for --site-dir");
			}
			siteDir = next;
			i += 1;
		} else if (arg.startsWith("--site-dir=")) {
			const val = arg.slice("--site-dir=".length);
			if (val.trim().length === 0 || val.startsWith("--")) {
				throw new Error("Missing or invalid value for --site-dir");
			}
			siteDir = val;
		}
	}

	return { baseUrl, siteDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { baseUrl, siteDir } = parseCliArgs(process.argv.slice(2));
		const result = await runSiteSmokeCheck({ baseUrl, siteDir });
		if (!result.ok) {
			for (const err of result.errors) {
				process.stderr.write(`[site-smoke-check] ERROR: ${err}\n`);
			}
			process.exitCode = 1;
		} else {
			const dims = result.ogDimensions
				? `${result.ogDimensions.width}x${result.ogDimensions.height}`
				: "n/a";
			process.stdout.write(
				`[site-smoke-check] OK (checked=${result.checkedPaths.length} endpoints, og-image=${dims})\n`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[site-smoke-check] ERROR: ${message}\n`);
		process.exitCode = 1;
	}
}
