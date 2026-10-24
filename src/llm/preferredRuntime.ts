import type { LlmRuntime } from "./runtime";

/** Composite LLM runtime that prefers a primary runtime and falls back to a secondary runtime on failure. */
export class PreferredRuntime implements LlmRuntime {
	private activeRuntime: LlmRuntime | null = null;
	private loadEpoch = 0;
	private loading: Promise<void> | null = null;

	constructor(
		private readonly primary: LlmRuntime,
		private readonly fallback: LlmRuntime,
	) {}

	/** Returns true when the currently active runtime is loaded and ready. */
	isReady(): boolean {
		return this.activeRuntime?.isReady() ?? false;
	}

	/** Loads the primary runtime, falling back to the secondary runtime if primary startup fails. */
	async ensureLoaded(onProgress?: (fraction: number) => void): Promise<void> {
		if (this.activeRuntime) {
			await this.activeRuntime.ensureLoaded(onProgress);
			return;
		}
		const loadPromise = (this.loading ??= (async () => {
			const epoch = ++this.loadEpoch;
			try {
				await this.primary.ensureLoaded(onProgress);
				if (this.loadEpoch !== epoch) {
					await this.primary.unload().catch(() => undefined);
					throw new Error("Preferred runtime unloaded during startup");
				}
				this.activeRuntime = this.primary;
			} catch (error) {
				if (this.loadEpoch !== epoch) {
					throw error;
				}
				console.warn("Primary runtime failed to load, falling back", error);
				await this.primary.unload().catch(() => undefined);
				if (this.loadEpoch !== epoch) {
					throw new Error("Preferred runtime unloaded during startup");
				}
				await this.fallback.ensureLoaded(onProgress);
				if (this.loadEpoch !== epoch) {
					await this.fallback.unload().catch(() => undefined);
					throw new Error("Preferred runtime unloaded during startup");
				}
				this.activeRuntime = this.fallback;
			}
		})());
		try {
			await loadPromise;
		} finally {
			if (this.loading === loadPromise) {
				this.loading = null;
			}
		}
	}

	/** Generates text using the active runtime, falling back to the secondary runtime if primary generation fails. */
	async generate(prompt: string, maxTokens: number): Promise<string> {
		if (!this.activeRuntime) {
			await this.ensureLoaded();
		}
		const epoch = this.loadEpoch;
		const activeRuntime = this.activeRuntime;
		if (!activeRuntime) throw new Error("No LLM runtime is available");

		try {
			return await activeRuntime.generate(prompt, maxTokens);
		} catch (error) {
			if (this.loadEpoch !== epoch) {
				throw error;
			}
			if (activeRuntime === this.primary) {
				console.warn("Primary runtime failed during generation, falling back", error);
				await this.primary.unload().catch((cleanupError) => {
					console.warn("Primary runtime cleanup failed during fallback", cleanupError);
				});
				if (this.loadEpoch !== epoch) {
					throw error;
				}
				await this.fallback.ensureLoaded();
				if (this.loadEpoch !== epoch) {
					await this.fallback.unload().catch(() => undefined);
					throw error;
				}
				this.activeRuntime = this.fallback;
				return await this.fallback.generate(prompt, maxTokens);
			}
			throw error;
		}
	}

	/** Unloads both primary and fallback runtimes and cancels any in-flight startup or fallback transitions. */
	async unload(): Promise<void> {
		const unloadEpoch = ++this.loadEpoch;
		this.activeRuntime = null;
		const pendingLoad = this.loading;
		this.loading = null;
		await Promise.all([
			this.primary.unload().catch((error) => {
				console.warn("Primary runtime unload failed", error);
			}),
			this.fallback.unload().catch((error) => {
				console.warn("Fallback runtime unload failed", error);
			}),
			pendingLoad?.catch(() => undefined),
		]);
		if (this.loadEpoch === unloadEpoch) {
			this.activeRuntime = null;
		}
	}
}

/** Selects `PreferredRuntime` on Windows when the native executable exists, or returns `fallback` otherwise. */
export function selectRuntime(
	platform: string,
	executableExists: boolean,
	primary: LlmRuntime,
	fallback: LlmRuntime,
): LlmRuntime {
	if (platform === "win32" && executableExists) {
		return new PreferredRuntime(primary, fallback);
	}
	return fallback;
}
