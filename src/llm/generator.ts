import { buildDecoyPrompt, maxTokensFor, type CoverType, type PromptExtras } from "./prompt";
import { evaluateDecoyQuality, type ValidationResult } from "./validate";
import type { LlmRuntime } from "./runtime";

/**
 * Decoy generation orchestration (§8.2): prompt, generate, validate, retry
 * with a fresh draw, fall back to the template bank when the model is absent
 * or every candidate fails validation.
 */

export interface GeneratorDeps {
	runtime: LlmRuntime | null;
	validate: (candidate: string, realText: string | null) => ValidationResult;
	fallbackTemplate: (seed: number) => string;
	maxAttempts?: number;
	maxTokens?: number;
	idleTimeoutMs?: number;
}

export interface GeneratedDecoy {
	text: string;
	source: "llm" | "template";
	attempts: number;
	error?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_TOKENS = 96;

/** Default idle duration (5 minutes) before automatically unloading the local LLM from RAM. */
export const DEFAULT_IDLE_UNLOAD_MS = 5 * 60 * 1000;

/**
 * Orchestrates decoy generation, validation retries, template fallback,
 * single-flight runtime access, and idle model unloading.
 */
export class DecoyGenerator {
	private readonly maxAttempts: number;
	private readonly maxTokens: number;
	private readonly idleTimeoutMs: number;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private activeOperations = 0;
	private unloadEpoch = 0;
	private runtimeTouchedSinceUnload = false;
	private operationQueue: Promise<void> = Promise.resolve();
	private unloadBarrier: Promise<void> = Promise.resolve();

	/** Creates a decoy generator with the given runtime, validator, and fallback template bank. */
	constructor(private readonly deps: GeneratorDeps) {
		this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
		this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_UNLOAD_MS;
	}

	/** Generates a validated decoy cover string, falling back to a deterministic template on failure. */
	async generate(
		kind: CoverType,
		interests: readonly string[],
		realText: string | null,
		seed: number,
		extras?: PromptExtras,
	): Promise<GeneratedDecoy> {
		if (!this.deps.runtime) {
			return { text: this.deps.fallbackTemplate(seed), source: "template", attempts: 0 };
		}
		const runtime = this.deps.runtime;
		return await this.enqueueOperation(async (epoch) => {
			const tokenBudget = Math.max(this.maxTokens, maxTokensFor(kind, extras));
			let lastError = "";
			for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
				if (this.unloadEpoch !== epoch) {
					lastError = "generator unloaded";
					break;
				}
				try {
					this.runtimeTouchedSinceUnload = true;
					const rawCandidate = await runtime.generate(
						buildDecoyPrompt(interests, kind, extras),
						tokenBudget,
					);
					if (this.unloadEpoch !== epoch) {
						lastError = "generator unloaded";
						break;
					}
					const candidate = rawCandidate.trim();
					const validation = this.deps.validate(candidate, realText);
					if (!validation.ok) {
						lastError = validation.reason
							? `validation failed (${validation.reason})`
							: "validation failed";
						continue;
					}
					const quality = evaluateDecoyQuality(candidate);
					if (quality.score < 0.4) continue;
					return { text: candidate, source: "llm", attempts: attempt };
				} catch (error) {
					lastError = error instanceof Error ? error.message : String(error);
					console.warn("Veneer: decoy generation attempt failed", error);
					break;
				}
			}
			const fallbackText = this.deps.fallbackTemplate(seed);
			return {
				text: fallbackText,
				source: "template",
				attempts: 0,
				error: lastError || "validation failed",
			};
		});
	}

	/** Preloads the LLM runtime in the background and arms the idle unload timer once ready. */
	warmup(): void {
		if (!this.deps.runtime) {
			return;
		}
		const runtime = this.deps.runtime;
		void this.enqueueOperation(async (epoch) => {
			if (this.unloadEpoch !== epoch || !this.deps.runtime) {
				return;
			}
			try {
				await runtime.ensureLoaded();
				if (this.unloadEpoch === epoch) {
					this.runtimeTouchedSinceUnload = true;
				}
			} catch {}
		});
	}

	/** Cancels any pending idle timer, invalidates in-flight generations, and unloads the runtime. */
	async unload(): Promise<void> {
		this.unloadEpoch += 1;
		this.runtimeTouchedSinceUnload = false;
		this.clearIdleTimer();
		if (this.deps.runtime) {
			const unloadPromise = this.deps.runtime.unload();
			this.unloadBarrier = unloadPromise.then(
				() => undefined,
				() => undefined,
			);
			await unloadPromise;
		}
	}

	/** Enqueues a runtime operation on the single-flight queue while tracking active operations. */
	private enqueueOperation<T>(task: (epoch: number) => Promise<T>): Promise<T> {
		const capturedEpoch = this.unloadEpoch;
		const unloadBarrier = this.unloadBarrier;
		this.clearIdleTimer();
		this.activeOperations += 1;
		const run = async (): Promise<T> => {
			try {
				await unloadBarrier;
				return await task(capturedEpoch);
			} finally {
				this.activeOperations = Math.max(0, this.activeOperations - 1);
				if (
					this.activeOperations === 0 &&
					this.unloadEpoch === capturedEpoch &&
					this.runtimeTouchedSinceUnload
				) {
					this.armIdleTimer();
				}
			}
		};
		const result = this.operationQueue.then(run, run);
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Arms or resets the idle timer to unload the runtime after inactivity. */
	private armIdleTimer(): void {
		this.clearIdleTimer();
		if (!this.deps.runtime || this.idleTimeoutMs <= 0 || this.activeOperations > 0) {
			return;
		}
		const scheduledEpoch = this.unloadEpoch;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (this.activeOperations === 0 && this.unloadEpoch === scheduledEpoch) {
				void this.unload().catch((error) => {
					console.warn("Veneer: idle model unload failed", error);
				});
			}
		}, this.idleTimeoutMs);
		(this.idleTimer as { unref?: () => void })?.unref?.();
	}

	/** Clears any currently scheduled idle unload timer. */
	private clearIdleTimer(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
}
