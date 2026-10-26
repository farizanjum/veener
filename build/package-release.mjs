import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { runObsidianPreflight } from "./obsidian-preflight.mjs";

const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

/** Fixed DOS timestamp: 1980-01-01 00:00:00 for deterministic builds. */
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let c = i;
		for (let bit = 0; bit < 8; bit += 1) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}
	return table;
})();

/**
 * Computes the IEEE 802.3 CRC-32 checksum of a buffer.
 *
 * @param {Buffer | Uint8Array} buffer - Input bytes.
 * @returns {number} Unsigned 32-bit CRC-32 value.
 */
export function crc32(buffer) {
	let crc = 0xffffffff;
	for (let i = 0; i < buffer.length; i += 1) {
		const byte = buffer[i];
		crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Normalizes and validates a ZIP entry path to POSIX format.
 *
 * @param {string} rawName - Entry name.
 * @returns {string} Normalized POSIX entry path.
 */
function normalizeZipEntryName(rawName) {
	if (typeof rawName !== "string" || rawName.trim().length === 0) {
		throw new Error("ZIP entry name must be a non-empty string");
	}
	const posixName = rawName.replace(/\\/g, "/");
	if (posixName.startsWith("/") || /^[A-Za-z]:/.test(posixName)) {
		throw new Error(`ZIP entry name must be relative: ${rawName}`);
	}
	const segments = posixName.split("/");
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new Error(`Unsafe ZIP entry path segment in: ${rawName}`);
		}
	}
	return posixName;
}

/**
 * Creates a deterministic PKZIP archive Buffer from the provided in-memory entries.
 *
 * @param {Array<{ name: string; data: Buffer | Uint8Array }>} entries - Files to include in the archive.
 * @returns {Buffer} Complete PKZIP file buffer.
 */
export function createZipArchive(entries) {
	const normalized = entries
		.map((entry) => ({
			name: normalizeZipEntryName(entry.name),
			data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data),
		}))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	if (normalized.length > 0xffff) {
		throw new Error("ZIP archive exceeds 65535 entry limit");
	}

	for (let i = 1; i < normalized.length; i += 1) {
		if (normalized[i].name === normalized[i - 1].name) {
			throw new Error(`Duplicate ZIP entry name: ${normalized[i].name}`);
		}
	}

	/** @type {Buffer[]} */
	const localChunks = [];
	/** @type {Buffer[]} */
	const centralChunks = [];
	let localOffset = 0;

	for (const entry of normalized) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		if (nameBuf.length > 0xffff) {
			throw new Error("ZIP entry name exceeds 65535 bytes");
		}
		const uncompressedSize = entry.data.length;
		const entryCrc = crc32(entry.data);
		const compressedData = deflateRawSync(entry.data, { level: 9 });
		const compressedSize = compressedData.length;
		if (
			uncompressedSize > 0xffffffff ||
			compressedSize > 0xffffffff ||
			localOffset > 0xffffffff
		) {
			throw new Error("ZIP entry size or offset exceeds 32-bit PKZIP limit");
		}

		const localHeader = Buffer.alloc(30 + nameBuf.length);
		localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
		localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
		localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
		localHeader.writeUInt16LE(8, 8); // compression method: deflate
		localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
		localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
		localHeader.writeUInt32LE(entryCrc, 14);
		localHeader.writeUInt32LE(compressedSize, 18);
		localHeader.writeUInt32LE(uncompressedSize, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28); // extra field length
		nameBuf.copy(localHeader, 30);

		localChunks.push(localHeader, compressedData);

		const centralHeader = Buffer.alloc(46 + nameBuf.length);
		centralHeader.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
		centralHeader.writeUInt16LE(20, 4); // version made by
		centralHeader.writeUInt16LE(20, 6); // version needed
		centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
		centralHeader.writeUInt16LE(8, 10); // deflate
		centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
		centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
		centralHeader.writeUInt32LE(entryCrc, 16);
		centralHeader.writeUInt32LE(compressedSize, 20);
		centralHeader.writeUInt32LE(uncompressedSize, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt16LE(0, 30); // extra field length
		centralHeader.writeUInt16LE(0, 32); // comment length
		centralHeader.writeUInt16LE(0, 34); // disk number
		centralHeader.writeUInt16LE(0, 36); // internal attrs
		centralHeader.writeUInt32LE(0, 38); // external attrs
		centralHeader.writeUInt32LE(localOffset, 42);
		nameBuf.copy(centralHeader, 46);

		centralChunks.push(centralHeader);
		localOffset += localHeader.length + compressedData.length;
	}

	const centralDirBuffer = Buffer.concat(centralChunks);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
	eocd.writeUInt16LE(0, 4); // number of this disk
	eocd.writeUInt16LE(0, 6); // disk where central directory starts
	eocd.writeUInt16LE(normalized.length, 8);
	eocd.writeUInt16LE(normalized.length, 10);
	eocd.writeUInt32LE(centralDirBuffer.length, 12);
	eocd.writeUInt32LE(localOffset, 16);
	eocd.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...localChunks, centralDirBuffer, eocd]);
}

