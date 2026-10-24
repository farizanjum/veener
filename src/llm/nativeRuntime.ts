import type { LlmRuntime } from "./runtime";
import { nativeRuntimeDependencies } from "./nativeRuntimeNode";

/** Configuration paths for launching the native `llama-server` executable and GGUF model. */
export type NativeRuntimeConfig = {
	readonly engineDir: string;
	readonly executablePath: string;
	readonly modelPath: string;
};

/** Minimal child-process handle required by `NativeRuntime` to monitor and terminate `llama-server`. */
export type NativeProcess = {
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	once(event: "exit" | "error", listener: () => void): NativeProcess;
	removeListener(event: "exit" | "error", listener: () => void): NativeProcess;
	kill(signal: NodeJS.Signals): boolean;
};

/** Loopback HTTP request options for communicating with `llama-server`. */
export type NativeRequest = {
	readonly port: number;
	readonly apiKey: string;
	readonly path: string;
	readonly method: "GET" | "POST";
	readonly timeoutMs: number;
	readonly body?: string;
};

/** Loopback HTTP response payload returned from `llama-server`. */
export type NativeResponse = {
	readonly statusCode: number | undefined;
	readonly body: string;
};

/** Injectable OS process, network, timer, and exit-hook dependencies for `NativeRuntime`. */
export type NativeRuntimeDependencies = {
	readonly listDevices: (config: NativeRuntimeConfig) => Promise<string>;
	readonly findAvailablePort: () => Promise<number>;
	readonly randomApiKey: () => string;
	readonly spawnServer: (config: NativeRuntimeConfig, args: readonly string[]) => NativeProcess;
	readonly request: (request: NativeRequest) => Promise<NativeResponse>;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly waitForExit: (process: NativeProcess, timeoutMs: number) => Promise<boolean>;
	readonly registerExitHook?: (onExit: () => void) => () => void;
};

/**
 * Parses `llama-server --list-devices` output and prefers a discrete NVIDIA Vulkan device when present.
 */
export function selectVulkanDevice(output: string): string | null {
	let firstDevice: string | null = null;
	for (const line of output.split(/\r?\n/u)) {
		const match = /^\s*(Vulkan\d+):\s+(.+)$/u.exec(line);
		if (!match) continue;
		const device = match[1];
		const name = match[2];
		if (!device || !name) continue;
		firstDevice ??= device;
		if (name.toLowerCase().includes("nvidia")) return device;
	}
	return firstDevice;
}

/**
 * Type guard checking whether an unknown value is a non-null object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Extracts the assistant completion text from an OpenAI-compatible `/v1/chat/completions` JSON response
 * and normalizes Unicode em/en dashes to ASCII hyphens.
 */
export function parseChatContent(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Native server returned invalid JSON");
	}
	if (!isRecord(parsed) || !Array.isArray(parsed["choices"])) {
		throw new Error("Native server response is missing choices");
	}
	const choice: unknown = parsed["choices"][0];
	if (!isRecord(choice) || !isRecord(choice["message"])) {
		throw new Error("Native server response is missing a message");
	}
	const content = choice["message"]["content"];
	if (typeof content !== "string" || content.length === 0) {
		throw new Error("Native server response has no content");
	}
	return content.replace(/\s*[—–]\s*/gu, " - ");
}

/**
 * Manages the lifecycle of a local `llama-server` Vulkan GPU process over an authenticated loopback port.
 */
export class NativeRuntime implements LlmRuntime {
	private process: NativeProcess | null = null;
	private port = 0;
	private apiKey = "";
	private ready = false;
	private loading: Promise<void> | null = null;
	private selectedDevice: string | null = null;
	private loadEpoch = 0;
	private readonly stopPromises = new WeakMap<NativeProcess, Promise<void>>();
	private readonly terminatedProcesses = new WeakSet<NativeProcess>();
	private readonly exitHookCleanups = new WeakMap<NativeProcess, () => void>();

