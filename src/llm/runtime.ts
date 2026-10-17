import type { Wllama } from "@wllama/wllama/esm/index.js";
import fs from "fs";

export interface LlmRuntime {
	isReady(): boolean;
	ensureLoaded(onProgress?: (fraction: number) => void): Promise<void>;
	generate(prompt: string, maxTokens: number): Promise<string>;
	unload(): Promise<void>;
}

export function gpuLayersForModel(_sizeBytes: number): number {
	return 0;
}

class WllamaRecoveryError extends Error {
	constructor(
		readonly generationError: unknown,
		readonly cleanupError: unknown,
	) {
		super("wllama generation and cleanup failed");
		this.name = "WllamaRecoveryError";
	}
}

export class WllamaRuntime implements LlmRuntime {
	private engine: Wllama | null = null;
	private loading: Promise<void> | null = null;

	constructor(
		private readonly modelPath: string,
		private readonly wasmPath: string,
	) {}

	isReady(): boolean {
		return this.engine !== null;
	}

	async ensureLoaded(_onProgress?: (fraction: number) => void): Promise<void> {
		if (this.engine) return;
		this.loading ??= (async () => {
			const modelBlob = await fs.openAsBlob(this.modelPath, { type: "application/octet-stream" });
			const gpuLayers = gpuLayersForModel(modelBlob.size);
			const mod = (await import("@wllama/wllama/esm/index.js")) as {
						Wllama: new (
							config: {
								default: string;
								"single-thread/wllama.wasm"?: string;
								"multi-thread/wllama.wasm"?: string;
							},
							options?: { parallelDownloads?: number; allowOffline?: boolean; suppressNativeLog?: boolean },
						) => Wllama;
			};
			const engine = new mod.Wllama(
							{
								default: this.wasmPath,
								"single-thread/wllama.wasm": this.wasmPath,
								"multi-thread/wllama.wasm": this.wasmPath,
							},
							{
								parallelDownloads: 1,
								allowOffline: true,
								suppressNativeLog: true,
							},
						);
			await engine.loadModel([modelBlob], {
				n_ctx: 2048,
				n_threads: 1,
				n_gpu_layers: gpuLayers,
				flash_attn: false,
			});
			this.engine = engine;
		})();
		try {
			await this.loading;
		} finally {
			this.loading = null;
		}
	}

	async generate(prompt: string, maxTokens: number): Promise<string> {
		await this.ensureLoaded();
		if (!this.engine) throw new Error("wllama failed to load");
		const engine = this.engine;
		try {
			if (engine.getChatTemplate()) {
				const response = await engine.createChatCompletion({
					messages: [{ role: "user", content: prompt }],
					max_tokens: maxTokens,
					temperature: 0.8,
					cache_prompt: false,
					chat_template_kwargs: { enable_thinking: false },
				});
				return (response.choices[0]?.message.content ?? "").replace(/\s*[—–]\s*/gu, " - ");
			}
			const response = await engine.createCompletion({
				prompt,
				max_tokens: maxTokens,
				temperature: 0.8,
				top_p: 0.9,
			});
			return (response.choices[0]?.text ?? "").replace(/\s*[—–]\s*/gu, " - ");
		} catch (generationError) {
			this.engine = null;
			try {
				await engine.exit();
			} catch (cleanupError) {
				throw new WllamaRecoveryError(generationError, cleanupError);
			}
			throw generationError;
		}
	}

	async unload(): Promise<void> {
		await this.engine?.exit();
		this.engine = null;
	}
}
