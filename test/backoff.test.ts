import { describe, expect, it } from "vitest";
import { BackoffTracker } from "../src/lock/backoff";

describe("BackoffTracker", () => {
	it("allows the free attempts without delay", () => {
		const tracker = new BackoffTracker(3, 1000, 30000);
		expect(tracker.canAttempt(0)).toBe(true);
		tracker.recordFailure(1000);
		tracker.recordFailure(2000);
		tracker.recordFailure(3000);
		expect(tracker.canAttempt(3001)).toBe(true);
		expect(tracker.delayUntilNextAttempt(3001)).toBe(0);
	});

	it("imposes exponential delays after the free attempts", () => {
		const tracker = new BackoffTracker(3, 1000, 30000);
		tracker.recordFailure(0);
		tracker.recordFailure(0);
		tracker.recordFailure(0);
		tracker.recordFailure(0); // 4th failure → 1s delay
		expect(tracker.delayUntilNextAttempt(0)).toBe(1000);
		expect(tracker.canAttempt(500)).toBe(false);
		expect(tracker.canAttempt(1000)).toBe(true);
		tracker.recordFailure(1000); // 5th → 2s
		expect(tracker.delayUntilNextAttempt(1000)).toBe(2000);
		tracker.recordFailure(3000); // 6th → 4s
		expect(tracker.delayUntilNextAttempt(3000)).toBe(4000);
	});

	it("caps the delay at maxDelayMs", () => {
		const tracker = new BackoffTracker(1, 1000, 3000);
		let last = 0;
		for (let i = 0; i < 10; i++) {
			last = i * 100000;
			tracker.recordFailure(last);
		}
		expect(tracker.delayUntilNextAttempt(last)).toBe(3000);
		expect(tracker.delayUntilNextAttempt(last + 1500)).toBe(1500);
		expect(tracker.canAttempt(last + 3000)).toBe(true);
	});

	it("resets on success", () => {
		const tracker = new BackoffTracker(1, 1000, 30000);
		tracker.recordFailure(0);
		tracker.recordFailure(0);
		expect(tracker.delayUntilNextAttempt(0)).toBeGreaterThan(0);
		tracker.recordSuccess();
		expect(tracker.delayUntilNextAttempt(0)).toBe(0);
		expect(tracker.canAttempt(0)).toBe(true);
	});
});
