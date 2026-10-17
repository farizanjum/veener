import { describe, expect, it } from "vitest";
import {
	SpeedTracker,
	formatDuration,
	planChunks,
	remainingChunkIndices,
	validatePartMeta,
} from "../src/llm/download";

describe("planChunks", () => {
	it("splits evenly into ranged chunks", () => {
		const plans = planChunks(100, 4);
		expect(plans).toEqual([
			{ start: 0, end: 24 },
			{ start: 25, end: 49 },
			{ start: 50, end: 74 },
			{ start: 75, end: 99 },
		]);
	});

	it("covers every byte exactly once for uneven totals", () => {
		const plans = planChunks(103, 4);
		expect(plans[0].start).toBe(0);
		expect(plans[plans.length - 1].end).toBe(102);
		for (let i = 1; i < plans.length; i++) {
			expect(plans[i].start).toBe(plans[i - 1].end + 1);
		}
		const total = plans.reduce((sum, plan) => sum + (plan.end - plan.start + 1), 0);
		expect(total).toBe(103);
	});

	it("splits small files into at most the requested count and returns empty for zero", () => {
		const plans = planChunks(10, 4);
		expect(plans.length).toBeLessThanOrEqual(4);
		expect(plans[0].start).toBe(0);
		expect(plans[plans.length - 1].end).toBe(9);
		expect(planChunks(0, 4)).toEqual([]);
	});
});

describe("SpeedTracker", () => {
	it("computes speed over the rolling window", () => {
		const tracker = new SpeedTracker(1000);
		tracker.add(0, 500);
		tracker.add(500, 500);
		expect(tracker.bytesPerSecond(900)).toBe(1000);
	});

	it("drops samples outside the window", () => {
		const tracker = new SpeedTracker(1000);
		tracker.add(0, 1000);
		tracker.add(5000, 500);
		expect(tracker.bytesPerSecond(5900)).toBe(500);
	});

	it("computes ETA from remaining bytes", () => {
		const tracker = new SpeedTracker(1000);
		tracker.add(0, 1000);
		expect(tracker.etaSeconds(500, 4000)).toBe(4);
	});

	it("returns null ETA with no data", () => {
		const tracker = new SpeedTracker(1000);
		expect(tracker.etaSeconds(0, 100)).toBeNull();
	});
});

describe("formatDuration", () => {
	it("formats seconds and minutes", () => {
		expect(formatDuration(45)).toBe("45s");
		expect(formatDuration(130)).toBe("2 min 10s");
	});

	it("handles garbage input", () => {
		expect(formatDuration(Number.NaN)).toBe("");
		expect(formatDuration(-5)).toBe("");
	});
});

describe("validatePartMeta", () => {
	const good = { url: "u", total: 100, have: [50, 0], done: [true, false] };

	it("accepts a matching meta", () => {
		expect(validatePartMeta(good, "u", 100, 2)).toEqual(good);
	});

	it("rejects url, total, and shape mismatches", () => {
		expect(validatePartMeta(good, "other", 100, 2)).toBeNull();
		expect(validatePartMeta(good, "u", 200, 2)).toBeNull();
		expect(validatePartMeta(good, "u", 100, 3)).toBeNull();
		expect(validatePartMeta({ url: "u", total: 100 }, "u", 100, 2)).toBeNull();
		expect(validatePartMeta("junk", "u", 100, 2)).toBeNull();
	});
});

describe("remainingChunkIndices", () => {
	it("lists only unfinished chunks", () => {
		expect(
			remainingChunkIndices({ url: "u", total: 100, have: [100, 30, 0, 0], done: [true, false, false, false] }),
		).toEqual([1, 2, 3]);
	});
});
