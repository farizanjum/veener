import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, activeModel, type VeneerSettings } from "../src/settings";

function withSettings(overrides: Partial<VeneerSettings>): VeneerSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("activeModel", () => {
	it("resolves the 0.6B built-in by default", () => {
		const model = activeModel(withSettings({}));
		expect(model.file).toBe("Qwen3-0.6B-Q4_K_M.gguf");
		expect(model.url).toContain("unsloth");
	});

	it("resolves the 1.7B built-in", () => {
		const model = activeModel(withSettings({ modelId: "qwen3-1.7b" }));
		expect(model.file).toBe("Qwen3-1.7B-Q4_K_M.gguf");
	});

	it("resolves a custom Hugging Face model", () => {
		const model = activeModel(
			withSettings({
				modelId: "custom",
				customModel: {
					file: "Phi-4-mini-Q4_K_M.gguf",
					url: "https://huggingface.co/someone/Phi-4-mini-GGUF/resolve/main/Phi-4-mini-Q4_K_M.gguf",
					sizeBytes: null,
					label: "Phi-4-mini-Q4_K_M.gguf",
				},
			}),
		);
		expect(model.file).toBe("Phi-4-mini-Q4_K_M.gguf");
		expect(model.url).toContain("huggingface.co");
	});

	it("resolves a disk-imported model with no URL", () => {
		const model = activeModel(
			withSettings({
				modelId: "custom",
				customModel: { file: "local.gguf", url: null, sizeBytes: 42, label: "local.gguf" },
			}),
		);
		expect(model.url).toBeNull();
		expect(model.sizeBytes).toBe(42);
	});

	it("falls back to the 0.6B built-in when custom is selected but empty", () => {
		const model = activeModel(withSettings({ modelId: "custom", customModel: null }));
		expect(model.file).toBe("Qwen3-0.6B-Q4_K_M.gguf");
	});
});
