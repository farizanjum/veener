import { describe, expect, it } from "vitest";
import { scorePassword } from "../src/decoy/strength";

describe("scorePassword", () => {
	it("scores empty as empty", () => {
		expect(scorePassword("").score).toBe(0);
	});

	it("scores short simple passwords as weak", () => {
		expect(scorePassword("abc").score).toBe(1);
		expect(scorePassword("password").score).toBeLessThanOrEqual(2);
	});

	it("scores long passphrases highly", () => {
		expect(scorePassword("correct horse battery staple").score).toBeGreaterThanOrEqual(3);
	});

	it("rewards character variety", () => {
		const plain = scorePassword("alllowercaselettersonly");
		const varied = scorePassword("MixedCase123!");
		expect(varied.score).toBeGreaterThan(plain.score);
	});

	it("never exceeds score 4", () => {
		expect(scorePassword("A very long passphrase with Numbers 123 and Symbols !!!").score).toBeLessThanOrEqual(4);
	});
});
