import { describe, expect, it } from "vitest";
import { editDistance, executeShred, safeEqual, type ShredDeps } from "../src/shred/duress";

function makeDeps(failOn?: string): { deps: ShredDeps; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			zeroSessions: () => calls.push("zero"),
			rewritePortable: async (path) => {
				if (path === failOn) throw new Error("disk busy");
				calls.push(`rewrite:${path}`);
			},
			deleteStealth: async (path) => {
				if (path === failOn) throw new Error("disk busy");
				calls.push(`delete:${path}`);
			},
			clearRegistry: async () => {
				calls.push("registry");
			},
			clearWebStorage: () => calls.push("webstorage"),
		},
	};
}

describe("executeShred", () => {
	it("zeroes memory before any disk operation (RAM-first ordering)", async () => {
		const { deps, calls } = makeDeps();
		await executeShred(
			[
				{ path: "a.md", mode: "portable" },
				{ path: "b.enc", mode: "stealth" },
			],
			deps,
		);
		expect(calls[0]).toBe("zero");
		expect(calls.indexOf("registry")).toBeGreaterThan(calls.indexOf("rewrite:a.md"));
		expect(calls.indexOf("webstorage")).toBeGreaterThan(calls.indexOf("registry"));
	});

	it("rewrites portable targets and deletes stealth targets", async () => {
		const { deps, calls } = makeDeps();
		const report = await executeShred(
			[
				{ path: "a.md", mode: "portable" },
				{ path: "b.enc", mode: "stealth" },
			],
			deps,
		);
		expect(calls).toContain("rewrite:a.md");
		expect(calls).toContain("delete:b.enc");
		expect(report.processed).toBe(2);
		expect(report.failures).toEqual([]);
	});

	it("continues past a failing file", async () => {
		const { deps, calls } = makeDeps("a.md");
		const report = await executeShred(
			[
				{ path: "a.md", mode: "portable" },
				{ path: "b.md", mode: "portable" },
			],
			deps,
		);
		expect(calls).toContain("rewrite:b.md");
		expect(report.processed).toBe(1);
		expect(report.failures).toHaveLength(1);
		expect(report.failures[0].path).toBe("a.md");
		expect(calls[calls.length - 1]).toBe("webstorage");
	});
});

describe("safeEqual", () => {
	it("matches identical strings and rejects different ones", () => {
		expect(safeEqual("pin-1234", "pin-1234")).toBe(true);
		expect(safeEqual("pin-1234", "pin-1235")).toBe(false);
		expect(safeEqual("short", "longer-string")).toBe(false);
	});
});

describe("editDistance", () => {
	it("computes classic distances", () => {
		expect(editDistance("kitten", "sitting")).toBe(3);
		expect(editDistance("same", "same")).toBe(0);
		expect(editDistance("password", "password1")).toBe(1);
	});
});
