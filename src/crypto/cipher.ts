import { randomBytes } from "./random";

/** Ciphertexts are padded to multiples of 4 KB so file size never leaks content length (§4). */
export const PAD_BLOCK = 4096;
export const NONCE_LENGTH = 12; // 96-bit AES-GCM nonce, random per encryption
const LENGTH_HEADER_BYTES = 4;

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
	const copy = new Uint8Array(raw);
	return crypto.subtle.importKey("raw", copy, { name: "AES-GCM" }, false, usages);
}

export interface AesGcmResult {
	nonce: Uint8Array;
	ciphertext: Uint8Array;
}

export async function aesGcmEncrypt(
	key: Uint8Array,
	plaintext: Uint8Array<ArrayBuffer>,
	aad: Uint8Array<ArrayBuffer>,
): Promise<AesGcmResult> {
	const nonce = randomBytes(NONCE_LENGTH);
	const cryptoKey = await importAesKey(key, ["encrypt"]);
	const buffer = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: aad },
		cryptoKey,
		plaintext,
	);
	return { nonce, ciphertext: new Uint8Array(buffer) };
}

/** Throws on authentication failure (wrong key, wrong AAD, or tampered ciphertext). */
export async function aesGcmDecrypt(
	key: Uint8Array,
	nonce: Uint8Array<ArrayBuffer>,
	ciphertext: Uint8Array<ArrayBuffer>,
	aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const cryptoKey = await importAesKey(key, ["decrypt"]);
	const buffer = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: aad },
		cryptoKey,
		ciphertext,
	);
	return new Uint8Array(buffer);
}

/**
 * Length-hiding pad: [4-byte big-endian length][data][random fill to next 4 KB].
 * Random fill (not zeros) keeps padding indistinguishable from ciphertext.
 */
export function pad(data: Uint8Array, block: number = PAD_BLOCK): Uint8Array<ArrayBuffer> {
	const total = (Math.floor((data.length + LENGTH_HEADER_BYTES) / block) + 1) * block;
	const out = randomBytes(total);
	new DataView(out.buffer).setUint32(0, data.length, false);
	out.set(data, LENGTH_HEADER_BYTES);
	return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
	if (padded.length < LENGTH_HEADER_BYTES) {
		throw new Error("padded payload too short");
	}
	const length = new DataView(padded.buffer, padded.byteOffset).getUint32(0, false);
	if (length + LENGTH_HEADER_BYTES > padded.length) {
		throw new Error("padded payload corrupt");
	}
	return padded.slice(LENGTH_HEADER_BYTES, LENGTH_HEADER_BYTES + length);
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
