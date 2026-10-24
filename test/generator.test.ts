import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IDLE_UNLOAD_MS, DecoyGenerator } from "../src/llm/generator";
import { validateDecoy } from "../src/llm/validate";
import type { LlmRuntime } from "../src/llm/runtime";

/** Creates a deterministic mock LlmRuntime that yields the provided outputs in order. */
function mockRuntime(outputs: (string | Error)[]): LlmRuntime {
	let index = 0;
	return {
		isReady: () => true,
		ensureLoaded: async () => undefined,
		generate: async () => {
			const next = outputs[Math.min(index++, outputs.length - 1)];
			if (next instanceof Error) throw next;
			return next;
		},
		unload: async () => undefined,
	};
}

/** Creates a deferred promise for controlling async resolution in concurrency tests. */
function createDeferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const GOOD =
	"groceries for the week ahead include oats eggs spinach and a couple of vegetables from the corner shop plus coffee beans and some fruit for the mornings ahead and the weekend trip";
const BAD_SHORT = "too tiny";
const BAD_DASH = `${GOOD} — em dash`;

describe("DecoyGenerator", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses a short output budget for ordinary covers", async () => {
		let requestedTokens = 0;
		const runtime = mockRuntime([GOOD]);
		const generator = new DecoyGenerator({
			runtime: {
				...runtime,
				generate: async (prompt, maxTokens) => {
					requestedTokens = maxTokens;
					return runtime.generate(prompt, maxTokens);
				},
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});

		await generator.generate("grocery list", [], null, 1);

		expect(requestedTokens).toBe(96);
	});

	it("returns the first valid LLM candidate", async () => {
		const generator = new DecoyGenerator({
			runtime: mockRuntime([GOOD]),
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});
		const result = await generator.generate("grocery list", [], null, 1);
		expect(result.source).toBe("llm");
		expect(result.text).toBe(GOOD);
		expect(result.attempts).toBe(1);
	});

	it("retries after invalid candidates and counts attempts", async () => {
		const generator = new DecoyGenerator({
			runtime: mockRuntime([BAD_SHORT, BAD_DASH, GOOD]),
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});
		const result = await generator.generate("grocery list", [], null, 1);
		expect(result.source).toBe("llm");
		expect(result.attempts).toBe(3);
	});

	it("falls back to a template when every candidate fails", async () => {
		const generator = new DecoyGenerator({
			runtime: mockRuntime([BAD_SHORT, BAD_SHORT, BAD_SHORT]),
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: (seed) => `TEMPLATE-${seed}`,
			maxAttempts: 3,
		});
		const result = await generator.generate("grocery list", [], null, 7);
		expect(result.source).toBe("template");
		expect(result.text).toBe("TEMPLATE-7");
	});

	it("falls back immediately when the runtime throws", async () => {
		const generator = new DecoyGenerator({
			runtime: mockRuntime([new Error("model crashed")]),
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});
		const result = await generator.generate("grocery list", [], null, 1);
		expect(result.source).toBe("template");
	});

	it("uses the template directly when no runtime exists", async () => {
		const generator = new DecoyGenerator({
			runtime: null,
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});
		const result = await generator.generate("grocery list", [], null, 1);
		expect(result.source).toBe("template");
	});

	it("automatically unloads the runtime after 5 minutes of inactivity following generate()", async () => {
		vi.useFakeTimers();
		const unload = vi.fn(async () => undefined);
		const generator = new DecoyGenerator({
			runtime: {
				...mockRuntime([GOOD]),
				unload,
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});

		await generator.generate("grocery list", [], null, 1);
		expect(unload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS - 1);
		expect(unload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(unload).toHaveBeenCalledTimes(1);
	});

	it("automatically unloads after warmup() inactivity and does not arm the timer if ensureLoaded() rejects", async () => {
		vi.useFakeTimers();
		const unloadSuccess = vi.fn(async () => undefined);
		const generatorSuccess = new DecoyGenerator({
			runtime: {
				...mockRuntime([GOOD]),
				unload: unloadSuccess,
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});

		generatorSuccess.warmup();
		await vi.advanceTimersByTimeAsync(0);
		expect(unloadSuccess).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS);
		expect(unloadSuccess).toHaveBeenCalledTimes(1);

		const unloadFailure = vi.fn(async () => undefined);
		const generatorFailure = new DecoyGenerator({
			runtime: {
				...mockRuntime([GOOD]),
				ensureLoaded: async () => {
					throw new Error("failed to load");
				},
				unload: unloadFailure,
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});

		generatorFailure.warmup();
		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS * 2);
		expect(unloadFailure).not.toHaveBeenCalled();
	});

	it("resets the 5-minute idle countdown on new generate() and never unloads while generate() is in flight", async () => {
		vi.useFakeTimers();
		const unload = vi.fn(async () => undefined);
		const slowGenerateGate = createDeferred<string>();
		let callCount = 0;

		const generator = new DecoyGenerator({
			runtime: {
				isReady: () => true,
				ensureLoaded: async () => undefined,
				generate: async () => {
					callCount += 1;
					if (callCount === 3) {
						return slowGenerateGate.promise;
					}
					return GOOD;
				},
				unload,
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});

		await generator.generate("grocery list", [], null, 1);
		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS - 10_000);
		expect(unload).not.toHaveBeenCalled();

		await generator.generate("grocery list", [], null, 2);
		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS - 10_000);
		expect(unload).not.toHaveBeenCalled();

		const inFlightPromise = generator.generate("grocery list", [], null, 3);
		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS * 3);
		expect(unload).not.toHaveBeenCalled();

		slowGenerateGate.resolve(GOOD);
		const result = await inFlightPromise;
		expect(result.source).toBe("llm");
		expect(unload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS - 1);
		expect(unload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(unload).toHaveBeenCalledTimes(1);
	});

	it("serializes concurrent generate() and warmup() calls through the single-flight mutex", async () => {
		const warmupGate = createDeferred<void>();
		const firstGenGate = createDeferred<string>();
		const secondGenGate = createDeferred<string>();
		const events: string[] = [];
		let activeGenerateCalls = 0;
		let maxConcurrentGenerateCalls = 0;
		let genCallIndex = 0;

		const generator = new DecoyGenerator({
			runtime: {
				isReady: () => true,
				ensureLoaded: async () => {
					events.push("warmup:start");
					await warmupGate.promise;
					events.push("warmup:end");
				},
				generate: async () => {
					genCallIndex += 1;
					const currentIndex = genCallIndex;
					activeGenerateCalls += 1;
					maxConcurrentGenerateCalls = Math.max(maxConcurrentGenerateCalls, activeGenerateCalls);
					events.push(`generate:${currentIndex}:start`);
					try {
						if (currentIndex === 1) {
							return await firstGenGate.promise;
						}
						return await secondGenGate.promise;
					} finally {
						activeGenerateCalls -= 1;
						events.push(`generate:${currentIndex}:end`);
					}
				},
				unload: async () => undefined,
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});

		generator.warmup();
		const gen1Promise = generator.generate("grocery list", [], null, 1);
		const gen2Promise = generator.generate("grocery list", [], null, 2);

		await Promise.resolve();
		expect(events).toEqual(["warmup:start"]);

		warmupGate.resolve();
		await vi.waitFor(() => {
			expect(events).toContain("generate:1:start");
		});
		expect(events).toEqual(["warmup:start", "warmup:end", "generate:1:start"]);

		firstGenGate.resolve(GOOD);
		await vi.waitFor(() => {
			expect(events).toContain("generate:2:start");
		});
		expect(events).toEqual([
			"warmup:start",
			"warmup:end",
			"generate:1:start",
			"generate:1:end",
			"generate:2:start",
		]);

		secondGenGate.resolve(GOOD);
		const [res1, res2] = await Promise.all([gen1Promise, gen2Promise]);
		expect(res1.source).toBe("llm");
		expect(res2.source).toBe("llm");
		expect(maxConcurrentGenerateCalls).toBe(1);
		expect(events).toEqual([
			"warmup:start",
			"warmup:end",
			"generate:1:start",
			"generate:1:end",
			"generate:2:start",
			"generate:2:end",
		]);
	});

	it("clears pending idle timer on unload(), aborts remaining retries mid-generation, and allows subsequent generate()", async () => {
		vi.useFakeTimers();
		const unload = vi.fn(async () => undefined);
		const midAttemptGate = createDeferred<string>();
		let generateCalls = 0;

		const generator = new DecoyGenerator({
			runtime: {
				isReady: () => true,
				ensureLoaded: async () => undefined,
				generate: async () => {
					generateCalls += 1;
					if (generateCalls === 2) {
						return midAttemptGate.promise;
					}
					return GOOD;
				},
				unload,
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: (seed) => `TEMPLATE-${seed}`,
			maxAttempts: 3,
		});

		const firstResult = await generator.generate("grocery list", [], null, 1);
		expect(firstResult.source).toBe("llm");
		await generator.unload();
		expect(unload).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS * 2);
		expect(unload).toHaveBeenCalledTimes(1);

		const abortedPromise = generator.generate("grocery list", [], null, 2);
		await vi.waitFor(() => {
			expect(generateCalls).toBe(2);
		});

		const unloadPromise = generator.unload();
		midAttemptGate.resolve(BAD_SHORT);
		const [abortedResult] = await Promise.all([abortedPromise, unloadPromise]);

		expect(abortedResult.source).toBe("template");
		expect(abortedResult.text).toBe("TEMPLATE-2");
		expect(abortedResult.error).toBe("generator unloaded");
		expect(generateCalls).toBe(2);
		expect(unload).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS * 2);
		expect(unload).toHaveBeenCalledTimes(2);

		const recoveredResult = await generator.generate("grocery list", [], null, 3);
		expect(recoveredResult.source).toBe("llm");
		expect(recoveredResult.text).toBe(GOOD);
		expect(generateCalls).toBe(3);

		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS);
		expect(unload).toHaveBeenCalledTimes(3);
	});

	it("arms the idle timer when the last queued operation finishes even if an earlier warmup or generate touched the runtime", async () => {
		vi.useFakeTimers();
		const unload = vi.fn(async () => undefined);
		const genGate = createDeferred<string>();
		let ensureLoadedCalls = 0;

		const generator = new DecoyGenerator({
			runtime: {
				isReady: () => true,
				ensureLoaded: async () => {
					ensureLoadedCalls += 1;
					if (ensureLoadedCalls === 1) {
						throw new Error("queued warmup failed after generate touched runtime");
					}
				},
				generate: () => genGate.promise,
				unload,
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});

		const genPromise = generator.generate("grocery list", [], null, 1);
		generator.warmup();

		genGate.resolve(GOOD);
		const result = await genPromise;
		expect(result.source).toBe("llm");

		await vi.advanceTimersByTimeAsync(0);
		expect(unload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_UNLOAD_MS);
		expect(unload).toHaveBeenCalledTimes(1);
	});
});
