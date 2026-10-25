import { randomBytes } from "./random";
import {
	KDF_DEFAULTS,
	deriveKek,
	kdfParamsFromConfig,
	type KdfConfig,
} from "./kdf";
import {
	PAD_BLOCK,
	aesGcmDecrypt,
	aesGcmEncrypt,
	pad,
	unpad,
} from "./cipher";

/**
 * Portable-mode payload (§3.1): the .md file is decoy plaintext plus one HTML
 * comment at EOF holding this base64 JSON. Reading mode renders the comment
 * invisible; Obsidian's indexers see only the decoy.
 */
export const PAYLOAD_MARKER_PREFIX = "<!--deocy:v1:";
export const PAYLOAD_MARKER_SUFFIX = "-->";
export const FRONTMATTER_KEY = "draft_cache";
const FRONTMATTER_PREFIX = "---\n";
const FRONTMATTER_SUFFIX = "\n---\n";
const FRONTMATTER_BLOCK_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const STACKED_FRONTMATTER_RE = /^\s*---\r?\ndraft_cache:\s*"deocy:v1:[^"]*"\r?\n---\r?\n?/;
const ORPHANED_FRONTMATTER_RE = /^\s*draft_cache:\s*"deocy:v1:[^"]*"\r?\n---\r?\n?/;
const CANONICAL_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strips leading stacked or orphaned `draft_cache` YAML frontmatter blocks from `text`. */
export function stripDraftCacheBlocks(text: string): string {
	let current = text;
	while (true) {
		if (STACKED_FRONTMATTER_RE.test(current)) {
			current = current.replace(STACKED_FRONTMATTER_RE, "");
			continue;
		}
		if (ORPHANED_FRONTMATTER_RE.test(current)) {
			current = current.replace(ORPHANED_FRONTMATTER_RE, "");
			continue;
		}
		break;
	}
	return current;
}

const DEK_WRAP_AAD = "deocy-dek-wrap-v1";
const NOTE_AAD_PREFIX = "deocy-note:";
const WRAP_NONCE_LENGTH = 12;
const DEK_LENGTH = 32;
const NOTE_ID_BYTES = 16;

/** Encrypted binary attachment entry stored inside a `PayloadV1` envelope. */
export interface EncryptedImageEntry {
	mime: string;
	nonce: string; // base64
	ct: string; // base64
}

/** Encrypted real note title stored inside a `PayloadV1` envelope. */
export interface EncryptedTitle {
	nonce: string; // base64
	ct: string; // base64
}

/** Version 1 encrypted note envelope persisted in the file's frontmatter or trailing HTML comment. */
export interface PayloadV1 {
	v: 1;
	note_id: string; // random hex UUID, survives file renames
	kdf: KdfConfig;
	cipher: { algo: "aes-256-gcm"; nonce: string; ct: string };
	dek_wrap: string; // base64(wrapNonce || AES-GCM(KEK, DEK))
	pad: number;
	images?: Record<string, EncryptedImageEntry>;
	title?: EncryptedTitle;
}

/** Result of parsing a protected note into its visible decoy markdown and encrypted `PayloadV1` envelope. */
export interface ParsedFile {
	decoyBody: string;
	payload: PayloadV1;
}

/** Snapshot of an encrypted image entry used to verify cache freshness against in-place mutations. */
interface CachedImageSnapshot {
	readonly key: string;
	readonly mime: string;
	readonly nonce: string;
	readonly ct: string;
}

/** Cached frontmatter block and field-reference snapshot for a `PayloadV1` object. */
interface CachedFrontmatterEntry {
	readonly keyCount: number;
	readonly noteId: string;
	readonly kdfAlgo: string;
	readonly kdfSalt: string;
	readonly kdfTime: number;
	readonly kdfMem: number;
	readonly kdfPar: number;
	readonly cipherAlgo: string;
	readonly cipherNonce: string;
	readonly cipherCt: string;
	readonly dekWrap: string;
	readonly pad: number;
	readonly hasTitle: boolean;
	readonly titleNonce: string | undefined;
	readonly titleCt: string | undefined;
	readonly imagesSnapshot: readonly CachedImageSnapshot[] | null;
	readonly frontmatter: string;
}

