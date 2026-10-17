/** Cryptographically secure random bytes, always fresh-allocated and ArrayBuffer-backed. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	crypto.getRandomValues(out);
	return out;
}
