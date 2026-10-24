/**
 * Destruction PIN shred orchestration (§11.2). Order is the security property:
 * RAM and editor state are sanitized BEFORE any disk I/O, so an in-flight
 * auto-save can never persist plaintext mid-shred. Dependencies are injected
 * for testability; a failure on one file never aborts the rest.
 */

import { parseFileContent } from "../crypto/payload";

export interface ShredTarget {
	path: string;
	mode: "portable" | "stealth";
}

export interface ShredDeps {
	/** Swap views to decoy, zero DEKs/plaintext buffers, kill the save loop. */
	zeroSessions: (() => void) | (() => Promise<void>);
	/** Portable mode: rewrite the .md stripping the payload comment. */
	rewritePortable: (path: string) => Promise<void>;
	/** Stealth mode: delete the external payload store file. */
	deleteStealth: (path: string) => Promise<void>;
	clearRegistry: (succeededPaths?: readonly string[]) => Promise<void>;
}

export interface ShredReport {
	processed: number;
	failures: { path: string; error: string }[];
	/** Ordered step log proving RAM-first ordering. */
	steps: string[];
}

export async function executeShred(
	targets: readonly ShredTarget[],
	deps: ShredDeps,
): Promise<ShredReport> {
	const steps: string[] = [];
	const failures: { path: string; error: string }[] = [];
	const succeededPaths: string[] = [];

	await deps.zeroSessions();
	steps.push("zero-memory");

	for (const target of targets) {
		try {
			if (target.mode === "portable") {
				await deps.rewritePortable(target.path);
				succeededPaths.push(target.path);
				steps.push(`rewrite:${target.path}`);
			} else {
				await deps.deleteStealth(target.path);
				succeededPaths.push(target.path);
				steps.push(`delete:${target.path}`);
			}
		} catch (error) {
			failures.push({ path: target.path, error: String(error) });
			steps.push(`failed:${target.path}`);
		}
	}

	await deps.clearRegistry(succeededPaths);
	steps.push("clear-registry");

	return { processed: targets.length - failures.length, failures, steps };
}

/**
 * Canned decorative note used when a shredded portable file has no remembered
 * decoy and its payload no longer parses. Plausible, benign, and completely
 * free of protected content.
 */
export const SHRED_FALLBACK_DECOY =
	"## Daily notes\n\n- water the plants\n- reply to Kara about lunch\n- book the dentist";

/**
 * Returns the decoy-only content to leave on disk for a protected note during
 * a portable-mode shred. When `content` still parses, this is exactly the
 * note's decoy body; otherwise the shredder's last-known decoy (or a canned
 * decoy) is used, so an unparseable payload can never leak protected text into
 * the rewritten file.
 */
export function stripPortablePayload(content: string, fallbackDecoy?: string | null): string {
	const parsed = parseFileContent(content);
	if (parsed) return `${parsed.decoyBody}\n`;
	const fallback =
		fallbackDecoy && fallbackDecoy.length > 0 ? fallbackDecoy : SHRED_FALLBACK_DECOY;
	return `${fallback}\n`;
}

/** Constant-time-ish string equality for PIN comparison (best effort in JS). */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Setup validation: the destruction PIN must not be a typo away from the real password. */
export function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const matrix: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
	for (let i = 0; i < rows; i++) matrix[i][0] = i;
	for (let j = 0; j < cols; j++) matrix[0][j] = j;
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,
				matrix[i][j - 1] + 1,
				matrix[i - 1][j - 1] + cost,
			);
		}
	}
	return matrix[a.length][b.length];
}