const frontmatterCache = new WeakMap<PayloadV1, CachedFrontmatterEntry>();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encodes a `Uint8Array` into a standard base64 string. */
export function toB64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

/** Decodes a base64 string into an `ArrayBuffer`-backed `Uint8Array`. */
export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * AAD binds the ciphertext to the note's identity only. Binding to the decoy
 * body was rejected: the decoy must stay editable while locked (cover
 * maintenance, §8.3), and an AAD-bound decoy would make legitimate cover
 * edits permanently break unlock. The GCM tag still protects the real text.
 */
function aadFor(noteId: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(`${NOTE_AAD_PREFIX}${noteId}`);
}

/** Parses `fileContent` for a Veneer `PayloadV1` in either YAML frontmatter or a legacy HTML comment. */
export function parseFileContent(fileContent: string): ParsedFile | null {
	const frontmatterResult = parseFrontmatterPayload(fileContent);
	if (frontmatterResult) return frontmatterResult;
	return parseCommentPayload(fileContent);
}

/** Decodes and validates a base64-encoded JSON string as a `PayloadV1` object. */
function decodePayloadB64(b64: string): PayloadV1 | null {
	if (!b64) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
		if (parsed === null || typeof parsed !== "object") return null;
		const candidate = parsed as PayloadV1;
		if (candidate.v !== 1 || typeof candidate.note_id !== "string") return null;
		if (b64.length % 4 === 0 && CANONICAL_B64_RE.test(b64)) {
			const frontmatter = `${FRONTMATTER_PREFIX}${FRONTMATTER_KEY}: "deocy:v1:${b64}"${FRONTMATTER_SUFFIX}`;
			const entry = buildFrontmatterCacheEntry(candidate, frontmatter);
			if (entry) {
				frontmatterCache.set(candidate, entry);
			}
		}
		return candidate;
	} catch {
		return null;
	}
}

/** Extracts a `ParsedFile` from a `draft_cache` YAML frontmatter block if present and valid. */
function parseFrontmatterPayload(fileContent: string): ParsedFile | null {
	let cursor = fileContent;
	while (true) {
		const blockMatch = cursor.match(FRONTMATTER_BLOCK_RE);
		if (!blockMatch) {
			if (ORPHANED_FRONTMATTER_RE.test(cursor)) {
				cursor = cursor.replace(ORPHANED_FRONTMATTER_RE, "");
				continue;
			}
			return null;
		}
		const frontmatter = blockMatch[1];
		const rest = cursor.slice(blockMatch[0].length);
		const match = frontmatter.match(new RegExp(`${FRONTMATTER_KEY}:\\s*"deocy:v1:([^"]*)"`));
		if (!match) return null;
		const payload = decodePayloadB64(match[1].trim());
		if (payload) {
			const decoyBody = stripDraftCacheBlocks(rest).trimEnd();
			return { decoyBody, payload };
		}
		cursor = rest;
	}
}

/** Extracts a `ParsedFile` from a trailing legacy `<!--deocy:v1:...-->` HTML comment if present and valid. */
function parseCommentPayload(fileContent: string): ParsedFile | null {
	const markerIndex = fileContent.lastIndexOf(PAYLOAD_MARKER_PREFIX);
	if (markerIndex === -1) return null;
	const endIndex = fileContent.indexOf(PAYLOAD_MARKER_SUFFIX, markerIndex);
	if (endIndex === -1) return null;
	if (fileContent.slice(endIndex + PAYLOAD_MARKER_SUFFIX.length).trim() !== "") return null;
	const b64 = fileContent
		.slice(markerIndex + PAYLOAD_MARKER_PREFIX.length, endIndex)
		.trim();
	const payload = decodePayloadB64(b64);
	if (!payload) return null;
	const rawDecoy = fileContent.slice(0, markerIndex);
	const decoyBody = rawDecoy.replace(/([ \t]*\n)+$/, "").trimEnd();
	return { decoyBody, payload };
}

