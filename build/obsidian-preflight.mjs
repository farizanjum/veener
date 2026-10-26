import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DESCRIPTION_CHARSET_RE = /^[A-Za-z0-9\s.,!?'"-]+$/;

/**
 * Recursively collects sorted `.ts` file paths under `dirPath`.
 *
 * @param {string} dirPath - Root directory to scan for TypeScript source files.
 * @returns {string[]} Sorted array of absolute `.ts` file paths.
 */
export function collectTsFiles(dirPath) {
	if (!fs.existsSync(dirPath)) {
		return [];
	}
	/** @type {string[]} */
	const results = [];
	for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTsFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			results.push(fullPath);
		}
	}
	return results.sort();
}

/**
 * Reads and parses a JSON file from disk, pushing descriptive errors into `errors`.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {string} label - Display label for error messages.
 * @param {string[]} errors - Mutable error accumulator.
 * @returns {Record<string, any> | null} Parsed JSON object or null on failure.
 */
function readJsonFile(filePath, label, errors) {
	if (!fs.existsSync(filePath)) {
		errors.push(`Missing required file: ${label}`);
		return null;
	}
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			errors.push(`${label} must be a JSON object`);
			return null;
		}
		return parsed;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`Failed to parse ${label}: ${message}`);
		return null;
	}
}

/**
 * Runs the Obsidian Community Plugin preflight validation suite.
 *
 * @param {{
 *   rootDir?: string | undefined;
 *   requireDist?: boolean | undefined;
 *   expectedTag?: string | undefined;
 *   minBundleBytes?: number | undefined;
 *   maxBundleBytes?: number | undefined;
 * }} [options={}] - Preflight options.
 * @returns {{
 *   ok: boolean;
 *   errors: string[];
 *   version: string;
 *   bundleBytes: number;
 * }} Validation summary.
 */
