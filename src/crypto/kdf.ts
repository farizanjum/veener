import { argon2id } from "hash-wasm";

/** Argon2id parameters (§4 of the architecture doc): t=3, 64 MiB, p=1, 32-byte output. */
export const KDF_DEFAULTS = {
	iterations: 3,
	memorySizeKiB: 65536,
	parallelism: 1,
	hashLength: 32,
	saltLength: 16,
} as const;

export interface KdfConfig {
	algo: "argon2id";
	salt: string; // base64
	time: number;
	mem: number; // KiB
	par: number;
}

export interface KdfParams {
	iterations: number;
	memorySizeKiB: number;
	parallelism: number;
}

export function defaultKdfParams(): KdfParams {
	return {
		iterations: KDF_DEFAULTS.iterations,
		memorySizeKiB: KDF_DEFAULTS.memorySizeKiB,
		parallelism: KDF_DEFAULTS.parallelism,
	};
}

export function kdfParamsFromConfig(config: KdfConfig): KdfParams {
	return { iterations: config.time, memorySizeKiB: config.mem, parallelism: config.par };
}

/**
 * Derives the 32-byte Key Encryption Key from a password and salt.
 * The UTF-8 password buffer is zeroed immediately after derivation, key
 * material must never live in long-lived strings/buffers (§4, memory hygiene).
 */
export async function deriveKek(
	password: string,
	salt: Uint8Array,
	params?: KdfParams,
): Promise<Uint8Array> {
	const p = params ?? defaultKdfParams();
	const passwordBytes = new TextEncoder().encode(password);
	try {
		return await argon2id({
			password: passwordBytes,
			salt,
			parallelism: p.parallelism,
			iterations: p.iterations,
			memorySize: p.memorySizeKiB,
			hashLength: KDF_DEFAULTS.hashLength,
			outputType: "binary",
		});
	} finally {
		passwordBytes.fill(0);
	}
}
