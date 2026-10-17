import { describe, expect, it } from "vitest";
import { gpuLayersForModel } from "../src/llm/runtime";

describe("gpuLayersForModel", () => {
	it("uses CPU for compact models when Obsidian WebGPU lacks required WGSL builtins", () => {
		expect(gpuLayersForModel(1_300_000_000)).toBe(0);
	});

	it("uses CPU for models that exceed a 2 GB adapter budget", () => {
		expect(gpuLayersForModel(2_500_000_000)).toBe(0);
	});
});
