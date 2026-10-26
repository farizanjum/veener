import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectTsFiles, runObsidianPreflight } from "../build/obsidian-preflight.mjs";
import {
	crc32,
	createZipArchive,
	packageRelease,
	readZipEntries,
} from "../build/package-release.mjs";
import {
	parsePngDimensions,
	runSiteSmokeCheck,
	startLocalSiteServer,
	verifyHtmlSmoke,
} from "../build/site-smoke-check.mjs";

const ROOT_DIR = path.resolve(__dirname, "..");
const tempDirs: string[] = [];

function createTempWorkspace(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-cicd-test-"));
	tempDirs.push(dir);
	return dir;
}

function populateValidFixtureWorkspace(rootDir: string, includeDist = false): void {
	fs.mkdirSync(path.join(rootDir, "src", "ui"), { recursive: true });
	fs.mkdirSync(path.join(rootDir, "src", "lock"), { recursive: true });

	fs.writeFileSync(
		path.join(rootDir, "manifest.json"),
		JSON.stringify(
			{
				id: "veneer",
				name: "Veneer",
				version: "1.0.0",
				minAppVersion: "1.5.0",
				description:
					"Plausible deniability for sensitive notes with realistic cover text and blind inline unlock.",
				author: "Fariz",
				authorUrl: "https://github.com/farizanjum",
				isDesktopOnly: true,
			},
			null,
			2,
		),
		"utf8",
	);

	fs.writeFileSync(
		path.join(rootDir, "versions.json"),
		JSON.stringify({ "1.0.0": "1.5.0" }, null, 2),
		"utf8",
	);

	fs.writeFileSync(
		path.join(rootDir, "package.json"),
		JSON.stringify(
			{
				name: "deocy",
				version: "1.0.0",
				license: "MIT",
			},
			null,
			2,
		),
		"utf8",
	);

	fs.writeFileSync(
		path.join(rootDir, "README.md"),
		[
			"# Veneer",
			"",
			"Optional downloads from huggingface.co, WebAssembly runtime wllama.wasm, and local llama-server.",
		].join("\n"),
		"utf8",
	);

	fs.writeFileSync(
		path.join(rootDir, "src", "main.ts"),
		[
			'import { Plugin } from "obsidian";',
			"export default class VeneerPlugin extends Plugin {",
			"\tonload(): void {",
			"\t\twindow.setTimeout(() => {}, 10);",
			"\t}",
			"}",
		].join("\n"),
		"utf8",
	);

	fs.writeFileSync(
		path.join(rootDir, "src", "ui", "settingsTab.ts"),
		"export class SettingsTab {}\n",
		"utf8",
	);

	if (includeDist) {
		const validBundle =
			'const obsidian = require("obsidian");\n' + "// padding\n".repeat(1200);
		fs.writeFileSync(path.join(rootDir, "main.js"), validBundle, "utf8");
		fs.writeFileSync(
			path.join(rootDir, "styles.css"),
			".veneer-root { display: block; }\n",
			"utf8",
		);
	}
}

/**
 * Extracts all `run:` script bodies from a GitHub Actions workflow YAML file.
 */