	/**
	 * Creates a `NativeRuntime` bound to the given engine/model paths and injectable runtime dependencies.
	 */
	constructor(
		private readonly config: NativeRuntimeConfig,
		private readonly dependencies: NativeRuntimeDependencies = nativeRuntimeDependencies,
	) {}

	/**
	 * Returns `true` when the native server process is running, healthy, and has not been terminated.
	 */
	isReady(): boolean {
		return (
			this.ready &&
			this.process !== null &&
			this.process.exitCode === null &&
			this.process.signalCode === null &&
			!this.terminatedProcesses.has(this.process)
		);
	}

	/**
	 * Ensures the native `llama-server` process is spawned and passing `/health` checks, deduplicating concurrent loads.
	 */
	async ensureLoaded(_onProgress?: (fraction: number) => void): Promise<void> {
		if (this.isReady()) return;
		const loadPromise = (this.loading ??= this.load(this.loadEpoch));
		try {
			await loadPromise;
		} finally {
			if (this.loading === loadPromise) {
				this.loading = null;
			}
		}
	}

	/**
	 * Discovers a Vulkan device, allocates a loopback port, spawns `llama-server`, and polls `/health` until ready.
	 * Aborts immediately if `loadEpoch` advances due to a concurrent `unload()`.
	 */
	private async load(epoch: number): Promise<void> {
		if (this.loadEpoch !== epoch) throw new Error("Native server unloaded during startup");
		if (this.selectedDevice === null) {
			const devicesOutput = await this.dependencies.listDevices(this.config);
			if (this.loadEpoch !== epoch) throw new Error("Native server unloaded during startup");
			this.selectedDevice = selectVulkanDevice(devicesOutput);
		}
		const device = this.selectedDevice;
		if (!device) throw new Error("No Vulkan device found");
		const port = await this.dependencies.findAvailablePort();
		if (this.loadEpoch !== epoch) throw new Error("Native server unloaded during startup");
		this.port = port;
		this.apiKey = this.dependencies.randomApiKey();
		const args = [
			"--model", this.config.modelPath,
			"--port", String(this.port),
			"--host", "127.0.0.1",
			"--api-key", this.apiKey,
			"--device", device,
			"--gpu-layers", "all",
			"--threads", "8",
			"--ctx-size", "2048",
			"--parallel", "1",
			"--reasoning", "off",
			"--no-warmup",
			"--no-webui",
			"--offline",
			"--log-disable",
		] as const;
		const process = this.dependencies.spawnServer(this.config, args);
		this.process = process;
		const registerExitHook = this.dependencies.registerExitHook ?? nativeRuntimeDependencies.registerExitHook;
		const cleanupExitHook = registerExitHook?.(() => {
			if (
				process.exitCode === null &&
				process.signalCode === null &&
				!this.terminatedProcesses.has(process)
			) {
				this.terminatedProcesses.add(process);
				try {
					process.kill("SIGKILL");
				} catch {
					// Ignore kill errors during synchronous process exit
				}
			}
		});
		if (cleanupExitHook) {
			this.exitHookCleanups.set(process, cleanupExitHook);
		}
		const clearProcess = (): void => {
			process.removeListener("exit", clearProcess);
			process.removeListener("error", clearProcess);
			this.terminatedProcesses.add(process);
			if (this.process === process) {
				this.ready = false;
				this.process = null;
			}
			const cleanup = this.exitHookCleanups.get(process);
			if (cleanup) {
				this.exitHookCleanups.delete(process);
				cleanup();
			}
		};
		process.once("exit", clearProcess);
		process.once("error", clearProcess);

		try {
			for (let attempt = 0; attempt < 60; attempt += 1) {
				if (this.loadEpoch !== epoch) {
					throw new Error("Native server unloaded during startup");
				}
				if (
					this.process !== process ||
					process.exitCode !== null ||
					process.signalCode !== null ||
					this.terminatedProcesses.has(process)
				) {
					throw new Error("Native server exited during startup");
				}
				try {
					const response = await this.dependencies.request({
						port: this.port,
						apiKey: this.apiKey,
						path: "/health",
						method: "GET",
						timeoutMs: 1_000,
					});
					if (this.loadEpoch !== epoch) {
						throw new Error("Native server unloaded during startup");
					}
					if (response.statusCode === 200) {
						if (this.loadEpoch !== epoch) {
							throw new Error("Native server unloaded during startup");
						}
						this.ready = true;
						return;
					}
				} catch (error) {
					if (this.loadEpoch !== epoch) {
						throw new Error("Native server unloaded during startup");
					}
					if (!(error instanceof Error)) throw error;
				}
				await this.dependencies.sleep(500);
				if (this.loadEpoch !== epoch) {
					throw new Error("Native server unloaded during startup");
				}
			}
			throw new Error("Native server startup timed out");
		} catch (error) {
			await this.stopProcess(process).catch(() => undefined);
			clearProcess();
			throw error;
		}
	}

