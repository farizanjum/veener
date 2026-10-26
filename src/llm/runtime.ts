import type { Wllama } from "@wllama/wllama/esm/index.js";
import fs from "fs";
import path from "path";
import { clearPartial, sha256HexOfFile, startModelDownload, type DownloadHandle } from "./download";

/** Expected byte length of the pinned `@wllama/wllama@3.5.1` WebAssembly binary. */
export const WLLAMA_WASM_SIZE_BYTES = 7_656_521;

/** Expected lowercase SHA-256 hex digest of the pinned `@wllama/wllama@3.5.1` WebAssembly binary. */
export const WLLAMA_WASM_SHA256 =
	"4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa";

/** HTTPS CDN mirrors for provisioning `wllama.wasm` on 3-file store installations. */
export const WLLAMA_WASM_URLS: readonly string[] = [
	"https://cdn.jsdelivr.net/npm/@wllama/wllama@3.5.1/esm/wasm/wllama.wasm",
	"https://unpkg.com/@wllama/wllama@3.5.1/esm/wasm/wllama.wasm",
];

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

/** Context window size in tokens for wllama CPU fallback inference. */
export const WLLAMA_CONTEXT_SIZE = 1024;

/** Computes the optimal thread count for wllama based on `navigator.hardwareConcurrency` and `SharedArrayBuffer` support. */
export function cpuThreadsForRuntime(
	hardwareConcurrency: number | undefined = typeof navigator !== "undefined"
		? navigator.hardwareConcurrency
		: undefined,
	sharedArrayBufferAvailable: boolean = typeof SharedArrayBuffer !== "undefined",
): number {
	if (!sharedArrayBufferAvailable) return 1;
	const cores =
		typeof hardwareConcurrency === "number" && Number.isFinite(hardwareConcurrency)
			? Math.floor(hardwareConcurrency)
			: 1;
	if (cores <= 1) return 1;
	return Math.min(8, Math.max(2, Math.floor(cores / 2)));
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

/** Per-path serialization queue preventing overlapping WASM downloads and cleanups across reloads. */
const WASM_QUEUE_KEY = Symbol.for("veneer.wasmProvisionQueues.v1");
const wasmProvisionQueues: Map<string, Promise<void>> =
	((globalThis as Record<symbol, unknown>)[WASM_QUEUE_KEY] as
		| Map<string, Promise<void>>
		| undefined) ??
	(((globalThis as Record<symbol, unknown>)[WASM_QUEUE_KEY] = new Map<
		string,
		Promise<void>
	>()) as Map<string, Promise<void>>);

/** WebAssembly-backed LLM runtime using @wllama/wllama. */
export class WllamaRuntime implements LlmRuntime {
	private engine: Wllama | null = null;
	private loadingEngine: Wllama | null = null;
	private loading: Promise<void> | null = null;
	private loadEpoch = 0;
	private readonly exitedEngines = new WeakSet<object>();
	private readonly pendingCleanupEngines = new Set<Wllama>();
	private readonly cleanupPromises = new WeakMap<Wllama, Promise<void>>();
	private activeWasmDownload: DownloadHandle | null = null;
	private verifiedWasmMtimeMs: number | null = null;

	constructor(
		private readonly modelPath: string,
		private readonly wasmPath: string,
	) {}

	/**
	 * Verifies that `this.wasmPath` exists on disk with the expected size and SHA-256 digest,
	 * automatically downloading and verifying it from `WLLAMA_WASM_URLS` when missing or corrupt.
	 */
	private async ensureWasmBinary(
		epoch: number,
		onProgress?: (fraction: number) => void,
	): Promise<void> {
		const checkUnloaded = (): void => {
			if (this.loadEpoch !== epoch) {
				throw new Error("wllama runtime unloaded during startup");
			}
		};
		checkUnloaded();

		const prevTask = wasmProvisionQueues.get(this.wasmPath) ?? Promise.resolve();
		let releaseQueue!: () => void;
		const currentQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		const chainedQueue = prevTask.finally(() => currentQueue);
		wasmProvisionQueues.set(this.wasmPath, chainedQueue);

		try {
			await prevTask.catch(() => undefined);
			checkUnloaded();

			try {
				const stat = fs.statSync(this.wasmPath);
				if (stat.isFile() && stat.size === WLLAMA_WASM_SIZE_BYTES) {
					if (this.verifiedWasmMtimeMs !== null && this.verifiedWasmMtimeMs === stat.mtimeMs) {
						return;
					}
					const digest = await sha256HexOfFile(this.wasmPath);
					checkUnloaded();
					if (digest.toLowerCase() === WLLAMA_WASM_SHA256) {
						this.verifiedWasmMtimeMs = stat.mtimeMs;
						return;
					}
				}
			} catch (err) {
				if (err instanceof Error && err.message === "wllama runtime unloaded during startup") {
					throw err;
				}
				// File missing or unreadable; proceed to provision from CDN mirrors
			}

			checkUnloaded();
			await fs.promises.mkdir(path.dirname(this.wasmPath), { recursive: true });
			checkUnloaded();

			const removeCorruptOrPartial = async (): Promise<void> => {
				this.verifiedWasmMtimeMs = null;
				try {
					await fs.promises.unlink(this.wasmPath);
				} catch (err) {
					const code = (err as NodeJS.ErrnoException | undefined)?.code;
					const msg = err instanceof Error ? err.message : String(err);
					if (code !== "ENOENT" && !msg.includes("ENOENT")) {
						throw err;
					}
				}
				try {
					clearPartial(this.wasmPath);
				} catch (err) {
					const code = (err as NodeJS.ErrnoException | undefined)?.code;
					const msg = err instanceof Error ? err.message : String(err);
					if (code !== "ENOENT" && !msg.includes("ENOENT")) {
						throw err;
					}
				}
			};

			let lastError: unknown = null;
			for (const url of WLLAMA_WASM_URLS) {
				checkUnloaded();
				try {
					await removeCorruptOrPartial();
				} catch (cleanupErr) {
					checkUnloaded();
					lastError = cleanupErr;
					continue;
				}
				checkUnloaded();
				const handle = startModelDownload(
					url,
					this.wasmPath,
					WLLAMA_WASM_SIZE_BYTES,
					(progress) => {
						if (onProgress && progress.total && progress.total > 0) {
							onProgress(Math.min(1, Math.max(0, progress.downloaded / progress.total)));
						}
					},
				);
				this.activeWasmDownload = handle;
				try {
					await handle.promise;
				} catch (downloadErr) {
					checkUnloaded();
					await removeCorruptOrPartial().catch(() => undefined);
					lastError = downloadErr;
					continue;
				} finally {
					if (this.activeWasmDownload === handle) {
						this.activeWasmDownload = null;
					}
				}

				checkUnloaded();
				try {
					const stat = fs.statSync(this.wasmPath);
					if (!stat.isFile() || stat.size !== WLLAMA_WASM_SIZE_BYTES) {
						throw new Error(
							`unexpected wllama.wasm size (${stat.size}/${WLLAMA_WASM_SIZE_BYTES} bytes)`,
						);
					}
					const digest = await sha256HexOfFile(this.wasmPath);
					checkUnloaded();
					if (digest.toLowerCase() !== WLLAMA_WASM_SHA256) {
						throw new Error("wllama.wasm SHA-256 verification failed");
					}
					this.verifiedWasmMtimeMs = stat.mtimeMs;
					return;
				} catch (verifyErr) {
					checkUnloaded();
					await removeCorruptOrPartial().catch(() => undefined);
					lastError = verifyErr;
				}
			}

			throw new Error(
				`Failed to provision verified wllama.wasm runtime asset: ${
					lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")
				}`,
			);
		} finally {
			releaseQueue();
			if (wasmProvisionQueues.get(this.wasmPath) === chainedQueue) {
				wasmProvisionQueues.delete(this.wasmPath);
			}
		}
	}

	/** Deduplicates and tracks worker exit for `engine`, retaining failed engines for retry on subsequent unloads. */
	private cleanupEngine(engine: Wllama): Promise<void> {
		if (this.exitedEngines.has(engine)) {
			this.pendingCleanupEngines.delete(engine);
			return Promise.resolve();
		}
		const existing = this.cleanupPromises.get(engine);
		if (existing) return existing;
		const cleanup = (async (): Promise<void> => {
			try {
				await engine.exit();
				this.exitedEngines.add(engine);
				this.pendingCleanupEngines.delete(engine);
			} catch (error) {
				this.pendingCleanupEngines.add(engine);
				throw error;
			} finally {
				this.cleanupPromises.delete(engine);
			}
		})();
		this.cleanupPromises.set(engine, cleanup);
		return cleanup;
	}

	/** Returns true when the wllama engine is loaded and ready for inference. */
	isReady(): boolean {
		return this.engine !== null;
	}

	/** Loads the GGUF model into a wllama worker if not already loaded. */
	async ensureLoaded(onProgress?: (fraction: number) => void): Promise<void> {
		if (this.engine) return;
		const epoch = this.loadEpoch;
		const loadPromise = (this.loading ??= (async () => {
			await this.ensureWasmBinary(epoch, onProgress);
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
					n_ctx: WLLAMA_CONTEXT_SIZE,
					n_threads: cpuThreadsForRuntime(),
					n_gpu_layers: gpuLayers,
					flash_attn: false,
				});
			} catch (loadError) {
				await this.cleanupEngine(engine).catch(() => undefined);
				throw loadError;
			} finally {
				if (this.loadingEngine === engine) {
					this.loadingEngine = null;
				}
			}
			if (this.loadEpoch !== epoch) {
				await this.cleanupEngine(engine).catch(() => undefined);
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
					cache_prompt: true,
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
				try {
					await this.cleanupEngine(engine);
				} catch (cleanupError) {
					throw new WllamaRecoveryError(generationError, cleanupError);
				}
			}
			throw generationError;
		}
	}

	/** Terminates the wllama worker and clears any active or in-flight engine state. */
	async unload(): Promise<void> {
		this.loadEpoch += 1;
		this.activeWasmDownload?.cancel();
		this.activeWasmDownload = null;
		const currentEngine = this.engine;
		this.engine = null;
		const inFlightEngine = this.loadingEngine;
		this.loadingEngine = null;
		const pendingLoad = this.loading;
		this.loading = null;
		const cleanupEngines = new Set<Wllama>(this.pendingCleanupEngines);
		if (currentEngine) {
			cleanupEngines.add(currentEngine);
		}
		if (inFlightEngine && inFlightEngine !== currentEngine) {
			cleanupEngines.add(inFlightEngine);
		}
		for (const engine of cleanupEngines) {
			this.pendingCleanupEngines.add(engine);
		}
		let cleanupFailed = false;
		let firstCleanupError: unknown;
		try {
			for (const engine of cleanupEngines) {
				if (this.exitedEngines.has(engine)) {
					this.pendingCleanupEngines.delete(engine);
					continue;
				}
				try {
					await this.cleanupEngine(engine);
				} catch (error) {
					if (engine === inFlightEngine && engine !== currentEngine) {
						continue;
					}
					if (!cleanupFailed) {
						cleanupFailed = true;
						firstCleanupError = error;
					}
				}
			}
			if (cleanupFailed) {
				throw firstCleanupError;
			}
		} finally {
			if (pendingLoad) {
				await pendingLoad.catch(() => undefined);
			}
		}
	}
}
