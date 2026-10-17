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
});
