import { describe, it, expect, vi } from "vitest";
import { PreferredRuntime, selectRuntime } from "../src/llm/preferredRuntime";
import type { LlmRuntime } from "../src/llm/runtime";

describe("PreferredRuntime", () => {
	it("uses primary if it loads successfully", async () => {
		const primary: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockResolvedValue(undefined),
			generate: vi.fn().mockResolvedValue("primary result"),
			unload: vi.fn().mockResolvedValue(undefined),
		};
		const fallback: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: vi.fn(),
			generate: vi.fn(),
			unload: vi.fn(),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		await runtime.ensureLoaded();
		
		expect(primary.ensureLoaded).toHaveBeenCalled();
		expect(fallback.ensureLoaded).not.toHaveBeenCalled();

		const result = await runtime.generate("test", 10);
		expect(result).toBe("primary result");
		expect(primary.generate).toHaveBeenCalled();
		expect(fallback.generate).not.toHaveBeenCalled();
	});

	it("falls back to secondary if primary fails to load", async () => {
		const primary: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: vi.fn().mockRejectedValue(new Error("load failed")),
			generate: vi.fn(),
			unload: vi.fn().mockResolvedValue(undefined),
		};
		const fallback: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockResolvedValue(undefined),
			generate: vi.fn().mockResolvedValue("fallback result"),
			unload: vi.fn().mockResolvedValue(undefined),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		await runtime.ensureLoaded();
		
		expect(primary.ensureLoaded).toHaveBeenCalled();
		expect(fallback.ensureLoaded).toHaveBeenCalled();

		const result = await runtime.generate("test", 10);
		expect(result).toBe("fallback result");
		expect(fallback.generate).toHaveBeenCalled();
	});

	it("falls back when primary generation and cleanup both fail", async () => {
		const primary: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockResolvedValue(undefined),
			generate: vi.fn().mockRejectedValue(new Error("gen failed")),
			unload: vi.fn().mockRejectedValue(new Error("cleanup failed")),
		};
		const fallback: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockResolvedValue(undefined),
			generate: vi.fn().mockResolvedValue("fallback result"),
			unload: vi.fn().mockResolvedValue(undefined),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		await runtime.ensureLoaded();
		
		const result = await runtime.generate("test", 10);
		expect(result).toBe("fallback result");
		expect(primary.generate).toHaveBeenCalled();
		expect(primary.unload).toHaveBeenCalled();
		expect(fallback.ensureLoaded).toHaveBeenCalled();
		expect(fallback.generate).toHaveBeenCalled();
	});

	it("selectRuntime chooses correctly", () => {
		const primary: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: async () => undefined,
			generate: async () => "primary",
			unload: async () => undefined,
		};
		const fallback: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: async () => undefined,
			generate: async () => "fallback",
			unload: async () => undefined,
		};

		expect(selectRuntime("win32", true, primary, fallback)).toBeInstanceOf(PreferredRuntime);
		expect(selectRuntime("darwin", true, primary, fallback)).toBe(fallback);
		expect(selectRuntime("win32", false, primary, fallback)).toBe(fallback);
	});

	it("does not fall back to secondary when unload() is called while primary.ensureLoaded() is in flight", async () => {
		let rejectPrimaryLoad!: (reason?: unknown) => void;
		const primary: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: vi.fn().mockImplementation(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectPrimaryLoad = reject;
					}),
			),
			generate: vi.fn(),
			unload: vi.fn().mockImplementation(async () => {
				rejectPrimaryLoad?.(new Error("primary aborted by unload"));
			}),
		};
		const fallback: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockResolvedValue(undefined),
			generate: vi.fn(),
			unload: vi.fn().mockResolvedValue(undefined),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		const loadPromise = runtime.ensureLoaded();
		const unloadPromise = runtime.unload();

		await expect(loadPromise).rejects.toThrow("primary aborted by unload");
		await unloadPromise;

		expect(fallback.ensureLoaded).not.toHaveBeenCalled();
		expect(runtime.isReady()).toBe(false);
	});

	it("does not fall back to secondary when unload() is called while primary.generate() is in flight", async () => {
		let rejectPrimaryGenerate!: (reason?: unknown) => void;
		const primary: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockResolvedValue(undefined),
			generate: vi.fn().mockImplementation(
				() =>
					new Promise<string>((_resolve, reject) => {
						rejectPrimaryGenerate = reject;
					}),
			),
			unload: vi.fn().mockImplementation(async () => {
				rejectPrimaryGenerate?.(new Error("generation aborted by unload"));
			}),
		};
		const fallback: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockResolvedValue(undefined),
			generate: vi.fn().mockResolvedValue("fallback result"),
			unload: vi.fn().mockResolvedValue(undefined),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		await runtime.ensureLoaded();

		const genPromise = runtime.generate("prompt", 16);
		const unloadPromise = runtime.unload();

		await expect(genPromise).rejects.toThrow("generation aborted by unload");
		await unloadPromise;

		expect(fallback.ensureLoaded).not.toHaveBeenCalled();
		expect(fallback.generate).not.toHaveBeenCalled();
		expect(runtime.isReady()).toBe(false);
	});

	it("shares a single primary.ensureLoaded() invocation across concurrent ensureLoaded() calls", async () => {
		let resolvePrimaryLoad!: () => void;
		const primary: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						resolvePrimaryLoad = resolve;
					}),
			),
			generate: vi.fn().mockResolvedValue("ok"),
			unload: vi.fn().mockResolvedValue(undefined),
		};
		const fallback: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: vi.fn(),
			generate: vi.fn(),
			unload: vi.fn().mockResolvedValue(undefined),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		const p1 = runtime.ensureLoaded();
		const p2 = runtime.ensureLoaded();

		expect(primary.ensureLoaded).toHaveBeenCalledTimes(1);
		resolvePrimaryLoad();
		await Promise.all([p1, p2]);
		expect(runtime.isReady()).toBe(true);
	});

	it("reloads cleanly when ensureLoaded() is called after unload()", async () => {
		let ready = false;
		const primary: LlmRuntime = {
			isReady: () => ready,
			ensureLoaded: vi.fn().mockImplementation(async () => {
				ready = true;
			}),
			generate: vi.fn().mockResolvedValue("reloaded result"),
			unload: vi.fn().mockImplementation(async () => {
				ready = false;
			}),
		};
		const fallback: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: vi.fn(),
			generate: vi.fn(),
			unload: vi.fn().mockResolvedValue(undefined),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		await runtime.ensureLoaded();
		expect(runtime.isReady()).toBe(true);

		await runtime.unload();
		expect(runtime.isReady()).toBe(false);

		await runtime.ensureLoaded();
		expect(runtime.isReady()).toBe(true);
		await expect(runtime.generate("hello", 8)).resolves.toBe("reloaded result");
		expect(primary.ensureLoaded).toHaveBeenCalledTimes(2);
	});

	it("does not clear activeRuntime when an older unload() settles after a newer ensureLoaded() completes", async () => {
		let resolvePrimaryUnload!: () => void;
		const primary: LlmRuntime = {
			isReady: () => true,
			ensureLoaded: vi.fn().mockResolvedValue(undefined),
			generate: vi.fn().mockResolvedValue("fresh result"),
			unload: vi.fn().mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						resolvePrimaryUnload = resolve;
					}),
			),
		};
		const fallback: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: vi.fn(),
			generate: vi.fn(),
			unload: vi.fn().mockResolvedValue(undefined),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		await runtime.ensureLoaded();
		expect(runtime.isReady()).toBe(true);

		const unloadPromise = runtime.unload();
		expect(runtime.isReady()).toBe(false);

		await runtime.ensureLoaded();
		expect(runtime.isReady()).toBe(true);

		resolvePrimaryUnload();
		await unloadPromise;

		expect(runtime.isReady()).toBe(true);
		await expect(runtime.generate("prompt", 12)).resolves.toBe("fresh result");
	});

	it("rejects unload() after attempting to unload both runtimes if either runtime unload rejects", async () => {
		const primary: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: vi.fn(),
			generate: vi.fn(),
			unload: vi.fn().mockRejectedValue(new Error("primary unload failed")),
		};
		const fallback: LlmRuntime = {
			isReady: () => false,
			ensureLoaded: vi.fn(),
			generate: vi.fn(),
			unload: vi.fn().mockResolvedValue(undefined),
		};

		const runtime = new PreferredRuntime(primary, fallback);
		await expect(runtime.unload()).rejects.toThrow("primary unload failed");
		expect(primary.unload).toHaveBeenCalledTimes(1);
		expect(fallback.unload).toHaveBeenCalledTimes(1);
	});
});
