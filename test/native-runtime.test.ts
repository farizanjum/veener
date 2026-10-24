import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	NativeRuntime,
	parseChatContent,
	selectVulkanDevice,
	type NativeProcess,
	type NativeRequest,
	type NativeResponse,
	type NativeRuntimeDependencies,
} from "../src/llm/nativeRuntime";
import { LIST_DEVICES_TIMEOUT_MS, listDevices, registerExitHook } from "../src/llm/nativeRuntimeNode";

const CONFIG = {
	engineDir: "/engine",
	executablePath: "/engine/llama-server.exe",
	modelPath: "/model.gguf",
} as const;

/**
 * In-memory fake `NativeProcess` that records termination signals without spawning an OS child process.
 */
class FakeProcess extends EventEmitter implements NativeProcess {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly signals: NodeJS.Signals[] = [];

	/**
	 * Records the received termination signal and returns `true`.
	 */
	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		return true;
	}
}

/**
 * Creates an isolated `NativeRuntime` test harness with inspectable fake process, requests, and dependency mocks.
 */
function createHarness(requestOverride?: (request: NativeRequest) => Promise<NativeResponse>): {
	readonly runtime: NativeRuntime;
	readonly process: FakeProcess;
	readonly requests: NativeRequest[];
	readonly spawnedArgs: readonly string[][];
	readonly waitForExit: ReturnType<typeof vi.fn>;
} {
	const process = new FakeProcess();
	const requests: NativeRequest[] = [];
	const spawnedArgs: string[][] = [];
	const waitForExit = vi.fn(async () => true);
	const dependencies: NativeRuntimeDependencies = {
		listDevices: async () =>
			"Available devices:\n  Vulkan0: Intel Graphics\n  Vulkan1: NVIDIA GeForce RTX 4050 Laptop GPU\n",
		findAvailablePort: async () => 43_123,
		randomApiKey: () => "0123456789abcdef0123456789abcdef",
		spawnServer: (_config, args) => {
			spawnedArgs.push([...args]);
			return process;
		},
		request: requestOverride ?? (async (request) => {
			requests.push(request);
			if (request.path === "/health") return { statusCode: 200, body: "" };
			return { statusCode: 200, body: '{"choices":[{"message":{"content":"world"}}]}' };
		}),
		sleep: async () => undefined,
		waitForExit,
	};
	return {
		runtime: new NativeRuntime(CONFIG, dependencies),
		process,
		requests,
		spawnedArgs,
		waitForExit,
	};
}

