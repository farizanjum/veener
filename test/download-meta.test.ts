import { describe, expect, it } from "vitest";
import { metadataApiUrl, parseTreeResponse } from "../src/llm/download";

const RESOLVE_URL =
	"https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf";

describe("metadataApiUrl", () => {
	it("converts a resolve URL into the tree API URL", () => {
		expect(metadataApiUrl(RESOLVE_URL)).toBe(
			"https://huggingface.co/api/models/unsloth/Qwen3-4B-Instruct-2507-GGUF/tree/main?recursive=true",
		);
	});

	it("rejects an unexpected URL format", () => {
		expect(() => metadataApiUrl("https://example.com/model.gguf")).toThrow();
	});
});

describe("parseTreeResponse", () => {
	it("extracts the LFS sha256 and size for the file", () => {
		const body = JSON.stringify([
			{
				type: "file",
				path: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
				size: 2499516384,
				lfs: { oid: "deadbeef1234", size: 2499516384, pointerSize: 135 },
			},
		]);
		const meta = parseTreeResponse(body, "Qwen3-4B-Instruct-2507-Q4_K_M.gguf");
		expect(meta.sha256).toBe("deadbeef1234");
		expect(meta.sizeBytes).toBe(2499516384);
	});

	it("returns nulls when the entry has no LFS record", () => {
		const body = JSON.stringify([{ type: "file", path: "README.md", size: 1200 }]);
		const meta = parseTreeResponse(body, "README.md");
		expect(meta.sha256).toBeNull();
		expect(meta.sizeBytes).toBeNull();
	});
});