export function runObsidianPreflight(options = {}) {
	const rootDir = options.rootDir ? path.resolve(options.rootDir) : DEFAULT_ROOT_DIR;
	const requireDist = Boolean(options.requireDist);
	const expectedTag = options.expectedTag;
	const minBundleBytes = options.minBundleBytes ?? 10_000;
	const maxBundleBytes = options.maxBundleBytes ?? 5_000_000;

	/** @type {string[]} */
	const errors = [];
	let version = "";
	let bundleBytes = 0;

	// 1. manifest.json, versions.json, package.json, README.md exist and parse cleanly
	const manifestPath = path.join(rootDir, "manifest.json");
	const versionsPath = path.join(rootDir, "versions.json");
	const pkgPath = path.join(rootDir, "package.json");
	const readmePath = path.join(rootDir, "README.md");

	const manifest = readJsonFile(manifestPath, "manifest.json", errors);
	const versions = readJsonFile(versionsPath, "versions.json", errors);
	const pkg = readJsonFile(pkgPath, "package.json", errors);

	if (manifest) {
		version = typeof manifest.version === "string" ? manifest.version : "";

		// 2. Identity & desktop-only fields
		if (manifest.id !== "veneer") {
			errors.push(`manifest.id must be "veneer" (got ${JSON.stringify(manifest.id)})`);
		}
		if (manifest.name !== "Veneer") {
			errors.push(`manifest.name must be "Veneer" (got ${JSON.stringify(manifest.name)})`);
		}
		if (manifest.isDesktopOnly !== true) {
			errors.push(`manifest.isDesktopOnly must be true (got ${JSON.stringify(manifest.isDesktopOnly)})`);
		}
		if (manifest.author !== "Fariz") {
			errors.push(`manifest.author must be "Fariz" (got ${JSON.stringify(manifest.author)})`);
		}
		if (manifest.authorUrl !== "https://github.com/farizanjum") {
			errors.push(
				`manifest.authorUrl must be "https://github.com/farizanjum" (got ${JSON.stringify(manifest.authorUrl)})`,
			);
		}

		// 3. Strict SemVer version & minAppVersion
		if (typeof manifest.version !== "string" || !STRICT_SEMVER_RE.test(manifest.version)) {
			errors.push(`manifest.version must be strict SemVer X.Y.Z (got ${JSON.stringify(manifest.version)})`);
		}
		if (typeof manifest.minAppVersion !== "string" || !STRICT_SEMVER_RE.test(manifest.minAppVersion)) {
			errors.push(
				`manifest.minAppVersion must be strict SemVer X.Y.Z (got ${JSON.stringify(manifest.minAppVersion)})`,
			);
		}

		// 4. Description formatting, length, charset, and forbidden words
		const desc = typeof manifest.description === "string" ? manifest.description : "";
		if (desc.length === 0) {
			errors.push("manifest.description must be a non-empty string");
		} else {
			if (desc.length > 250) {
				errors.push(`manifest.description must be <= 250 characters (got ${desc.length})`);
			}
			if (!desc.endsWith(".")) {
				errors.push("manifest.description must end with a period '.'");
			}
			if (!DESCRIPTION_CHARSET_RE.test(desc)) {
				errors.push("manifest.description contains disallowed non-ASCII characters");
			}
			if (/obsidian/i.test(desc)) {
				errors.push('manifest.description must not contain the word "Obsidian"');
			}
			if (/plugin/i.test(desc)) {
				errors.push('manifest.description must not contain the word "plugin"');
			}
		}

		// 5. Synchronization across versions.json and package.json
		if (versions && typeof manifest.version === "string") {
			if (versions[manifest.version] !== manifest.minAppVersion) {
				errors.push(
					`versions.json[${JSON.stringify(manifest.version)}] (${JSON.stringify(versions[manifest.version])}) does not match manifest.minAppVersion (${JSON.stringify(manifest.minAppVersion)})`,
				);
			}
		}
		if (pkg) {
			if (pkg.version !== manifest.version) {
				errors.push(
					`package.json version '${pkg.version}' does not match manifest.json version '${manifest.version}'`,
				);
			}
			if (pkg.license !== "MIT") {
				errors.push(`package.json license must be "MIT" (got ${JSON.stringify(pkg.license)})`);
			}
		}
	}

	// 6. Optional tag validation
	if (expectedTag !== undefined) {
		if (expectedTag.startsWith("v")) {
			errors.push(
				"Release tag must not start with 'v' (Obsidian requires exact SemVer tag matching manifest.json version)",
			);
		}
		if (!STRICT_SEMVER_RE.test(expectedTag)) {
			errors.push(`Release tag '${expectedTag}' must be valid SemVer X.Y.Z`);
		}
		if (expectedTag !== version) {
			errors.push(`Release tag '${expectedTag}' does not match manifest.json version '${version}'`);
		}
	}

	// 7. README.md checks
	if (!fs.existsSync(readmePath)) {
		errors.push("Missing required file: README.md");
	} else {
		const readme = fs.readFileSync(readmePath, "utf8");
		if (!readme.trim().startsWith("# Veneer")) {
			errors.push('README.md must start with "# Veneer"');
		}
		for (const requiredDisclosure of ["huggingface.co", "wllama.wasm", "llama-server"]) {
			if (!readme.includes(requiredDisclosure)) {
				errors.push(`README.md must disclose "${requiredDisclosure}"`);
			}
		}
	}

	// 8. Static src/ checks across all .ts files
	const srcDir = path.join(rootDir, "src");
	const tsFiles = collectTsFiles(srcDir);
	if (tsFiles.length === 0) {
		errors.push("No TypeScript source files found in src/");
	}

	for (const filePath of tsFiles) {
		const relPath = path.relative(rootDir, filePath).replace(/\\/g, "/");
		const content = fs.readFileSync(filePath, "utf8");

		if (/\bconsole\.(?:log|info|debug)\b/.test(content)) {
			errors.push(`Forbidden console.log/info/debug in ${relPath}`);
		}
		if (/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/.test(content)) {
			errors.push(`Forbidden innerHTML/outerHTML/insertAdjacentHTML in ${relPath}`);
		}
		if (/\.style\.|\bcssText\b|\bstyle\s*:/.test(content)) {
			errors.push(`Forbidden inline style assignment (.style. / cssText / style:) in ${relPath}`);
		}
		if (content.includes("plugins/deocy")) {
			errors.push(`Forbidden hardcoded "plugins/deocy" path in ${relPath}`);
		}
	}

	const mainTsPath = path.join(srcDir, "main.ts");
	if (fs.existsSync(mainTsPath)) {
		const mainContent = fs.readFileSync(mainTsPath, "utf8");
		if (/\bhotkeys\s*:/.test(mainContent)) {
			errors.push("Forbidden default hotkeys declaration in src/main.ts");
		}
	}

	const settingsTabPath = path.join(srcDir, "ui", "settingsTab.ts");
	if (fs.existsSync(settingsTabPath)) {
		const settingsContent = fs.readFileSync(settingsTabPath, "utf8");
		if (/\bcreateEl\(\s*["']h[1-6]["']/.test(settingsContent)) {
			errors.push("Forbidden createEl('h1'..'h6') heading in src/ui/settingsTab.ts");
		}
	}

	const timerTargetFiles = [
		path.join(srcDir, "main.ts"),
		path.join(srcDir, "lock", "LockEngine.ts"),
		path.join(srcDir, "ui", "downloadModal.ts"),
		path.join(srcDir, "view", "session.ts"),
		path.join(srcDir, "llm", "generator.ts"),
	];
	for (const targetFile of timerTargetFiles) {
		if (!fs.existsSync(targetFile)) {
			continue;
		}
		const content = fs.readFileSync(targetFile, "utf8");
		if (/(?<!window\.)\b(?:setTimeout|clearTimeout)\s*\(/.test(content)) {
			const relPath = path.relative(rootDir, targetFile).replace(/\\/g, "/");
			errors.push(`Forbidden bare setTimeout/clearTimeout (must use window.setTimeout/clearTimeout) in ${relPath}`);
		}
	}

	// 9. Built bundle & styles checks when requireDist is true
	if (requireDist) {
		const stylesPath = path.join(rootDir, "styles.css");
		if (!fs.existsSync(stylesPath)) {
			errors.push("Missing required dist file: styles.css");
		} else {
			const stylesSize = fs.statSync(stylesPath).size;
			if (stylesSize <= 0) {
				errors.push("styles.css must not be empty");
			}
		}

		const mainJsPath = path.join(rootDir, "main.js");
		if (!fs.existsSync(mainJsPath)) {
			errors.push("Missing required dist file: main.js");
		} else {
			bundleBytes = fs.statSync(mainJsPath).size;
			if (bundleBytes < minBundleBytes || bundleBytes > maxBundleBytes) {
				errors.push(
					`main.js size (${bundleBytes} bytes) is outside allowed bounds [${minBundleBytes}, ${maxBundleBytes}]`,
				);
			}
			const mainJsContent = fs.readFileSync(mainJsPath, "utf8");
			if (!mainJsContent.includes('require("obsidian")')) {
				errors.push('main.js must contain require("obsidian") with obsidian externalized');
			}
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		version,
		bundleBytes,
	};
}

/**
 * Parses CLI arguments for the preflight script.
 *
 * @param {string[]} argv - Command-line arguments (`process.argv.slice(2)`).
 * @returns {{ requireDist: boolean; expectedTag: string | undefined; rootDir: string | undefined }}
 */
export function parseCliArgs(argv) {
	let requireDist = false;
	/** @type {string | undefined} */
	let expectedTag;
	/** @type {string | undefined} */
	let rootDir;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--require-dist") {
			requireDist = true;
		} else if (arg === "--tag") {
			const next = argv[i + 1];
			if (!next || next.trim().length === 0 || next.startsWith("--")) {
				throw new Error("Missing or invalid value for --tag");
			}
			expectedTag = next;
			i += 1;
		} else if (arg.startsWith("--tag=")) {
			const val = arg.slice("--tag=".length);
			if (val.trim().length === 0 || val.startsWith("--")) {
				throw new Error("Missing or invalid value for --tag");
			}
			expectedTag = val;
		} else if (arg === "--root-dir") {
			const next = argv[i + 1];
			if (!next || next.trim().length === 0 || next.startsWith("--")) {
				throw new Error("Missing or invalid value for --root-dir");
			}
			rootDir = next;
			i += 1;
		} else if (arg.startsWith("--root-dir=")) {
			const val = arg.slice("--root-dir=".length);
			if (val.trim().length === 0 || val.startsWith("--")) {
				throw new Error("Missing or invalid value for --root-dir");
			}
			rootDir = val;
		}
	}

	return { requireDist, expectedTag, rootDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { requireDist, expectedTag, rootDir } = parseCliArgs(process.argv.slice(2));
		const result = runObsidianPreflight({ requireDist, expectedTag, rootDir });
		if (!result.ok) {
			for (const err of result.errors) {
				process.stderr.write(`[obsidian-preflight] ERROR: ${err}\n`);
			}
			process.exitCode = 1;
		} else {
			const distNote = requireDist ? `, main.js=${result.bundleBytes} bytes` : "";
			process.stdout.write(
				`[obsidian-preflight] OK (version=${result.version}${distNote})\n`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[obsidian-preflight] ERROR: ${message}\n`);
		process.exitCode = 1;
	}
}