function extractWorkflowRunBlocks(yamlContent: string): string[] {
	const lines = yamlContent.split(/\r?\n/);
	const blocks: string[] = [];

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const runMatch = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
		if (!runMatch) {
			continue;
		}
		const prefixIndent = (runMatch[1] ?? "").length;
		const inlineValue = (runMatch[2] ?? "").trim();

		if (/^[|>][+-]?\d*$/.test(inlineValue)) {
			const blockLines: string[] = [];
			for (let j = i + 1; j < lines.length; j += 1) {
				const subLine = lines[j] ?? "";
				if (subLine.trim().length === 0) {
					blockLines.push(subLine);
					continue;
				}
				const indent = subLine.match(/^\s*/)?.[0].length ?? 0;
				if (indent <= prefixIndent) {
					break;
				}
				blockLines.push(subLine);
				i = j;
			}
			blocks.push(blockLines.join("\n"));
		} else {
			blocks.push(inlineValue);
		}
	}

	return blocks;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("CI/CD workflows, Obsidian preflight, deterministic release packaging, and site smoke checks", () => {
	describe("1. runObsidianPreflight", () => {
		const REAL_VERSION = (
			JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "manifest.json"), "utf8")) as {
				version: string;
			}
		).version;
		const MISMATCHED_VERSION = `${REAL_VERSION}-mismatch`;

		it("passes against the real repository root (requireDist: false, expectedTag: REAL_VERSION)", () => {
			const result = runObsidianPreflight({
				rootDir: ROOT_DIR,
				requireDist: false,
				expectedTag: REAL_VERSION,
			});
			expect(result.ok).toBe(true);
			expect(result.errors).toEqual([]);
			expect(result.version).toBe(REAL_VERSION);

			const tsFiles = collectTsFiles(path.join(ROOT_DIR, "src"));
			expect(tsFiles.length).toBeGreaterThan(10);
		});

		it("rejects a v-prefixed tag and a mismatched version tag", () => {
			const vPrefixed = runObsidianPreflight({
				rootDir: ROOT_DIR,
				requireDist: false,
				expectedTag: `v${REAL_VERSION}`,
			});
			expect(vPrefixed.ok).toBe(false);
			expect(vPrefixed.errors.some((e) => e.includes("must not start with 'v'"))).toBe(true);

			const mismatched = runObsidianPreflight({
				rootDir: ROOT_DIR,
				requireDist: false,
				expectedTag: MISMATCHED_VERSION,
			});
			expect(mismatched.ok).toBe(false);
			expect(
				mismatched.errors.some((e) =>
					e.includes(
						`Release tag '${MISMATCHED_VERSION}' does not match manifest.json version '${REAL_VERSION}'`,
					),
				),
			).toBe(true);

			const nonSemver = runObsidianPreflight({
				rootDir: ROOT_DIR,
				requireDist: false,
				expectedTag: "not-semver",
			});
			expect(nonSemver.ok).toBe(false);
			expect(
				nonSemver.errors.some((e) =>
					e.includes("Release tag 'not-semver' must be valid SemVer X.Y.Z"),
				),
			).toBe(true);
		});

		it("rejects synthetic fixture workspaces with console.log, innerHTML, .style., or default hotkeys: in src/main.ts", () => {
			const rootDir = createTempWorkspace();
			populateValidFixtureWorkspace(rootDir, false);

			fs.writeFileSync(
				path.join(rootDir, "src", "main.ts"),
				[
					"export default class BadPlugin {",
					"\tonload() {",
					'\t\tconsole.log("leak");',
					'\t\tdocument.body.innerHTML = "<p>x</p>";',
					'\t\tdocument.body.style.color = "red";',
					'\t\tthis.addCommand({ id: "panic", name: "Panic", hotkeys: [] });',
					"\t\tsetTimeout(() => {}, 100);",
					"\t}",
					"}",
				].join("\n"),
				"utf8",
			);

			const result = runObsidianPreflight({ rootDir, requireDist: false });
			expect(result.ok).toBe(false);
			expect(result.errors.some((e) => e.includes("Forbidden console.log/info/debug"))).toBe(
				true,
			);
			expect(
				result.errors.some((e) => e.includes("Forbidden innerHTML/outerHTML/insertAdjacentHTML")),
			).toBe(true);
			expect(
				result.errors.some((e) => e.includes("Forbidden inline style assignment")),
			).toBe(true);
			expect(
				result.errors.some((e) => e.includes("Forbidden default hotkeys declaration")),
			).toBe(true);
			expect(
				result.errors.some((e) => e.includes("Forbidden bare setTimeout/clearTimeout")),
			).toBe(true);
		});

		it("rejects manifest.description containing 'Obsidian' or missing a trailing period, and catches versions.json / package.json drift", () => {
			const rootDir = createTempWorkspace();
			populateValidFixtureWorkspace(rootDir, false);

			fs.writeFileSync(
				path.join(rootDir, "manifest.json"),
				JSON.stringify(
					{
						id: "veneer",
						name: "Veneer",
						version: "1.0.0",
						minAppVersion: "1.5.0",
						description: "Stealth protection for Obsidian notes without a period",
						author: "Fariz",
						authorUrl: "https://github.com/farizanjum",
						isDesktopOnly: true,
					},
					null,
					2,
				),
				"utf8",
			);
			fs.writeFileSync(
				path.join(rootDir, "versions.json"),
				JSON.stringify({ "1.0.0": "1.4.0" }, null, 2),
				"utf8",
			);
			fs.writeFileSync(
				path.join(rootDir, "package.json"),
				JSON.stringify({ name: "deocy", version: "1.0.1", license: "MIT" }, null, 2),
				"utf8",
			);

			const result = runObsidianPreflight({ rootDir, requireDist: false });
			expect(result.ok).toBe(false);
			expect(
				result.errors.some((e) => e.includes('manifest.description must not contain the word "Obsidian"')),
			).toBe(true);
			expect(
				result.errors.some((e) => e.includes("manifest.description must end with a period '.'")),
			).toBe(true);
			expect(
				result.errors.some((e) => e.includes('versions.json["1.0.0"]') && e.includes("does not match")),
			).toBe(true);
			expect(
				result.errors.some((e) =>
					e.includes("package.json version '1.0.1' does not match manifest.json version '1.0.0'"),
				),
			).toBe(true);
		});

		it("enforces requireDist: true bundle checks on temp fixtures when main.js is missing, invalid, or valid", () => {
			const rootDir = createTempWorkspace();
			populateValidFixtureWorkspace(rootDir, false);

			// 1. Missing main.js and styles.css
			const missingResult = runObsidianPreflight({ rootDir, requireDist: true });
			expect(missingResult.ok).toBe(false);
			expect(missingResult.errors).toContain("Missing required dist file: main.js");
			expect(missingResult.errors).toContain("Missing required dist file: styles.css");

			// 2. main.js present but too small and missing require("obsidian")
			fs.writeFileSync(path.join(rootDir, "styles.css"), ".veneer { color: inherit; }\n", "utf8");
			fs.writeFileSync(path.join(rootDir, "main.js"), "console.warn('tiny bundle');\n", "utf8");
			const invalidBundleResult = runObsidianPreflight({ rootDir, requireDist: true });
			expect(invalidBundleResult.ok).toBe(false);
			expect(
				invalidBundleResult.errors.some((e) => e.includes("is outside allowed bounds")),
			).toBe(true);
			expect(
				invalidBundleResult.errors.some((e) =>
					e.includes('main.js must contain require("obsidian")'),
				),
			).toBe(true);

			// 3. Valid main.js (>= 10_000 bytes containing require("obsidian")) and non-empty styles.css
			populateValidFixtureWorkspace(rootDir, true);
			const validDistResult = runObsidianPreflight({
				rootDir,
				requireDist: true,
				expectedTag: "1.0.0",
			});
			expect(validDistResult.ok).toBe(true);
			expect(validDistResult.errors).toEqual([]);
			expect(validDistResult.bundleBytes).toBeGreaterThanOrEqual(10_000);
		});
	});

	describe("2. createZipArchive, readZipEntries, crc32, and packageRelease", () => {
		it("computes standard IEEE 802.3 CRC-32 and creates deterministic byte-identical ZIP archives regardless of entry order", () => {
			expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);

			const entryA = { name: "manifest.json", data: Buffer.from('{"id":"veneer"}\n', "utf8") };
			const entryB = { name: "main.js", data: Buffer.from('require("obsidian");\n', "utf8") };
			const entryC = {
				name: "assets/wllama/wasm/wllama.wasm",
				data: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
			};

			const zipOrder1 = createZipArchive([entryA, entryB, entryC]);
			const zipOrder2 = createZipArchive([entryC, entryA, entryB]);

			expect(zipOrder1.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
			expect(zipOrder1.equals(zipOrder2)).toBe(true);

			const roundTripped = readZipEntries(zipOrder1);
			expect(Array.from(roundTripped.keys())).toEqual([
				"assets/wllama/wasm/wllama.wasm",
				"main.js",
				"manifest.json",
			]);
			expect(roundTripped.get("manifest.json")?.equals(entryA.data)).toBe(true);
			expect(roundTripped.get("main.js")?.equals(entryB.data)).toBe(true);
			expect(roundTripped.get("assets/wllama/wasm/wllama.wasm")?.equals(entryC.data)).toBe(
				true,
			);
		});

		it("rejects path traversal (../evil), absolute paths, and duplicate entries in createZipArchive", () => {
			expect(() =>
				createZipArchive([{ name: "../evil.txt", data: Buffer.from("bad") }]),
			).toThrow(/Unsafe ZIP entry path segment/);

			expect(() =>
				createZipArchive([{ name: "/etc/passwd", data: Buffer.from("bad") }]),
			).toThrow(/ZIP entry name must be relative/);

			expect(() =>
				createZipArchive([
					{ name: "main.js", data: Buffer.from("a") },
					{ name: "main.js", data: Buffer.from("b") },
				]),
			).toThrow(/Duplicate ZIP entry name/);

			const validZip = createZipArchive([{ name: "main.js", data: Buffer.from("hello world") }]);
			const truncatedCentral = Buffer.from(validZip);
			const eocdPos = truncatedCentral.length - 22;
			const cdOffset = truncatedCentral.readUInt32LE(eocdPos + 16);
			truncatedCentral.writeUInt16LE(0xffff, cdOffset + 28); // corrupt nameLength past buffer end
			expect(() => readZipEntries(truncatedCentral)).toThrow(
				/Truncated ZIP central directory entry/,
			);

			const truncatedLocal = Buffer.from(validZip);
			truncatedLocal.writeUInt32LE(0x00ffffff, cdOffset + 20); // corrupt compressedSize past buffer end
			expect(() => readZipEntries(truncatedLocal)).toThrow(/Truncated ZIP local data/);
		});

		it("rejects unsafe outDir values (outDir === rootDir or inside src/) in packageRelease", () => {
			const rootDir = createTempWorkspace();
			populateValidFixtureWorkspace(rootDir, true);

			expect(() =>
				packageRelease({
					rootDir,
					outDir: rootDir,
					expectedTag: "1.0.0",
				}),
			).toThrow(/Unsafe release outDir/);

			expect(() =>
				packageRelease({
					rootDir,
					outDir: path.join(rootDir, "src", "nested"),
					expectedTag: "1.0.0",
				}),
			).toThrow(/Unsafe release outDir/);
		});

		it("stages main.js, manifest.json, styles.css, veneer-1.0.0.zip, and SHA256SUMS.txt via packageRelease and round-trips all ZIP entries", () => {
			const rootDir = createTempWorkspace();
			populateValidFixtureWorkspace(rootDir, true);

			const wasmDir = path.join(rootDir, "assets", "wllama", "wasm");
			fs.mkdirSync(wasmDir, { recursive: true });
			const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xde, 0xad]);
			fs.writeFileSync(path.join(wasmDir, "wllama.wasm"), wasmBytes);

			const outDir = path.join(rootDir, "dist", "release");
			const packaged = packageRelease({
				rootDir,
				outDir,
				expectedTag: "1.0.0",
			});

			expect(packaged.version).toBe("1.0.0");
			expect(packaged.files).toEqual([
				"main.js",
				"manifest.json",
				"styles.css",
				"veneer-1.0.0.zip",
				"SHA256SUMS.txt",
			]);

			for (const fileName of packaged.files) {
				expect(fs.existsSync(path.join(outDir, fileName))).toBe(true);
			}

			const expectedMainJs = fs.readFileSync(path.join(rootDir, "main.js"));
			const expectedManifest = fs.readFileSync(path.join(rootDir, "manifest.json"));
			const expectedStyles = fs.readFileSync(path.join(rootDir, "styles.css"));
			const zipBuffer = fs.readFileSync(packaged.zipPath);

			const zipEntries = readZipEntries(zipBuffer);
			expect(zipEntries.get("main.js")?.equals(expectedMainJs)).toBe(true);
			expect(zipEntries.get("manifest.json")?.equals(expectedManifest)).toBe(true);
			expect(zipEntries.get("styles.css")?.equals(expectedStyles)).toBe(true);
			expect(zipEntries.get("assets/wllama/wasm/wllama.wasm")?.equals(wasmBytes)).toBe(true);

			const checksumsContent = fs.readFileSync(packaged.checksumsPath, "utf8");
			const expectedZipSha = crypto.createHash("sha256").update(zipBuffer).digest("hex");
			expect(checksumsContent).toContain(`${expectedZipSha}  veneer-1.0.0.zip`);
			expect(packaged.checksums["veneer-1.0.0.zip"]).toBe(expectedZipSha);
		});
	});

	describe("3. parsePngDimensions, verifyHtmlSmoke, startLocalSiteServer, and runSiteSmokeCheck", () => {
		it("passes runSiteSmokeCheck() against the real site/ directory over a live local HTTP server", async () => {
			const result = await runSiteSmokeCheck({
				siteDir: path.join(ROOT_DIR, "site"),
			});
			expect(result.ok).toBe(true);
			expect(result.errors).toEqual([]);
			expect(result.ogDimensions).toEqual({ width: 1200, height: 630 });
			expect(result.checkedPaths).toEqual([
				"/",
				"/privacy.html",
				"/security.html",
				"/terms.html",
				"/og-image.png",
				"/robots.txt",
				"/sitemap.xml",
				"/llms.txt",
				"/llms-full.txt",
				"/manifest.webmanifest",
			]);
		});

		it("supports clean URLs (/privacy -> /privacy.html), query parameters (/og-image.png?v=2), and blocks path traversal with 403/404", async () => {
			const server = await startLocalSiteServer(path.join(ROOT_DIR, "site"));
			try {
				const cleanRes = await fetch(`${server.baseUrl}/privacy`);
				expect(cleanRes.status).toBe(200);
				expect(cleanRes.headers.get("x-content-type-options")).toBe("nosniff");
				const cleanHtml = await cleanRes.text();
				expect(cleanHtml).toContain("Veneer");

				const queryRes = await fetch(`${server.baseUrl}/og-image.png?v=2`);
				expect(queryRes.status).toBe(200);
				const ogBuf = Buffer.from(await queryRes.arrayBuffer());
				expect(parsePngDimensions(ogBuf)).toEqual({ width: 1200, height: 630 });

				const encodedSlashTraversalRes = await fetch(
					`${server.baseUrl}/..%2f..%2fpackage.json`,
				);
				expect(encodedSlashTraversalRes.status).toBe(403);

				const dotTraversalRes = await fetch(`${server.baseUrl}/../package.json`);
				expect([403, 404]).toContain(dotTraversalRes.status);

				const malformedPercentRes = await fetch(`${server.baseUrl}/%E0%A4%A`);
				expect(malformedPercentRes.status).toBe(400);
			} finally {
				await server.close();
			}
		});

		it("rejects non-PNG buffers in parsePngDimensions and flags missing mobile viewport, og:image:width, or @media (max-width: in verifyHtmlSmoke", () => {
			expect(() => parsePngDimensions(Buffer.from("not a png"))).toThrow(/Invalid PNG/);
			expect(() => parsePngDimensions(Buffer.alloc(32, 0))).toThrow(
				/missing 8-byte PNG signature/,
			);

			const badHtml = "<html><head><title>Veneer</title></head><body>Hello</body></html>";
			const smoke = verifyHtmlSmoke(badHtml, "/");
			expect(smoke.ok).toBe(false);
			expect(smoke.errors.some((e) => e.includes("missing mobile viewport meta tag"))).toBe(
				true,
			);
			expect(smoke.errors.some((e) => e.includes('missing og:image:width="1200"'))).toBe(true);
			expect(
				smoke.errors.some((e) => e.includes("missing responsive mobile CSS media query")),
			).toBe(true);
		});
	});

	describe("4. GitHub Actions Workflows & vercel.json Validation", () => {
		const ciYaml = fs.readFileSync(
			path.join(ROOT_DIR, ".github", "workflows", "ci.yml"),
			"utf8",
		);
		const releaseYaml = fs.readFileSync(
			path.join(ROOT_DIR, ".github", "workflows", "release.yml"),
			"utf8",
		);
		const siteDeployYaml = fs.readFileSync(
			path.join(ROOT_DIR, ".github", "workflows", "site-deploy.yml"),
			"utf8",
		);
		const vercelConfig = JSON.parse(
			fs.readFileSync(path.join(ROOT_DIR, "vercel.json"), "utf8"),
		) as {
			outputDirectory: string;
			cleanUrls: boolean;
			trailingSlash: boolean;
			headers: Array<{
				source: string;
				headers: Array<{ key: string; value: string }>;
			}>;
		};

		it("enforces top-level permissions: contents: read and pinned checkout/setup-node SHAs across all workflows", () => {
			for (const yaml of [ciYaml, releaseYaml, siteDeployYaml]) {
				expect(yaml).toMatch(/^permissions:\r?\n\s+contents:\s*read/m);
				expect(yaml).toContain(
					"actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
				);
				expect(yaml).toContain("persist-credentials: false");
				expect(yaml).toContain(
					"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
				);
			}
		});

		it("verifies ci.yml runs npm ci, typecheck, test, build, preflight:dist, package:release, and smoke:site", () => {
			const expectedCommands = [
				"npm ci",
				"npm run typecheck",
				"npm test",
				"npm run build",
				"npm run preflight:dist",
				"npm run package:release",
				"npm run smoke:site",
			];
			for (const cmd of expectedCommands) {
				expect(ciYaml).toContain(cmd);
			}
		});

		it("verifies release.yml triggers on SemVer tags, sets SLSA job permissions, attests provenance, and publishes all 5 release assets", () => {
			expect(releaseYaml).toContain('"[0-9]+.[0-9]+.[0-9]+"');
			expect(releaseYaml).toContain("contents: write");
			expect(releaseYaml).toContain("id-token: write");
			expect(releaseYaml).toContain("attestations: write");
			expect(releaseYaml).toContain(
				"actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
			);
			expect(releaseYaml).toContain("persist-credentials: false");
			expect(releaseYaml).toContain("dist/release/main.js");
			expect(releaseYaml).toContain("dist/release/manifest.json");
			expect(releaseYaml).toContain("dist/release/styles.css");
			expect(releaseYaml).toContain("dist/release/veneer-${TAG_NAME}.zip");
			expect(releaseYaml).toContain("dist/release/SHA256SUMS.txt");
			expect(releaseYaml).toContain(
				"ref: ${{ inputs.tag != '' && format('refs/tags/{0}', inputs.tag) || github.ref }}",
			);
			expect(releaseYaml).toContain(
				'if [[ ! "$RELEASE_TAG" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then',
			);
		});

		it("verifies site-deploy.yml runs node build/site-smoke-check.mjs and deploys preview on PRs/branches and production on main, and validates vercel.json", () => {
			expect(siteDeployYaml).toContain("node build/site-smoke-check.mjs");
			expect(siteDeployYaml).toContain(
				"if: github.event_name == 'pull_request' || github.ref != 'refs/heads/main'",
			);
			expect(siteDeployYaml).toContain("VERCEL_PREVIEW_TOKEN");
			expect(siteDeployYaml).toContain("VERCEL_PROD_TOKEN");
			expect(siteDeployYaml).toContain('if [[ ! "$PREVIEW_URL" =~ ^https:// ]]; then');
			expect(siteDeployYaml).toContain(
				"if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
			);
			expect(siteDeployYaml).toContain("--skip-domain");
			expect(siteDeployYaml).toContain('if [[ ! "$STAGED_URL" =~ ^https:// ]]; then');
			expect(siteDeployYaml).toContain('promote "$STAGED_URL"');
			expect(siteDeployYaml).toContain("https://veener.fariz.tech");
			expect(siteDeployYaml).toContain("https://veneer.fariz.tech");

			expect(vercelConfig.outputDirectory).toBe("site");
			expect(vercelConfig.cleanUrls).toBe(true);
			expect(vercelConfig.trailingSlash).toBe(false);
			const securityHeaders = vercelConfig.headers[0]?.headers ?? [];
			expect(securityHeaders).toEqual(
				expect.arrayContaining([
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					{ key: "X-Frame-Options", value: "DENY" },
				]),
			);
		});

		it("ensures zero workflow run: blocks interpolate ${{ ... }} directly inside shell scripts", () => {
			for (const [name, yaml] of [
				["ci.yml", ciYaml],
				["release.yml", releaseYaml],
				["site-deploy.yml", siteDeployYaml],
			] as const) {
				const runBlocks = extractWorkflowRunBlocks(yaml);
				expect(runBlocks.length).toBeGreaterThan(0);
				for (const block of runBlocks) {
					expect(
						block,
						`${name} run: block must not contain direct \${{ ... }} interpolation`,
					).not.toContain("${{");
				}
			}
		});
	});
});