/**
 * Reads and decompresses all entries from a PKZIP buffer by parsing its central directory.
 *
 * @param {Buffer | Uint8Array} zipBuffer - Raw PKZIP archive bytes.
 * @returns {Map<string, Buffer>} Map of entry names to decompressed file Buffers.
 */
export function readZipEntries(zipBuffer) {
	const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
	if (buf.length < 22) {
		throw new Error("Invalid ZIP archive: buffer shorter than 22-byte EOCD record");
	}

	let eocdOffset = -1;
	const minEocdOffset = Math.max(0, buf.length - 22 - 0xffff);
	for (let pos = buf.length - 22; pos >= minEocdOffset; pos -= 1) {
		if (buf.readUInt32LE(pos) === END_OF_CENTRAL_DIR_SIG) {
			eocdOffset = pos;
			break;
		}
	}
	if (eocdOffset === -1) {
		throw new Error("Invalid ZIP archive: End of Central Directory signature not found");
	}

	const entryCount = buf.readUInt16LE(eocdOffset + 10);
	const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

	/** @type {Map<string, Buffer>} */
	const entries = new Map();
	let cursor = centralDirOffset;

	for (let i = 0; i < entryCount; i += 1) {
		if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_DIR_HEADER_SIG) {
			throw new Error(`Invalid ZIP central directory header at offset ${cursor}`);
		}
		const compressionMethod = buf.readUInt16LE(cursor + 10);
		const expectedCrc = buf.readUInt32LE(cursor + 16);
		const compressedSize = buf.readUInt32LE(cursor + 20);
		const uncompressedSize = buf.readUInt32LE(cursor + 24);
		const nameLength = buf.readUInt16LE(cursor + 28);
		const extraLength = buf.readUInt16LE(cursor + 30);
		const commentLength = buf.readUInt16LE(cursor + 32);
		const localHeaderOffset = buf.readUInt32LE(cursor + 42);

		if (cursor + 46 + nameLength + extraLength + commentLength > buf.length) {
			throw new Error("Truncated ZIP central directory entry");
		}

		const rawName = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		const name = normalizeZipEntryName(rawName);
		cursor += 46 + nameLength + extraLength + commentLength;

		if (
			localHeaderOffset + 30 > buf.length ||
			buf.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIG
		) {
			throw new Error(`Invalid ZIP local file header for ${name} at offset ${localHeaderOffset}`);
		}
		const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
		const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
		const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
		if (dataStart + compressedSize > buf.length) {
			throw new Error(`Truncated ZIP local data for ${name}`);
		}
		const compressedSlice = buf.subarray(dataStart, dataStart + compressedSize);

		/** @type {Buffer} */
		let decompressed;
		if (compressionMethod === 0) {
			decompressed = Buffer.from(compressedSlice);
		} else if (compressionMethod === 8) {
			decompressed = inflateRawSync(compressedSlice);
		} else {
			throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${name}`);
		}

		if (decompressed.length !== uncompressedSize) {
			throw new Error(
				`ZIP uncompressed size mismatch for ${name}: expected ${uncompressedSize}, got ${decompressed.length}`,
			);
		}
		const actualCrc = crc32(decompressed);
		if (actualCrc !== expectedCrc) {
			throw new Error(
				`ZIP CRC32 mismatch for ${name}: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`,
			);
		}

		entries.set(name, decompressed);
	}

	return entries;
}

/**
 * Computes the hex-encoded SHA-256 digest of a Buffer.
 *
 * @param {Buffer} buffer - File contents.
 * @returns {string} Lowercase hex SHA-256 hash.
 */
function sha256Hex(buffer) {
	return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Packages the Obsidian release artifacts (`main.js`, `manifest.json`, `styles.css`,
 * `veneer-<version>.zip`, and `SHA256SUMS.txt`) into `outDir`.
 *
 * @param {{
 *   rootDir?: string | undefined;
 *   outDir?: string | undefined;
 *   expectedTag?: string | undefined;
 * }} [options={}] - Release packaging options.
 * @returns {{
 *   version: string;
 *   outDir: string;
 *   zipPath: string;
 *   checksumsPath: string;
 *   files: string[];
 *   checksums: Record<string, string>;
 * }} Packaging summary.
 */
export function packageRelease(options = {}) {
	const rootDir = options.rootDir ? path.resolve(options.rootDir) : DEFAULT_ROOT_DIR;
	const outDir = options.outDir
		? path.resolve(options.outDir)
		: path.join(rootDir, "dist", "release");

	const srcDir = path.join(rootDir, "src");
	if (outDir === rootDir || outDir === srcDir || outDir.startsWith(`${srcDir}${path.sep}`)) {
		throw new Error(`Unsafe release outDir: ${outDir}`);
	}

	const preflight = runObsidianPreflight({
		rootDir,
		requireDist: true,
		expectedTag: options.expectedTag,
	});
	if (!preflight.ok) {
		throw new Error(
			`Obsidian preflight failed before packaging release:\n- ${preflight.errors.join("\n- ")}`,
		);
	}

	const version = preflight.version;
	const coreFiles = ["main.js", "manifest.json", "styles.css"];

	/** @type {Array<{ name: string; data: Buffer }>} */
	const zipEntries = [];
	/** @type {Map<string, Buffer>} */
	const coreBuffers = new Map();

	for (const fileName of coreFiles) {
		const fullPath = path.join(rootDir, fileName);
		const data = fs.readFileSync(fullPath);
		coreBuffers.set(fileName, data);
		zipEntries.push({ name: fileName, data });
	}

	const wasmRelPath = "assets/wllama/wasm/wllama.wasm";
	const wasmFullPath = path.join(rootDir, wasmRelPath);
	if (fs.existsSync(wasmFullPath)) {
		zipEntries.push({
			name: wasmRelPath,
			data: fs.readFileSync(wasmFullPath),
		});
	}

	fs.mkdirSync(outDir, { recursive: true });

	for (const [fileName, data] of coreBuffers.entries()) {
		fs.writeFileSync(path.join(outDir, fileName), data);
	}

	const zipFileName = `veneer-${version}.zip`;
	const zipPath = path.join(outDir, zipFileName);
	const zipBuffer = createZipArchive(zipEntries);
	fs.writeFileSync(zipPath, zipBuffer);

	// Round-trip verify the generated ZIP archive
	const verifiedEntries = readZipEntries(zipBuffer);
	for (const entry of zipEntries) {
		const extracted = verifiedEntries.get(entry.name);
		if (!extracted || !extracted.equals(entry.data)) {
			throw new Error(`ZIP round-trip verification failed for ${entry.name}`);
		}
	}

	/** @type {Record<string, string>} */
	const checksums = {
		"main.js": sha256Hex(/** @type {Buffer} */ (coreBuffers.get("main.js"))),
		"manifest.json": sha256Hex(/** @type {Buffer} */ (coreBuffers.get("manifest.json"))),
		"styles.css": sha256Hex(/** @type {Buffer} */ (coreBuffers.get("styles.css"))),
		[zipFileName]: sha256Hex(zipBuffer),
	};

	const checksumLines = Object.entries(checksums).map(
		([name, digest]) => `${digest}  ${name}\n`,
	);
	const checksumsPath = path.join(outDir, "SHA256SUMS.txt");
	fs.writeFileSync(checksumsPath, checksumLines.join(""), "utf8");

	return {
		version,
		outDir,
		zipPath,
		checksumsPath,
		files: ["main.js", "manifest.json", "styles.css", zipFileName, "SHA256SUMS.txt"],
		checksums,
	};
}

/**
 * Parses CLI arguments for the release packaging script.
 *
 * @param {string[]} argv - Command-line arguments (`process.argv.slice(2)`).
 * @returns {{ outDir: string | undefined; expectedTag: string | undefined; rootDir: string | undefined }}
 */
export function parseCliArgs(argv) {
	/** @type {string | undefined} */
	let outDir;
	/** @type {string | undefined} */
	let expectedTag;
	/** @type {string | undefined} */
	let rootDir;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--out-dir") {
			const next = argv[i + 1];
			if (!next || next.trim().length === 0 || next.startsWith("--")) {
				throw new Error("Missing or invalid value for --out-dir");
			}
			outDir = next;
			i += 1;
		} else if (arg.startsWith("--out-dir=")) {
			const val = arg.slice("--out-dir=".length);
			if (val.trim().length === 0 || val.startsWith("--")) {
				throw new Error("Missing or invalid value for --out-dir");
			}
			outDir = val;
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

	return { outDir, expectedTag, rootDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { outDir, expectedTag, rootDir } = parseCliArgs(process.argv.slice(2));
		const result = packageRelease({ outDir, expectedTag, rootDir });
		process.stdout.write(
			`[package-release] OK (version=${result.version}, outDir=${result.outDir}, files=${result.files.join(", ")})\n`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[package-release] ERROR: ${message}\n`);
		process.exitCode = 1;
	}
}
