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

const CONFIG = {
	engineDir: "/engine",
	executablePath: "/engine/llama-server.exe",
	modelPath: "/model.gguf",
} as const;

class FakeProcess extends EventEmitter implements NativeProcess {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly signals: NodeJS.Signals[] = [];

	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		return true;
	}
}

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
});
