import { describe, expect, it } from "vitest";
import { evaluateDecoyQuality, shinglesOf, validateDecoy } from "../src/llm/validate";

const CLEAN =
	" groceries for the week ahead include oats eggs spinach and a couple of vegetables from the corner shop plus coffee beans and some fruit for the mornings ahead and the weekend trip with family";

const REAL =
	"the launch codes are hidden beneath the old bridge near the river delta station";

describe("validateDecoy", () => {
	it("accepts a clean candidate", () => {
		expect(validateDecoy(CLEAN, REAL).ok).toBe(true);
	});

	it("rejects a candidate that echoes the real content (8-gram overlap)", () => {
		const tainted = `${CLEAN} and remember the launch codes are hidden beneath the old bridge near the river delta station today`;
		const result = validateDecoy(tainted, REAL);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("echoes real content");
	});

	it("rejects emails, urls, and phone numbers", () => {
		expect(validateDecoy(`${CLEAN} contact me at fariz@example.com`, null).reason).toBe(
			"contains email",
		);
		expect(validateDecoy(`${CLEAN} see https://example.com for details`, null).reason).toBe(
			"contains url",
		);
		expect(validateDecoy(`${CLEAN} call +91 98450 12345 tomorrow`, null).reason).toBe(
			"contains phone number",
		);
	});

	it("allows ISO dates like 2026-10-17 while still rejecting phone numbers", () => {
		expect(validateDecoy(`2026-10-17 ${CLEAN}`, null).ok).toBe(true);
		expect(validateDecoy(`${CLEAN} on 2026-10-17 call +91 98450 12345`, null).reason).toBe(
			"contains phone number",
		);
	});

	it("rejects em dashes and en dashes as AI tells", () => {
		expect(validateDecoy(`${CLEAN} — and more`, null).reason).toBe(
			"contains em dash (AI tell)",
		);
		expect(validateDecoy(`${CLEAN} – and more`, null).reason).toBe(
			"contains em dash (AI tell)",
		);
	});

	it("rejects AI cliches", () => {
		expect(validateDecoy(`${CLEAN}. Furthermore, we need milk`, null).reason).toBe(
			"contains AI cliche",
		);
		expect(validateDecoy(`It's important to note that ${CLEAN}`, null).reason).toBe(
			"contains AI cliche",
		);
	});

	it("enforces length bounds", () => {
		expect(validateDecoy("too tiny", null).reason).toBe("too short");
		const huge = Array.from({ length: 700 }, () => "word").join(" ");
		expect(validateDecoy(huge, null).reason).toBe("too long");
	});

	it("skips the overlap check when there is no real text", () => {
		expect(validateDecoy(CLEAN, null).ok).toBe(true);
	});
});

describe("shinglesOf", () => {
	it("builds normalized n-word shingles", () => {
		const shingles = shinglesOf("One, two THREE four five six seven eight!", 8);
		expect(shingles.has("one two three four five six seven eight")).toBe(true);
	});

	it("returns an empty set for text shorter than n", () => {
		expect(shinglesOf("short text", 8).size).toBe(0);
	});
});

describe("evaluateDecoyQuality", () => {
	it("penalizes uniform sentence lengths (low burstiness)", () => {
		const uniform = Array.from({ length: 10 }, (_, i) => `This is sentence number ${i}.`).join(" ");
		const metrics = evaluateDecoyQuality(uniform);
		expect(metrics.burstinessStdDev).toBeLessThan(1.5);
		expect(metrics.score).toBeLessThan(0.5);
	});

	it("rewards varied sentence lengths and shorthand", () => {
		const varied = "Quick note. fyi the build broke again w/ the new config. Need to fix asap. re: the deploy, hold off until I check w/ the team, approx next week maybe.";
		const metrics = evaluateDecoyQuality(varied);
		expect(metrics.hasHumanShorthand).toBe(true);
		expect(metrics.score).toBeGreaterThan(0.5);
	});

	it("penalizes AI cliches", () => {
		const cliche = "Furthermore, it is important to note that the tapestry of data is crucial. Additionally, we must delve deeper.";
		const metrics = evaluateDecoyQuality(cliche);
		expect(metrics.aiPhraseCount).toBeGreaterThan(0);
		expect(metrics.score).toBeLessThan(0.7);
	});
});