function buildFrontmatterCacheEntry(
	payload: PayloadV1,
	frontmatter: string,
): CachedFrontmatterEntry | null {
	if (
		payload.v !== 1 ||
		typeof payload.note_id !== "string" ||
		typeof payload.dek_wrap !== "string" ||
		typeof payload.pad !== "number"
	) {
		return null;
	}
	const expectedTopKeys =
		6 + (payload.images !== undefined ? 1 : 0) + (payload.title !== undefined ? 1 : 0);
	if (Object.keys(payload).length !== expectedTopKeys) {
		return null;
	}
	const kdf = payload.kdf;
	if (
		!kdf ||
		typeof kdf !== "object" ||
		Object.keys(kdf).length !== 5 ||
		typeof kdf.algo !== "string" ||
		typeof kdf.salt !== "string" ||
		typeof kdf.time !== "number" ||
		typeof kdf.mem !== "number" ||
		typeof kdf.par !== "number"
	) {
		return null;
	}
	const cipher = payload.cipher;
	if (
		!cipher ||
		typeof cipher !== "object" ||
		Object.keys(cipher).length !== 3 ||
		typeof cipher.algo !== "string" ||
		typeof cipher.nonce !== "string" ||
		typeof cipher.ct !== "string"
	) {
		return null;
	}
	const title = payload.title;
	let titleNonce: string | undefined;
	let titleCt: string | undefined;
	if (title !== undefined) {
		if (
			!title ||
			typeof title !== "object" ||
			Object.keys(title).length !== 2 ||
			typeof title.nonce !== "string" ||
			typeof title.ct !== "string"
		) {
			return null;
		}
		titleNonce = title.nonce;
		titleCt = title.ct;
	}
	const images = payload.images;
	let imagesSnapshot: CachedImageSnapshot[] | null = null;
	if (images !== undefined) {
		if (!images || typeof images !== "object" || Array.isArray(images)) {
			return null;
		}
		const keys = Object.keys(images);
		imagesSnapshot = [];
		for (const key of keys) {
			const img = images[key];
			if (
				!img ||
				typeof img !== "object" ||
				Object.keys(img).length !== 3 ||
				typeof img.mime !== "string" ||
				typeof img.nonce !== "string" ||
				typeof img.ct !== "string"
			) {
				return null;
			}
			imagesSnapshot.push({
				key,
				mime: img.mime,
				nonce: img.nonce,
				ct: img.ct,
			});
		}
	}
	return {
		keyCount: expectedTopKeys,
		noteId: payload.note_id,
		kdfAlgo: kdf.algo,
		kdfSalt: kdf.salt,
		kdfTime: kdf.time,
		kdfMem: kdf.mem,
		kdfPar: kdf.par,
		cipherAlgo: cipher.algo,
		cipherNonce: cipher.nonce,
		cipherCt: cipher.ct,
		dekWrap: payload.dek_wrap,
		pad: payload.pad,
		hasTitle: title !== undefined,
		titleNonce,
		titleCt,
		imagesSnapshot,
		frontmatter,
	};
}

