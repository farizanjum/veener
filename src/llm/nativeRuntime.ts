import type { LlmRuntime } from "./runtime";
import { nativeRuntimeDependencies } from "./nativeRuntimeNode";

export type NativeRuntimeConfig = {
	readonly engineDir: string;
	readonly executablePath: string;
	readonly modelPath: string;
};

export type NativeProcess = {
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	once(event: "exit" | "error", listener: () => void): NativeProcess;
	removeListener(event: "exit", listener: () => void): NativeProcess;
	kill(signal: NodeJS.Signals): boolean;
};

export type NativeRequest = {
	readonly port: number;
	readonly apiKey: string;
	readonly path: string;
	readonly method: "GET" | "POST";
	readonly timeoutMs: number;
	readonly body?: string;
};

export type NativeResponse = {
	readonly statusCode: number | undefined;
	readonly body: string;
};

export type NativeRuntimeDependencies = {
	readonly listDevices: (config: NativeRuntimeConfig) => Promise<string>;
	readonly findAvailablePort: () => Promise<number>;
	readonly randomApiKey: () => string;
	readonly spawnServer: (config: NativeRuntimeConfig, args: readonly string[]) => NativeProcess;
	readonly request: (request: NativeRequest) => Promise<NativeResponse>;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly waitForExit: (process: NativeProcess, timeoutMs: number) => Promise<boolean>;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

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

export class NativeRuntime implements LlmRuntime {
	private process: NativeProcess | null = null;
	private port = 0;
	private apiKey = "";
	private ready = false;
	private loading: Promise<void> | null = null;
	private selectedDevice: string | null = null;

	constructor(
		private readonly config: NativeRuntimeConfig,
		private readonly dependencies: NativeRuntimeDependencies = nativeRuntimeDependencies,
	) {}

	isReady(): boolean {
		return this.ready && this.process !== null && this.process.exitCode === null && this.process.signalCode === null;
	}

	async ensureLoaded(_onProgress?: (fraction: number) => void): Promise<void> {
		if (this.isReady()) return;
		this.loading ??= this.load();
		try {
			await this.loading;
		} finally {
			this.loading = null;
		}
	}

	private async load(): Promise<void> {
		if (this.selectedDevice === null) {
			this.selectedDevice = selectVulkanDevice(await this.dependencies.listDevices(this.config));
		}
		const device = this.selectedDevice;
		if (!device) throw new Error("No Vulkan device found");
		this.port = await this.dependencies.findAvailablePort();
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
		const clearProcess = (): void => {
			this.ready = false;
			if (this.process === process) this.process = null;
		};
		process.once("exit", clearProcess);
		process.once("error", clearProcess);

		try {
			for (let attempt = 0; attempt < 60; attempt += 1) {
				if (this.process !== process || process.exitCode !== null || process.signalCode !== null) {
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
					if (response.statusCode === 200) {
						this.ready = true;
						return;
					}
				} catch (error) {
					if (!(error instanceof Error)) throw error;
				}
				await this.dependencies.sleep(500);
			}
			throw new Error("Native server startup timed out");
		} catch (error) {
			await this.stopProcess(process);
			clearProcess();
			throw error;
		}
	}

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

	async unload(): Promise<void> {
		this.ready = false;
		const process = this.process;
		if (!process) return;
		await this.stopProcess(process);
		if (this.process === process) this.process = null;
	}

	private async stopProcess(process: NativeProcess): Promise<void> {
		if (process.exitCode !== null || process.signalCode !== null) return;
		process.kill("SIGTERM");
		if (await this.dependencies.waitForExit(process, 2_000)) return;
		process.kill("SIGKILL");
		if (!(await this.dependencies.waitForExit(process, 2_000))) {
			throw new Error("Native server did not exit after SIGKILL");
		}
	}
}
