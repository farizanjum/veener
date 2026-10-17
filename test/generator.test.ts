import { describe, expect, it } from "vitest";
import { DecoyGenerator } from "../src/llm/generator";
import { validateDecoy } from "../src/llm/validate";
import type { LlmRuntime } from "../src/llm/runtime";

function mockRuntime(outputs: (string | Error)[]): LlmRuntime {
	let index = 0;
	return {
		isReady: () => true,
		ensureLoaded: async () => undefined,
		generate: async () => {
			const next = outputs[Math.min(index++, outputs.length - 1)];
			if (next instanceof Error) throw next;
			return next;
		},
		unload: async () => undefined,
	};
}

const GOOD =
	"groceries for the week ahead include oats eggs spinach and a couple of vegetables from the corner shop plus coffee beans and some fruit for the mornings ahead and the weekend trip";
const BAD_SHORT = "too tiny";
const BAD_DASH = `${GOOD} — em dash`;

describe("DecoyGenerator", () => {
	it("uses a short output budget for ordinary covers", async () => {
		let requestedTokens = 0;
		const runtime = mockRuntime([GOOD]);
		const generator = new DecoyGenerator({
			runtime: {
				...runtime,
				generate: async (prompt, maxTokens) => {
					requestedTokens = maxTokens;
					return runtime.generate(prompt, maxTokens);
				},
			},
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});

		await generator.generate("grocery list", [], null, 1);

		expect(requestedTokens).toBe(96);
	});

	it("returns the first valid LLM candidate", async () => {
		const generator = new DecoyGenerator({
			runtime: mockRuntime([GOOD]),
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});
		const result = await generator.generate("grocery list", [], null, 1);
		expect(result.source).toBe("llm");
		expect(result.text).toBe(GOOD);
		expect(result.attempts).toBe(1);
	});

	it("retries after invalid candidates and counts attempts", async () => {
		const generator = new DecoyGenerator({
			runtime: mockRuntime([BAD_SHORT, BAD_DASH, GOOD]),
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});
		const result = await generator.generate("grocery list", [], null, 1);
		expect(result.source).toBe("llm");
		expect(result.attempts).toBe(3);
	});

	it("falls back to a template when every candidate fails", async () => {
		const generator = new DecoyGenerator({
			runtime: mockRuntime([BAD_SHORT, BAD_SHORT, BAD_SHORT]),
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: (seed) => `TEMPLATE-${seed}`,
			maxAttempts: 3,
		});
		const result = await generator.generate("grocery list", [], null, 7);
		expect(result.source).toBe("template");
		expect(result.text).toBe("TEMPLATE-7");
	});

	it("falls back immediately when the runtime throws", async () => {
		const generator = new DecoyGenerator({
			runtime: mockRuntime([new Error("model crashed")]),
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});
		const result = await generator.generate("grocery list", [], null, 1);
		expect(result.source).toBe("template");
	});

	it("uses the template directly when no runtime exists", async () => {
		const generator = new DecoyGenerator({
			runtime: null,
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: () => "TEMPLATE",
		});
		const result = await generator.generate("grocery list", [], null, 1);
		expect(result.source).toBe("template");
	});
});