/** Verifies that `payload` has not been mutated in place since `entry` was cached. */
function isFrontmatterCacheValid(payload: PayloadV1, entry: CachedFrontmatterEntry): boolean {
	const expectedTopKeys =
		6 + (payload.images !== undefined ? 1 : 0) + (payload.title !== undefined ? 1 : 0);
	if (
		payload.v !== 1 ||
		payload.note_id !== entry.noteId ||
		payload.dek_wrap !== entry.dekWrap ||
		payload.pad !== entry.pad ||
		expectedTopKeys !== entry.keyCount ||
		Object.keys(payload).length !== expectedTopKeys
	) {
		return false;
	}
	const kdf = payload.kdf;
	if (
		!kdf ||
		typeof kdf !== "object" ||
		Object.keys(kdf).length !== 5 ||
		kdf.algo !== entry.kdfAlgo ||
		kdf.salt !== entry.kdfSalt ||
		kdf.time !== entry.kdfTime ||
		kdf.mem !== entry.kdfMem ||
		kdf.par !== entry.kdfPar
	) {
		return false;
	}
	const cipher = payload.cipher;
	if (
		!cipher ||
		typeof cipher !== "object" ||
		Object.keys(cipher).length !== 3 ||
		cipher.algo !== entry.cipherAlgo ||
		cipher.nonce !== entry.cipherNonce ||
		cipher.ct !== entry.cipherCt
	) {
		return false;
	}
	const title = payload.title;
	if (title === undefined) {
		if (entry.hasTitle) return false;
	} else {
		if (
			!entry.hasTitle ||
			!title ||
			typeof title !== "object" ||
			Object.keys(title).length !== 2 ||
			title.nonce !== entry.titleNonce ||
			title.ct !== entry.titleCt
		) {
			return false;
		}
	}
	const images = payload.images;
	if (images === undefined) {
		if (entry.imagesSnapshot !== null) return false;
	} else {
		if (
			entry.imagesSnapshot === null ||
			!images ||
			typeof images !== "object" ||
			Array.isArray(images)
		) {
			return false;
		}
		const keys = Object.keys(images);
		if (keys.length !== entry.imagesSnapshot.length) return false;
		for (let i = 0; i < keys.length; i += 1) {
			const key = keys[i]!;
			const img = images[key];
			const snap = entry.imagesSnapshot[i]!;
			if (
				!img ||
				typeof img !== "object" ||
				Object.keys(img).length !== 3 ||
				key !== snap.key ||
				img.mime !== snap.mime ||
				img.nonce !== snap.nonce ||
				img.ct !== snap.ct
			) {
				return false;
			}
		}
	}
	return true;
}

/** Returns the cached or freshly encoded `draft_cache` YAML frontmatter block for `payload`. */
function encodeFrontmatterForPayload(payload: PayloadV1): string {
	const cached = frontmatterCache.get(payload);
	if (cached && isFrontmatterCacheValid(payload, cached)) {
		return cached.frontmatter;
	}
	const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
	const frontmatter = `${FRONTMATTER_PREFIX}${FRONTMATTER_KEY}: "deocy:v1:${b64}"${FRONTMATTER_SUFFIX}`;
	const entry = buildFrontmatterCacheEntry(payload, frontmatter);
	if (entry) {
		frontmatterCache.set(payload, entry);
	} else {
		frontmatterCache.delete(payload);
	}
	return frontmatter;
}

/** Serializes a decoy markdown body and encrypted `PayloadV1` envelope into on-disk file content. */
export function serializeFile(decoyBody: string, payload: PayloadV1): string {
	if (!payload || payload.v !== 1 || typeof payload.note_id !== "string") {
		throw new Error("Invalid Veneer payload");
	}
	const cleanDecoy = stripDraftCacheBlocks(decoyBody);
	const frontmatter = encodeFrontmatterForPayload(payload);
	return `${frontmatter}${cleanDecoy}\n`;
}

/** Wraps a per-note DEK under the password-derived KEK using AES-256-GCM and returns base64(nonce || ciphertext). */
async function wrapDek(kek: Uint8Array, dek: Uint8Array<ArrayBuffer>): Promise<string> {
	const { nonce, ciphertext } = await aesGcmEncrypt(kek, dek, encoder.encode(DEK_WRAP_AAD));
	const packed = new Uint8Array(nonce.length + ciphertext.length);
	packed.set(nonce, 0);
	packed.set(ciphertext, nonce.length);
	return toB64(packed);
}

/** Throws when the password-derived KEK cannot unwrap the DEK. */
async function unwrapDek(kek: Uint8Array, wrapped: string): Promise<Uint8Array<ArrayBuffer>> {
	const packed = fromB64(wrapped);
	if (packed.length <= WRAP_NONCE_LENGTH) throw new Error("wrapped DEK malformed");
	return aesGcmDecrypt(
		kek,
		packed.slice(0, WRAP_NONCE_LENGTH),
		packed.slice(WRAP_NONCE_LENGTH),
		encoder.encode(DEK_WRAP_AAD),
	);
}

