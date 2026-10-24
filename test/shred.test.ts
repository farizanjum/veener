import { describe, expect, it } from "vitest";
import {
	editDistance,
	executeShred,
	safeEqual,
	SHRED_FALLBACK_DECOY,
	stripPortablePayload,
	type ShredDeps,
} from "../src/shred/duress";
import { createFile, parseFileContent } from "../src/crypto/payload";

function makeDeps(failOn?: string): {
	deps: ShredDeps;
	calls: string[];
	registered: Set<string>;
} {
	const calls: string[] = [];
	const registered = new Set<string>(["a.md", "b.md", "b.enc"]);
	return {
		calls,
		registered,
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
			clearRegistry: async (succeededPaths) => {
				calls.push("registry");
				if (succeededPaths) {
					for (const p of succeededPaths) registered.delete(p);
				} else {
					registered.clear();
				}
			},
		},
	};
}

describe("executeShred", () => {
	it("zeroes memory before any disk operation (RAM-first ordering)", async () => {
		const { deps, calls } = makeDeps();
		const report = await executeShred(
			[
				{ path: "a.md", mode: "portable" },
				{ path: "b.enc", mode: "stealth" },
			],
			deps,
		);
		expect(calls[0]).toBe("zero");
		expect(calls.indexOf("registry")).toBeGreaterThan(calls.indexOf("rewrite:a.md"));
		expect(calls.indexOf("registry")).toBeGreaterThan(calls.indexOf("delete:b.enc"));
		expect(calls).toEqual(["zero", "rewrite:a.md", "delete:b.enc", "registry"]);
		expect(report.steps).toEqual([
			"zero-memory",
			"rewrite:a.md",
			"delete:b.enc",
			"clear-registry",
		]);
		expect(report.steps).not.toContain("clear-webstorage");
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
		const { deps, calls, registered } = makeDeps("a.md");
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
		expect(calls[calls.length - 1]).toBe("registry");
		expect(registered.has("a.md")).toBe(true);
		expect(registered.has("b.md")).toBe(false);
		expect(report.steps).toEqual([
			"zero-memory",
			"failed:a.md",
			"rewrite:b.md",
			"clear-registry",
		]);
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

describe("stripPortablePayload", () => {
	it("reduces a parsed portable file to its decoy body with a trailing newline", async () => {
		const { fileContent } = await createFile("real notes", "test-password", "cover body");
		const parsed = parseFileContent(fileContent);
		if (parsed === null) throw new Error("Expected parseable payload");
		const stripped = stripPortablePayload(fileContent, "stale fallback");
		expect(stripped).toBe(`${parsed.decoyBody}\n`);
		expect(parseFileContent(stripped)).toBeNull();
		expect(stripped).toContain("cover body");
	});

	it("falls back to the remembered decoy when the content does not parse", () => {
		expect(stripPortablePayload("plain junk", "stale fallback")).toBe("stale fallback\n");
	});

	it("uses the canned fallback for empty content and empty fallback", () => {
		expect(stripPortablePayload("", "")).toBe(`${SHRED_FALLBACK_DECOY}\n`);
	});
});
