import { EventEmitter } from "events";
import https from "https";
import type http from "http";
import { PassThrough } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_METADATA_BYTES,
	fetchModelMetadata,
	metadataApiUrl,
	parseHuggingFaceResolveUrl,
	parseTreeResponse,
} from "../src/llm/download";

const RESOLVE_URL =
	"https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseHuggingFaceResolveUrl", () => {
	it("parses standard resolve URLs and strips ?download=true and #fragment", () => {
		const parsed = parseHuggingFaceResolveUrl(`${RESOLVE_URL}?download=true#section`);
		expect(parsed).toEqual({
			repoId: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
			revision: "main",
			filePath: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
			fileName: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
		});
	});

	it("supports non-main revisions and nested subdirectory paths", () => {
		const url =
			"https://huggingface.co/bartowski/Llama-3.2-3B-GGUF/resolve/v1.0.2/weights/q4_k_m/model.gguf?download=true";
		const parsed = parseHuggingFaceResolveUrl(url);
		expect(parsed).toEqual({
			repoId: "bartowski/Llama-3.2-3B-GGUF",
			revision: "v1.0.2",
			filePath: "weights/q4_k_m/model.gguf",
			fileName: "model.gguf",
		});
	});

	it("rejects non-HTTPS protocols, non-huggingface hosts, and path traversal segments", () => {
		expect(() =>
			parseHuggingFaceResolveUrl(
				"http://huggingface.co/org/repo/resolve/main/model.gguf",
			),
		).toThrow(/unexpected model URL format/);
		expect(() =>
			parseHuggingFaceResolveUrl(
				"https://evil-huggingface.co/org/repo/resolve/main/model.gguf",
			),
		).toThrow(/unexpected model URL format/);
		expect(() =>
			parseHuggingFaceResolveUrl(
				"https://huggingface.co/org/repo/resolve/main/%2e%2e/secret.gguf",
			),
		).toThrow(/unexpected model URL format/);
		expect(() =>
			parseHuggingFaceResolveUrl(
				"https://huggingface.co/org/repo/resolve/%2e%2e/model.gguf",
			),
		).toThrow(/unexpected model URL format/);
		expect(() =>
			parseHuggingFaceResolveUrl(
				"https://huggingface.co/org/repo/resolve/main/sub%5cmodel.gguf",
			),
		).toThrow(/unexpected model URL format/);
	});
});