/** Newly created protected note containing serialized on-disk content and its `PayloadV1` envelope. */
export interface CreatedFile {
	fileContent: string;
	payload: PayloadV1;
}

/** Encrypts a map of raw binary images under `dek`, binding each entry's AAD to `noteId` and image key. */
export async function encryptImageMap(
	dek: Uint8Array<ArrayBuffer>,
	noteId: string,
	rawImages: Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }>,
): Promise<Record<string, EncryptedImageEntry>> {
	const result: Record<string, EncryptedImageEntry> = {};
	for (const [name, entry] of Object.entries(rawImages)) {
		const { nonce, ciphertext } = await aesGcmEncrypt(
			dek,
			entry.data,
			aadFor(`${noteId}:img:${name}`),
		);
		result[name] = {
			mime: entry.mime,
			nonce: toB64(nonce),
			ct: toB64(ciphertext),
		};
	}
	return result;
}

/** Decrypts a map of encrypted image entries under `dek`, verifying each entry's note- and key-bound AAD. */
export async function decryptImageMap(
	dek: Uint8Array<ArrayBuffer>,
	noteId: string,
	encryptedImages?: Record<string, EncryptedImageEntry>,
): Promise<Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }>> {
	const result: Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }> = {};
	if (!encryptedImages) return result;
	for (const [name, entry] of Object.entries(encryptedImages)) {
		const data = await aesGcmDecrypt(
			dek,
			fromB64(entry.nonce),
			fromB64(entry.ct),
			aadFor(`${noteId}:img:${name}`),
		);
		result[name] = {
			mime: entry.mime,
			data,
		};
	}
	return result;
}

/** Encrypts a note's real title under `dek` with title-bound AAD. */
export async function encryptTitle(
	dek: Uint8Array<ArrayBuffer>,
	noteId: string,
	realTitle: string,
): Promise<EncryptedTitle> {
	const { nonce, ciphertext } = await aesGcmEncrypt(
		dek,
		encoder.encode(realTitle),
		aadFor(`${noteId}:title`),
	);
	return {
		nonce: toB64(nonce),
		ct: toB64(ciphertext),
	};
}

/** Decrypts an `EncryptedTitle` under `dek`, or returns `null` when no encrypted title is present. */
export async function decryptTitle(
	dek: Uint8Array<ArrayBuffer>,
	noteId: string,
	encrypted?: EncryptedTitle,
): Promise<string | null> {
	if (!encrypted) return null;
	const bytes = await aesGcmDecrypt(
		dek,
		fromB64(encrypted.nonce),
		fromB64(encrypted.ct),
		aadFor(`${noteId}:title`),
	);
	return decoder.decode(bytes);
}

/** Protect a note: encrypt the real text, emit decoy + payload comment (§9.2 step 3). */
export async function createFile(
	realText: string,
	password: string,
	decoyBody: string,
	noteId?: string,
	rawImages?: Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }>,
	realTitle?: string,
): Promise<CreatedFile> {
	const id =
		noteId ??
		Array.from(randomBytes(NOTE_ID_BYTES), (b) => b.toString(16).padStart(2, "0")).join("");
	const salt = randomBytes(KDF_DEFAULTS.saltLength);
	const kek = await deriveKek(password, salt);
	const dek = randomBytes(DEK_LENGTH);
	try {
		const { nonce, ciphertext } = await aesGcmEncrypt(
			dek,
			pad(encoder.encode(realText)),
			aadFor(id),
		);
		const encryptedImages =
			rawImages && Object.keys(rawImages).length > 0
				? await encryptImageMap(dek, id, rawImages)
				: undefined;
		const encryptedTitle =
			realTitle && realTitle.trim().length > 0
				? await encryptTitle(dek, id, realTitle.trim())
				: undefined;
		const payload: PayloadV1 = {
			v: 1,
			note_id: id,
			kdf: {
				algo: "argon2id",
				salt: toB64(salt),
				time: KDF_DEFAULTS.iterations,
				mem: KDF_DEFAULTS.memorySizeKiB,
				par: KDF_DEFAULTS.parallelism,
			},
			cipher: { algo: "aes-256-gcm", nonce: toB64(nonce), ct: toB64(ciphertext) },
			dek_wrap: await wrapDek(kek, dek),
			pad: PAD_BLOCK,
			...(encryptedImages ? { images: encryptedImages } : {}),
			...(encryptedTitle ? { title: encryptedTitle } : {}),
		};
		return { fileContent: serializeFile(decoyBody, payload), payload };
	} finally {
		kek.fill(0);
		dek.fill(0);
	}
}

