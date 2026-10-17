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
}

export interface GeneratedDecoy {
	text: string;
	source: "llm" | "template";
	attempts: number;
	error?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_TOKENS = 96;

export class DecoyGenerator {
	private readonly maxAttempts: number;
	private readonly maxTokens: number;

	constructor(private readonly deps: GeneratorDeps) {
		this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
	}

	async generate(
		kind: CoverType,
		interests: readonly string[],
		realText: string | null,
		seed: number,
		extras?: PromptExtras,
	): Promise<GeneratedDecoy> {
		if (this.deps.runtime) {
			const tokenBudget = Math.max(this.maxTokens, maxTokensFor(kind, extras));
			let lastError = "";
			for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
				try {
					const candidate = (
						await this.deps.runtime.generate(buildDecoyPrompt(interests, kind, extras), tokenBudget)
					).trim();
					const validation = this.deps.validate(candidate, realText);
					if (!validation.ok) {
						lastError = validation.reason ? `validation failed (${validation.reason})` : "validation failed";
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
			return { text: fallbackText, source: "template", attempts: 0, error: lastError || "validation failed" };
		}
		return { text: this.deps.fallbackTemplate(seed), source: "template", attempts: 0 };
	}

	warmup(): void {
		if (this.deps.runtime) {
			void this.deps.runtime.ensureLoaded().catch(() => undefined);
		}
	}

	async unload(): Promise<void> {
		if (this.deps.runtime) {
			await this.deps.runtime.unload();
		}
	}
}
