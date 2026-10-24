import type { Wllama } from "@wllama/wllama/esm/index.js";
import fs from "fs";

export interface LlmRuntime {
	isReady(): boolean;
	ensureLoaded(onProgress?: (fraction: number) => void): Promise<void>;
	generate(prompt: string, maxTokens: number): Promise<string>;
	unload(): Promise<void>;
}

/** Returns the number of GPU layers to offload for a model of the given byte size. */
export function gpuLayersForModel(_sizeBytes: number): number {
	return 0;
}

/** Error thrown when both wllama generation and subsequent worker cleanup fail. */
class WllamaRecoveryError extends Error {
	constructor(
		readonly generationError: unknown,
		readonly cleanupError: unknown,
	) {
		super("wllama generation and cleanup failed");
		this.name = "WllamaRecoveryError";
	}
}

/** WebAssembly-backed LLM runtime using @wllama/wllama. */
export class WllamaRuntime implements LlmRuntime {
	private engine: Wllama | null = null;
	private loadingEngine: Wllama | null = null;
	private loading: Promise<void> | null = null;
	private loadEpoch = 0;
	private readonly exitedEngines = new WeakSet<object>();

	constructor(
		private readonly modelPath: string,
		private readonly wasmPath: string,
	) {}

	/** Returns true when the wllama engine is loaded and ready for inference. */
	isReady(): boolean {
		return this.engine !== null;
	}

	/** Loads the GGUF model into a wllama worker if not already loaded. */
	async ensureLoaded(_onProgress?: (fraction: number) => void): Promise<void> {
		if (this.engine) return;
		const epoch = this.loadEpoch;
		const loadPromise = (this.loading ??= (async () => {
			const modelBlob = await fs.openAsBlob(this.modelPath, { type: "application/octet-stream" });
			if (this.loadEpoch !== epoch) {
				throw new Error("wllama runtime unloaded during startup");
			}
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
			if (this.loadEpoch !== epoch) {
				throw new Error("wllama runtime unloaded during startup");
			}
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
			this.loadingEngine = engine;
			try {
				await engine.loadModel([modelBlob], {
					n_ctx: 2048,
					n_threads: 1,
					n_gpu_layers: gpuLayers,
					flash_attn: false,
				});
			} catch (loadError) {
				if (!this.exitedEngines.has(engine)) {
					this.exitedEngines.add(engine);
					await engine.exit().catch(() => undefined);
				}
				throw loadError;
			} finally {
				if (this.loadingEngine === engine) {
					this.loadingEngine = null;
				}
			}
			if (this.loadEpoch !== epoch) {
				if (!this.exitedEngines.has(engine)) {
					this.exitedEngines.add(engine);
					await engine.exit().catch(() => undefined);
				}
				throw new Error("wllama runtime unloaded during startup");
			}
			this.engine = engine;
		})());
		try {
			await loadPromise;
		} finally {
			if (this.loading === loadPromise) {
				this.loading = null;
			}
		}
	}

	/** Generates a completion for the given prompt using the wllama engine. */
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
			if (this.engine === engine) {
				this.engine = null;
				if (!this.exitedEngines.has(engine)) {
					this.exitedEngines.add(engine);
					try {
						await engine.exit();
					} catch (cleanupError) {
						throw new WllamaRecoveryError(generationError, cleanupError);
					}
				}
			}
			throw generationError;
		}
	}

	/** Terminates the wllama worker and clears any active or in-flight engine state. */
	async unload(): Promise<void> {
		this.loadEpoch += 1;
		const currentEngine = this.engine;
		this.engine = null;
		const inFlightEngine = this.loadingEngine;
		this.loadingEngine = null;
		const pendingLoad = this.loading;
		this.loading = null;
		try {
			if (currentEngine && !this.exitedEngines.has(currentEngine)) {
				this.exitedEngines.add(currentEngine);
				await currentEngine.exit();
			}
			if (
				inFlightEngine &&
				inFlightEngine !== currentEngine &&
				!this.exitedEngines.has(inFlightEngine)
			) {
				this.exitedEngines.add(inFlightEngine);
				await inFlightEngine.exit().catch(() => undefined);
			}
		} finally {
			if (pendingLoad) {
				await pendingLoad.catch(() => undefined);
			}
		}
	}
}