	/**
	 * Sends a chat completion request to the running `llama-server` instance and returns the normalized text.
	 */
	async generate(prompt: string, maxTokens: number): Promise<string> {
		await this.ensureLoaded();
		if (!this.isReady()) throw new Error("Native server is not ready");
		const body = JSON.stringify({
			messages: [{ role: "user", content: prompt }],
			max_tokens: maxTokens,
			temperature: 0.8,
			top_k: 20,
			top_p: 0.9,
			repeat_penalty: 1.1,
			chat_template_kwargs: { enable_thinking: false },
		});
		const response = await this.dependencies.request({
			port: this.port,
			apiKey: this.apiKey,
			path: "/v1/chat/completions",
			method: "POST",
			timeoutMs: 60_000,
			body,
		});
		if (response.statusCode !== 200) {
			throw new Error(`Native server returned HTTP ${response.statusCode ?? "unknown"}`);
		}
		return parseChatContent(response.body);
	}

	/**
	 * Synchronously fences in-flight loads and initiates process termination, then awaits full shutdown settlement.
	 */
	async unload(): Promise<void> {
		this.loadEpoch += 1;
		this.ready = false;
		const process = this.process;
		this.process = null;
		const pendingLoad = this.loading;
		this.loading = null;
		const stopTask = process ? this.stopProcess(process) : null;
		try {
			if (stopTask) {
				await stopTask;
			}
		} finally {
			if (process) {
				const cleanup = this.exitHookCleanups.get(process);
				if (cleanup) {
					this.exitHookCleanups.delete(process);
					cleanup();
				}
			}
			if (pendingLoad) {
				await pendingLoad.catch(() => undefined);
			}
		}
	}

	/**
	 * Terminates a native child process using `SIGTERM` followed by `SIGKILL` fallback, deduplicating concurrent calls.
	 */
	private stopProcess(process: NativeProcess): Promise<void> {
		const existing = this.stopPromises.get(process);
		if (existing) return existing;
		if (
			process.exitCode !== null ||
			process.signalCode !== null ||
			this.terminatedProcesses.has(process)
		) {
			return Promise.resolve();
		}
		const task = (async (): Promise<void> => {
			try {
				process.kill("SIGTERM");
				if (await this.dependencies.waitForExit(process, 2_000)) return;
				process.kill("SIGKILL");
				if (!(await this.dependencies.waitForExit(process, 2_000))) {
					throw new Error("Native server did not exit after SIGKILL");
				}
			} finally {
				this.terminatedProcesses.add(process);
				const cleanup = this.exitHookCleanups.get(process);
				if (cleanup) {
					this.exitHookCleanups.delete(process);
					cleanup();
				}
				this.stopPromises.delete(process);
			}
		})();
		this.stopPromises.set(process, task);
		return task;
	}
}