/** Decrypted note contents and live session DEK returned after a successful `unlockPayload` call. */
export interface UnlockedNote {
	realText: string;
	/** Live session DEK for re-encryption on save. Caller owns and must zero it on lock. */
	dek: Uint8Array<ArrayBuffer>;
	images: Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }>;
	realTitle: string | null;
}

/** Throws on wrong password or any tampering of ciphertext/wrap (GCM-authenticated). */
export async function unlockPayload(
	payload: PayloadV1,
	password: string,
): Promise<UnlockedNote> {
	const kek = await deriveKek(password, fromB64(payload.kdf.salt), kdfParamsFromConfig(payload.kdf));
	try {
		const dek = await unwrapDek(kek, payload.dek_wrap);
		const plaintext = await aesGcmDecrypt(
			dek,
			fromB64(payload.cipher.nonce),
			fromB64(payload.cipher.ct),
			aadFor(payload.note_id),
		);
		const images = await decryptImageMap(dek, payload.note_id, payload.images);
		const realTitle = await decryptTitle(dek, payload.note_id, payload.title);
		return { realText: decoder.decode(unpad(plaintext)), dek, images, realTitle };
	} finally {
		kek.fill(0);
	}
}

/** Re-encrypt edited real text during an unlocked session (§5 save interception). */
export async function reencryptRealText(
	payload: PayloadV1,
	dek: Uint8Array<ArrayBuffer>,
	newRealText: string,
	encryptedImages?: Record<string, EncryptedImageEntry>,
	realTitle?: string | null,
): Promise<PayloadV1> {
	const { nonce, ciphertext } = await aesGcmEncrypt(
		dek,
		pad(encoder.encode(newRealText)),
		aadFor(payload.note_id),
	);
	const mergedImages = encryptedImages ?? payload.images;
	const mergedTitle =
		realTitle && realTitle.trim().length > 0
			? await encryptTitle(dek, payload.note_id, realTitle.trim())
			: payload.title;
	const { images: _prevImages, title: _prevTitle, ...rest } = payload;
	return {
		...rest,
		cipher: { algo: "aes-256-gcm", nonce: toB64(nonce), ct: toB64(ciphertext) },
		...(mergedImages ? { images: mergedImages } : {}),
		...(mergedTitle ? { title: mergedTitle } : {}),
	};
}

/** Password rotation = re-wrap the DEK under a fresh KEK; no bulk re-encrypt (§4). */
export async function changePassword(
	payload: PayloadV1,
	oldPassword: string,
	newPassword: string,
): Promise<PayloadV1> {
	const { dek } = await unlockPayload(payload, oldPassword);
	try {
		const salt = randomBytes(KDF_DEFAULTS.saltLength);
		const newKek = await deriveKek(newPassword, salt);
		try {
			const { images: _prevImages, title: _prevTitle, ...rest } = payload;
			return {
				...rest,
				kdf: {
					algo: "argon2id",
					salt: toB64(salt),
					time: KDF_DEFAULTS.iterations,
					mem: KDF_DEFAULTS.memorySizeKiB,
					par: KDF_DEFAULTS.parallelism,
				},
				dek_wrap: await wrapDek(newKek, dek),
				...(payload.images ? { images: payload.images } : {}),
				...(payload.title ? { title: payload.title } : {}),
			};
		} finally {
			newKek.fill(0);
		}
	} finally {
		dek.fill(0);
	}
}