describe("metadataApiUrl", () => {
	it("converts a resolve URL into the tree API URL", () => {
		expect(metadataApiUrl(RESOLVE_URL)).toBe(
			"https://huggingface.co/api/models/unsloth/Qwen3-4B-Instruct-2507-GGUF/tree/main?recursive=true",
		);
	});

	it("preserves non-main revisions and strips query strings when building tree API URL", () => {
		const url =
			"https://huggingface.co/org/repo/resolve/0123456789abcdef/subdir/model.gguf?download=true#frag";
		expect(metadataApiUrl(url)).toBe(
			"https://huggingface.co/api/models/org/repo/tree/0123456789abcdef?recursive=true",
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

	it("matches nested subdirectory paths accurately as well as basenames", () => {
		const body = JSON.stringify([
			{
				type: "file",
				path: "other/model.gguf",
				size: 111,
				lfs: { oid: "aaaa1111", size: 111 },
			},
			{
				type: "file",
				path: "subdir/model.gguf",
				size: 222,
				lfs: { oid: "bbbb2222", size: 222 },
			},
		]);
		expect(parseTreeResponse(body, "subdir/model.gguf")).toEqual({
			sha256: "bbbb2222",
			sizeBytes: 222,
		});
		expect(parseTreeResponse(body, "model.gguf")).toEqual({
			sha256: "aaaa1111",
			sizeBytes: 111,
		});
	});

	it("returns nulls when the entry has no LFS record", () => {
		const body = JSON.stringify([{ type: "file", path: "README.md", size: 1200 }]);
		const meta = parseTreeResponse(body, "README.md");
		expect(meta.sha256).toBeNull();
		expect(meta.sizeBytes).toBeNull();
	});

	it("decodes a percent-encoded literal %20 in the filename once and matches in parseTreeResponse", () => {
		const url =
			"https://huggingface.co/org/repo/resolve/main/subdir/my%2520model.gguf?download=true";
		const parsed = parseHuggingFaceResolveUrl(url);
		expect(parsed.filePath).toBe("subdir/my%20model.gguf");
		expect(parsed.fileName).toBe("my%20model.gguf");
		const body = JSON.stringify([
			{
				type: "file",
				path: "subdir/my%20model.gguf",
				size: 4096,
				lfs: { oid: "1122334455667788", size: 4096 },
			},
			{
				type: "file",
				path: "subdir/my model.gguf",
				size: 9999,
				lfs: { oid: "wrong_double_decoded", size: 9999 },
			},
		]);
		expect(parseTreeResponse(body, parsed.filePath)).toEqual({
			sha256: "1122334455667788",
			sizeBytes: 4096,
		});
	});
});

describe("fetchModelMetadata", () => {
	it("follows a 302 relative Location redirect and reassembles multi-byte UTF-8 JSON split across Buffer chunks", async () => {
		const requestedUrls: string[] = [];
		const jsonPayload = JSON.stringify([
			{
				type: "file",
				path: "subdir/model.gguf",
				note: "日本語モデル — 🚀✨",
				lfs: { oid: "cafebabe99887766", size: 987654321 },
			},
		]);
		const fullBuffer = Buffer.from(jsonPayload, "utf8");
		const emojiIndex = fullBuffer.indexOf(Buffer.from("🚀", "utf8"));
		expect(emojiIndex).toBeGreaterThan(0);
		const chunk1 = fullBuffer.subarray(0, emojiIndex + 1);
		const chunk2 = fullBuffer.subarray(emojiIndex + 1, emojiIndex + 3);
		const chunk3 = fullBuffer.subarray(emojiIndex + 3);

		vi.spyOn(https, "get").mockImplementation(((
			urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const urlStr = String(urlInput);
			requestedUrls.push(urlStr);
			const req = Object.assign(new EventEmitter(), {
				destroy: vi.fn(),
				setTimeout: vi.fn(),
			}) as unknown as http.ClientRequest;

			queueMicrotask(() => {
				if (requestedUrls.length === 1) {
					const redirectRes = new PassThrough() as PassThrough & http.IncomingMessage;
					redirectRes.statusCode = 302;
					redirectRes.headers = {
						location: "/api/models/org/repo/tree/v2.0?recursive=true&redirected=1",
					};
					redirectRes.complete = true;
					callback?.(redirectRes);
					redirectRes.end();
					return;
				}
				const okRes = new PassThrough() as PassThrough & http.IncomingMessage;
				okRes.statusCode = 200;
				okRes.headers = { "content-type": "application/json" };
				okRes.complete = true;
				callback?.(okRes);
				queueMicrotask(() => {
					okRes.write(chunk1);
					okRes.write(chunk2);
					okRes.end(chunk3);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		const meta = await fetchModelMetadata(
			"https://huggingface.co/org/repo/resolve/v2.0/subdir/model.gguf?download=true",
		);
		expect(requestedUrls).toEqual([
			"https://huggingface.co/api/models/org/repo/tree/v2.0?recursive=true",
			"https://huggingface.co/api/models/org/repo/tree/v2.0?recursive=true&redirected=1",
		]);
		expect(meta).toEqual({
			sha256: "cafebabe99887766",
			sizeBytes: 987654321,
		});
	});

	it("rejects and destroys response when metadata payload exceeds MAX_METADATA_BYTES", async () => {
		let destroyed = false;
		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = Object.assign(new EventEmitter(), {
				destroy: vi.fn(),
				setTimeout: vi.fn(),
			}) as unknown as http.ClientRequest;

			queueMicrotask(() => {
				const res = new PassThrough() as PassThrough & http.IncomingMessage;
				res.statusCode = 200;
				res.headers = { "content-type": "application/json" };
				res.complete = true;
				const origDestroy = res.destroy.bind(res);
				vi.spyOn(res, "destroy").mockImplementation(((err?: Error) => {
					destroyed = true;
					return origDestroy(err);
				}) as typeof res.destroy);
				callback?.(res);
				queueMicrotask(() => {
					res.write(Buffer.alloc(MAX_METADATA_BYTES + 1, 0x61));
				});
			});
			return req;
		}) as unknown as typeof https.get);

		await expect(fetchModelMetadata(RESOLVE_URL)).rejects.toThrow(
			"metadata response exceeded maximum size",
		);
		expect(destroyed).toBe(true);
	});
});
