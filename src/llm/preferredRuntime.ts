import type { LlmRuntime } from "./runtime";

export class PreferredRuntime implements LlmRuntime {
	private activeRuntime: LlmRuntime | null = null;

	constructor(
		private readonly primary: LlmRuntime,
		private readonly fallback: LlmRuntime,
	) {}

	isReady(): boolean {
		return this.activeRuntime?.isReady() ?? false;
	}

	async ensureLoaded(onProgress?: (fraction: number) => void): Promise<void> {
		if (this.activeRuntime) {
			await this.activeRuntime.ensureLoaded(onProgress);
			return;
		}

		try {
			await this.primary.ensureLoaded(onProgress);
			this.activeRuntime = this.primary;
		} catch (error) {
			console.warn("Primary runtime failed to load, falling back", error);
			await this.fallback.ensureLoaded(onProgress);
			this.activeRuntime = this.fallback;
		}
	}

	async generate(prompt: string, maxTokens: number): Promise<string> {
		if (!this.activeRuntime) {
			await this.ensureLoaded();
		}
		const activeRuntime = this.activeRuntime;
		if (!activeRuntime) throw new Error("No LLM runtime is available");

		try {
			return await activeRuntime.generate(prompt, maxTokens);
		} catch (error) {
			if (activeRuntime === this.primary) {
				console.warn("Primary runtime failed during generation, falling back", error);
				await this.primary.unload().catch((cleanupError) => {
					console.warn("Primary runtime cleanup failed during fallback", cleanupError);
				});
				await this.fallback.ensureLoaded();
				this.activeRuntime = this.fallback;
				return await this.fallback.generate(prompt, maxTokens);
			}
			throw error;
		}
	}

	async unload(): Promise<void> {
		await Promise.all([
			this.primary.unload().catch((error) => {
				console.warn("Primary runtime unload failed", error);
			}),
			this.fallback.unload().catch((error) => {
				console.warn("Fallback runtime unload failed", error);
			}),
		]);
		this.activeRuntime = null;
	}
}

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
