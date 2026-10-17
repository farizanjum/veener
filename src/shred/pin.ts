import { randomBytes } from "../crypto/random";

/** Destruction PIN storage: salted SHA-256. Fast to verify on every candidate. */

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

export function isValidPinFormat(pin: string): boolean {
	return /^\d+$/.test(pin) && pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function newPinRecord(pin: string): Promise<{ salt: string; hash: string }> {
	const salt = Buffer.from(randomBytes(16)).toString("base64");
	return { salt, hash: await sha256Hex(`${salt}:${pin}`) };
}

export async function verifyPin(candidate: string, salt: string, hash: string): Promise<boolean> {
	if (!isValidPinFormat(candidate)) return false;
	const actual = await sha256Hex(`${salt}:${candidate}`);
	let diff = 0;
	const length = Math.max(actual.length, hash.length);
	for (let i = 0; i < length; i++) {
		diff |= (actual.charCodeAt(i) || 0) ^ (hash.charCodeAt(i) || 0);
	}
	return diff === 0;
}