describe("NativeRuntime", () => {
	it("selects the NVIDIA Vulkan device from b10208 output", () => {
		const output = "Available devices:\n  Vulkan0: Intel Graphics\n  Vulkan1: NVIDIA GeForce RTX 4050 Laptop GPU\n";
		expect(selectVulkanDevice(output)).toBe("Vulkan1");
	});

	it("starts an authenticated loopback server with Vulkan reasoning disabled", async () => {
		const harness = createHarness();
		await harness.runtime.ensureLoaded();

		expect(harness.spawnedArgs[0]).toEqual(expect.arrayContaining([
			"--host", "127.0.0.1",
			"--device", "Vulkan1",
			"--gpu-layers", "all",
			"--reasoning", "off",
		]));
		expect(harness.requests[0]).toMatchObject({
			port: 43_123,
			apiKey: "0123456789abcdef0123456789abcdef",
			path: "/health",
		});
	});

	it("returns generated message content", async () => {
		const harness = createHarness();
		await expect(harness.runtime.generate("hello", 50)).resolves.toBe("world");
		const generationRequest = harness.requests.find((request) => request.method === "POST");
		expect(generationRequest?.body).toContain('"max_tokens":50');
		expect(generationRequest?.body).toContain('"top_k":20');
		expect(generationRequest?.body).toContain('"top_p":0.9');
		expect(generationRequest?.body).toContain('"repeat_penalty":1.1');
	});

	it("normalizes Unicode em and en dashes to plain hyphens in parseChatContent", () => {
		const body = JSON.stringify({
			choices: [{ message: { content: "Meeting notes — call w/ team – follow up tomorrow" } }],
		});
		expect(parseChatContent(body)).toBe("Meeting notes - call w/ team - follow up tomorrow");
	});

	it("retries health checks while the server is still binding", async () => {
		let attempt = 0;
		const harness = createHarness(async () => {
			attempt += 1;
			if (attempt === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:43123");
			return { statusCode: 200, body: "" };
		});

		await expect(harness.runtime.ensureLoaded()).resolves.toBeUndefined();
		expect(attempt).toBe(2);
		expect(harness.runtime.isReady()).toBe(true);
	});

	it("rejects malformed completion responses", () => {
		expect(() => parseChatContent('{"choices":[]}')).toThrow("missing a message");
		expect(() => parseChatContent("not json")).toThrow("invalid JSON");
	});

	it("waits for forced termination when graceful shutdown times out", async () => {
		const harness = createHarness();
		harness.waitForExit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		await harness.runtime.ensureLoaded();
		await harness.runtime.unload();

		expect(harness.process.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(harness.waitForExit).toHaveBeenCalledTimes(2);
		expect(harness.runtime.isReady()).toBe(false);
	});

	it("aborts ensureLoaded without spawning llama-server if unload() is called during listDevices or findAvailablePort", async () => {
		let resolveDevices!: (value: string) => void;
		const spawnServer = vi.fn(() => new FakeProcess());
		const runtimeDuringDevices = new NativeRuntime(CONFIG, {
			listDevices: () => new Promise<string>((resolve) => {
				resolveDevices = resolve;
			}),
			findAvailablePort: async () => 43_123,
			randomApiKey: () => "key",
			spawnServer,
			request: async () => ({ statusCode: 200, body: "" }),
			sleep: async () => undefined,
			waitForExit: async () => true,
		});

		const loadPromise1 = runtimeDuringDevices.ensureLoaded();
		const unloadPromise1 = runtimeDuringDevices.unload();
		resolveDevices("Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4050\n");

		await expect(loadPromise1).rejects.toThrow("Native server unloaded during startup");
		await expect(unloadPromise1).resolves.toBeUndefined();
		expect(spawnServer).not.toHaveBeenCalled();
		expect(runtimeDuringDevices.isReady()).toBe(false);

		let resolvePort!: (value: number) => void;
		const runtimeDuringPort = new NativeRuntime(CONFIG, {
			listDevices: async () => "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4050\n",
			findAvailablePort: () => new Promise<number>((resolve) => {
				resolvePort = resolve;
			}),
			randomApiKey: () => "key",
			spawnServer,
			request: async () => ({ statusCode: 200, body: "" }),
			sleep: async () => undefined,
			waitForExit: async () => true,
		});

		const loadPromise2 = runtimeDuringPort.ensureLoaded();
		await Promise.resolve();
		const unloadPromise2 = runtimeDuringPort.unload();
		resolvePort(43_124);

		await expect(loadPromise2).rejects.toThrow("Native server unloaded during startup");
		await expect(unloadPromise2).resolves.toBeUndefined();
		expect(spawnServer).not.toHaveBeenCalled();
		expect(runtimeDuringPort.isReady()).toBe(false);
	});

	it("aborts ensureLoaded and kills the spawned process exactly once if unload() is called during /health polling", async () => {
		const proc = new FakeProcess();
		let resolveHealth!: (response: NativeResponse) => void;
		const waitForExit = vi.fn(async () => true);
		const runtime = new NativeRuntime(CONFIG, {
			listDevices: async () => "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4050\n",
			findAvailablePort: async () => 43_123,
			randomApiKey: () => "key",
			spawnServer: () => proc,
			request: () => new Promise<NativeResponse>((resolve) => {
				resolveHealth = resolve;
			}),
			sleep: async () => undefined,
			waitForExit,
		});

		const loadPromise = runtime.ensureLoaded();
		for (let i = 0; i < 5 && !resolveHealth; i += 1) {
			await Promise.resolve();
		}

		const unloadPromise = runtime.unload();
		resolveHealth({ statusCode: 200, body: "" });

		await expect(loadPromise).rejects.toThrow("Native server unloaded during startup");
		await expect(unloadPromise).resolves.toBeUndefined();
		expect(proc.signals).toEqual(["SIGTERM"]);
		expect(waitForExit).toHaveBeenCalledTimes(1);
		expect(runtime.isReady()).toBe(false);
	});

	it("sends SIGTERM synchronously inside unload() before yielding to any microtask", async () => {
		const harness = createHarness();
		await harness.runtime.ensureLoaded();
		expect(harness.process.signals).toEqual([]);

		const unloadPromise = harness.runtime.unload();
		expect(harness.process.signals).toEqual(["SIGTERM"]);
		expect(harness.runtime.isReady()).toBe(false);
		await unloadPromise;
	});

	it("kills the active process with SIGKILL on synchronous host exit and cleans up exit hooks without leaking across cycles", async () => {
		const processes: FakeProcess[] = [];
		const activeExitCallbacks = new Set<() => void>();
		const cleanupSpy = vi.fn();

		const runtime = new NativeRuntime(CONFIG, {
			listDevices: async () => "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4050\n",
			findAvailablePort: async () => 43_123,
			randomApiKey: () => "key",
			spawnServer: () => {
				const proc = new FakeProcess();
				processes.push(proc);
				return proc;
			},
			request: async () => ({ statusCode: 200, body: "" }),
			sleep: async () => undefined,
			waitForExit: async () => true,
			registerExitHook: (onExit) => {
				activeExitCallbacks.add(onExit);
				return () => {
					if (activeExitCallbacks.delete(onExit)) {
						cleanupSpy();
					}
				};
			},
		});

		await runtime.ensureLoaded();
		expect(activeExitCallbacks.size).toBe(1);
		await runtime.unload();
		expect(activeExitCallbacks.size).toBe(0);
		expect(cleanupSpy).toHaveBeenCalledTimes(1);

		await runtime.ensureLoaded();
		expect(processes).toHaveLength(2);
		expect(activeExitCallbacks.size).toBe(1);

		for (const onExit of activeExitCallbacks) {
			onExit();
		}
		expect(processes[1]!.signals).toEqual(["SIGKILL"]);
		expect(runtime.isReady()).toBe(false);

		await runtime.unload();
		expect(activeExitCallbacks.size).toBe(0);
		expect(cleanupSpy).toHaveBeenCalledTimes(2);
	});

	it("reloads cleanly and spawns a fresh server process when ensureLoaded() is called after unload()", async () => {
		const processes: FakeProcess[] = [];
		const runtime = new NativeRuntime(CONFIG, {
			listDevices: async () => "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4050\n",
			findAvailablePort: async () => 43_123 + processes.length,
			randomApiKey: () => "key",
			spawnServer: () => {
				const proc = new FakeProcess();
				processes.push(proc);
				return proc;
			},
			request: async () => ({ statusCode: 200, body: "" }),
			sleep: async () => undefined,
			waitForExit: async () => true,
		});

		await runtime.ensureLoaded();
		expect(runtime.isReady()).toBe(true);
		expect(processes).toHaveLength(1);

		await runtime.unload();
		expect(runtime.isReady()).toBe(false);
		expect(processes[0]!.signals).toEqual(["SIGTERM"]);

		await runtime.ensureLoaded();
		expect(runtime.isReady()).toBe(true);
		expect(processes).toHaveLength(2);
		expect(processes[1]!.signals).toEqual([]);

		processes[0]!.emit("exit");
		expect(runtime.isReady()).toBe(true);
		expect(processes[0]!.listenerCount("exit")).toBe(0);
		expect(processes[0]!.listenerCount("error")).toBe(0);
	});

	it("starts a fresh load when ensureLoaded() is called while unload() is still awaiting an aborted startup", async () => {
		const processes: FakeProcess[] = [];
		let resolveFirstDevices!: (value: string) => void;
		let listCalls = 0;
		const runtime = new NativeRuntime(CONFIG, {
			listDevices: () => {
				listCalls += 1;
				if (listCalls === 1) {
					return new Promise<string>((resolve) => {
						resolveFirstDevices = resolve;
					});
				}
				return Promise.resolve("Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4050\n");
			},
			findAvailablePort: async () => 43_123 + processes.length,
			randomApiKey: () => "key",
			spawnServer: () => {
				const proc = new FakeProcess();
				processes.push(proc);
				return proc;
			},
			request: async () => ({ statusCode: 200, body: "" }),
			sleep: async () => undefined,
			waitForExit: async () => true,
		});

		const firstLoad = runtime.ensureLoaded();
		const unloadPromise = runtime.unload();
		const secondLoad = runtime.ensureLoaded();

		await expect(secondLoad).resolves.toBeUndefined();
		expect(runtime.isReady()).toBe(true);

		resolveFirstDevices("Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4050\n");
		await expect(firstLoad).rejects.toThrow("Native server unloaded during startup");
		await expect(unloadPromise).resolves.toBeUndefined();
		expect(runtime.isReady()).toBe(true);
	});

	it("registers and removes process exit and window unload listeners cleanly via registerExitHook", () => {
		const beforeCount = process.listenerCount("exit");
		const windowListeners = new Map<string, () => void>();
		const addEventListener = vi.fn((event: string, fn: () => void) => {
			windowListeners.set(event, fn);
		});
		const removeEventListener = vi.fn((event: string) => {
			windowListeners.delete(event);
		});
		const originalWindow = (globalThis as { window?: unknown }).window;
		(globalThis as { window?: unknown }).window = {
			addEventListener,
			removeEventListener,
		};

		try {
			const onExit = vi.fn();
			const cleanup = registerExitHook(onExit);
			expect(process.listenerCount("exit")).toBe(beforeCount + 1);
			expect(addEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
			expect(addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));

			cleanup();
			cleanup();
			expect(process.listenerCount("exit")).toBe(beforeCount);
			expect(removeEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
			expect(removeEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
			expect(onExit).not.toHaveBeenCalled();

			const onWindowExit = vi.fn();
			registerExitHook(onWindowExit);
			expect(process.listenerCount("exit")).toBe(beforeCount + 1);
			windowListeners.get("pagehide")?.();
			expect(onWindowExit).toHaveBeenCalledTimes(1);
			expect(process.listenerCount("exit")).toBe(beforeCount);
			expect(windowListeners.size).toBe(0);
		} finally {
			if (originalWindow === undefined) {
				delete (globalThis as { window?: unknown }).window;
			} else {
				(globalThis as { window?: unknown }).window = originalWindow;
			}
		}
	});

	it("times out listDevices when the discovery process hangs", async () => {
		expect(LIST_DEVICES_TIMEOUT_MS).toBe(10_000);
		await expect(
			listDevices(
				{
					engineDir: process.cwd(),
					executablePath: process.execPath,
					modelPath: "/model.gguf",
				},
				25,
			),
		).rejects.toThrow("Vulkan device discovery timed out");
	});
});
