/**
 * Output validation before a generated decoy is accepted (§8.2 wall 3).
 * Rejects anything that could embarrass the cover or echo the real note.
 */

/** Outcome of validating a candidate decoy cover string. */
export interface ValidationResult {
	ok: boolean;
	reason?: string;
}

/** Word-count and shingle-overlap thresholds used by {@link validateDecoy}. */
export interface ValidateOptions {
	minWords: number;
	maxWords: number;
	shingleSize: number;
}

export const DEFAULT_VALIDATE_OPTIONS: ValidateOptions = {
	minWords: 15,
	maxWords: 600,
	shingleSize: 8,
};

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/;
const URL_PATTERN = /https?:\/\/|www\./i;
const PHONE_PATTERN = /\+?\d[\d\s-]{8,}\d/g;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;
const DASH_PATTERN = /[—–]/;

/** Returns true if `text` contains a 10+ digit phone-like sequence that is not an ISO date. */
function hasPhoneNumber(text: string): boolean {
	const matches = text.match(PHONE_PATTERN);
	if (!matches) return false;
	return matches.some((match) => {
		const trimmed = match.trim();
		if (ISO_DATE_PATTERN.test(trimmed)) return false;
		return trimmed.replace(/\D/g, "").length >= 10;
	});
}
const AI_CLICHES = [
	"delve",
	"tapestry",
	"furthermore",
	"moreover",
	"in conclusion",
	"it's important to note",
	"it is important to note",
	"seamless",
	"elevate",
	"unleash",
	"firstly",
	"secondly",
	"additionally",
	"in summary",
	"notably",
	"crucial",
	"testament",
	"vibrant",
];
const SHORTHAND_PATTERN = /\b(w\/|w\/o|b\/c|re:|fyi|todo|approx|~|tbh)\b/i;

/** Heuristic quality and naturalness metrics for a candidate decoy cover. */
export interface DecoyQualityMetrics {
	score: number;
	burstinessStdDev: number;
	aiPhraseCount: number;
	hasHumanShorthand: boolean;
}

/** Evaluates the naturalness, burstiness, and AI-cliche score of a candidate decoy cover. */
export function evaluateDecoyQuality(text: string): DecoyQualityMetrics {
	const sentences = text.split(/[.!?]+\s+|\r?\n+/).filter((s) => s.trim().length > 0);
	const lengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
	const mean = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
	const variance =
		lengths.length > 0
			? lengths.reduce((sum, len) => sum + Math.pow(len - mean, 2), 0) / lengths.length
			: 0;
	const burstinessStdDev = Math.sqrt(variance);
	const nonEmptyLines = text.split(/\r?\n+/).filter((s) => s.trim().length > 0);
	const isLineStructured =
		nonEmptyLines.length > 1 && sentences.length <= nonEmptyLines.length * 1.5;
	const effectiveBurstiness =
		isLineStructured && mean > 0 && mean < 10
			? Math.max(burstinessStdDev, (burstinessStdDev / mean) * 10)
			: burstinessStdDev;

	const lowered = text.toLowerCase();
	let aiPhraseCount = 0;
	for (const cliche of AI_CLICHES) {
		if (lowered.includes(cliche)) aiPhraseCount++;
	}

	const hasHumanShorthand = SHORTHAND_PATTERN.test(text);

	let score = 1.0;
	if (effectiveBurstiness < 3.0) score -= 0.3;
	if (effectiveBurstiness < 1.5) score -= 0.2;
	score -= aiPhraseCount * 0.2;
	if (hasHumanShorthand) score += 0.15;

	return {
		score: Math.max(0, Math.min(1, score)),
		burstinessStdDev,
		aiPhraseCount,
		hasHumanShorthand,
	};
}

/** Tokenizes `text` into normalized lowercase alphanumeric words. */
function words(text: string): string[] {
	return text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Normalized n-word shingles of a text, for overlap detection. */
export function shinglesOf(text: string, n: number): Set<string> {
	const tokens = words(text);
	const out = new Set<string>();
	for (let i = 0; i + n <= tokens.length; i++) {
		out.add(tokens.slice(i, i + n).join(" "));
	}
	return out;
}

/** Validates a candidate decoy against length, PII/AI-tell patterns, and n-word shingle overlap with `realText`. */
export function validateDecoy(
	candidate: string,
	realText: string | null,
	options: ValidateOptions = DEFAULT_VALIDATE_OPTIONS,
): ValidationResult {
	const wordCount = words(candidate).length;
	if (wordCount < options.minWords) return { ok: false, reason: "too short" };
	if (wordCount > options.maxWords) return { ok: false, reason: "too long" };
	if (EMAIL_PATTERN.test(candidate)) return { ok: false, reason: "contains email" };
	if (URL_PATTERN.test(candidate)) return { ok: false, reason: "contains url" };
	if (hasPhoneNumber(candidate)) return { ok: false, reason: "contains phone number" };
	if (DASH_PATTERN.test(candidate)) return { ok: false, reason: "contains em dash (AI tell)" };
	const lowered = candidate.toLowerCase();
	for (const cliche of AI_CLICHES) {
		if (lowered.includes(cliche)) return { ok: false, reason: "contains AI cliche" };
	}
	if (realText !== null) {
		const real = new Set<string>();
		for (const snapshot of realText.split("\0")) {
			for (const shingle of shinglesOf(snapshot, options.shingleSize)) {
				real.add(shingle);
			}
		}
		if (real.size > 0) {
			for (const shingle of shinglesOf(candidate, options.shingleSize)) {
				if (real.has(shingle)) {
					return { ok: false, reason: "echoes real content" };
				}
			}
		}
	}
	return { ok: true };
}
