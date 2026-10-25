import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	openAsBlobMock,
	statSyncMock,
	mkdirMock,
	unlinkMock,
	sha256HexOfFileMock,
	startModelDownloadMock,
	clearPartialMock,
	wllamaConstructMock,
} = vi.hoisted(() => ({
	openAsBlobMock: vi.fn(),
	statSyncMock: vi.fn(),
	mkdirMock: vi.fn(),
	unlinkMock: vi.fn(),
	sha256HexOfFileMock: vi.fn(),
	startModelDownloadMock: vi.fn(),
	clearPartialMock: vi.fn(),
	wllamaConstructMock: vi.fn(),
}));

vi.mock("fs", () => ({
	default: {
		openAsBlob: openAsBlobMock,
		statSync: statSyncMock,
		promises: {
			mkdir: mkdirMock,
			unlink: unlinkMock,
		},
	},
	openAsBlob: openAsBlobMock,
	statSync: statSyncMock,
	promises: {
		mkdir: mkdirMock,
		unlink: unlinkMock,
	},
}));

vi.mock("../src/llm/download", () => ({
	sha256HexOfFile: sha256HexOfFileMock,
	startModelDownload: startModelDownloadMock,
	clearPartial: clearPartialMock,
}));

vi.mock("@wllama/wllama/esm/index.js", () => ({
	Wllama: class MockWllama {
		loadModel: ReturnType<typeof vi.fn>;
		exit: ReturnType<typeof vi.fn>;
		getChatTemplate: ReturnType<typeof vi.fn>;
		createChatCompletion: ReturnType<typeof vi.fn>;
		createCompletion: ReturnType<typeof vi.fn>;

		constructor(config: unknown, options: unknown) {
			const instance = wllamaConstructMock(config, options);
			this.loadModel = instance.loadModel;
			this.exit = instance.exit;
			this.getChatTemplate = instance.getChatTemplate;
			this.createChatCompletion = instance.createChatCompletion;
			this.createCompletion = instance.createCompletion;
		}
	},
}));

import {
	WLLAMA_WASM_SHA256,
	WLLAMA_WASM_SIZE_BYTES,
	WLLAMA_WASM_URLS,
	WllamaRuntime,
	gpuLayersForModel,
} from "../src/llm/runtime";

describe("gpuLayersForModel", () => {
	it("uses CPU for compact models when Obsidian WebGPU lacks required WGSL builtins", () => {
		expect(gpuLayersForModel(1_300_000_000)).toBe(0);
	});

	it("uses CPU for models that exceed a 2 GB adapter budget", () => {
		expect(gpuLayersForModel(2_500_000_000)).toBe(0);
	});
});

describe("WllamaRuntime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		statSyncMock.mockReturnValue({
			isFile: () => true,
			size: WLLAMA_WASM_SIZE_BYTES,
			mtimeMs: 1000,
		});
		sha256HexOfFileMock.mockResolvedValue(WLLAMA_WASM_SHA256);
		mkdirMock.mockResolvedValue(undefined);
		unlinkMock.mockResolvedValue(undefined);
		openAsBlobMock.mockResolvedValue(new Blob([new Uint8Array(16)]));
	});

	it("exits the engine and stays unready when unload() is called while loadModel is in flight", async () => {
		let resolveLoadModel!: () => void;
		const exitMock = vi.fn().mockResolvedValue(undefined);
		const loadModelMock = vi.fn().mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveLoadModel = resolve;
				}),
		);

		wllamaConstructMock.mockReturnValue({
			loadModel: loadModelMock,
			exit: exitMock,
			getChatTemplate: vi.fn().mockReturnValue(null),
			createChatCompletion: vi.fn(),
			createCompletion: vi.fn(),
		});

		const runtime = new WllamaRuntime("/tmp/model.gguf", "/tmp/wllama.wasm");
		const loadPromise = runtime.ensureLoaded();

		await vi.waitFor(() => {
			expect(loadModelMock).toHaveBeenCalledTimes(1);
		});

		const unloadPromise = runtime.unload();
		resolveLoadModel();

		await expect(loadPromise).rejects.toThrow("wllama runtime unloaded during startup");
		await unloadPromise;

		expect(exitMock).toHaveBeenCalledTimes(1);
		expect(runtime.isReady()).toBe(false);
	});

	it("immediately calls engine.exit() inside unload() while loadModel is stalled before loadModel settles", async () => {
		let rejectLoadModel!: (reason?: unknown) => void;
		const exitMock = vi.fn().mockImplementation(async () => {
			rejectLoadModel?.(new Error("worker terminated by exit"));
		});
		const loadModelMock = vi.fn().mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectLoadModel = reject;
				}),
		);

		wllamaConstructMock.mockReturnValue({
			loadModel: loadModelMock,
			exit: exitMock,
			getChatTemplate: vi.fn().mockReturnValue(null),
			createChatCompletion: vi.fn(),
			createCompletion: vi.fn(),
		});

		const runtime = new WllamaRuntime("/tmp/model.gguf", "/tmp/wllama.wasm");
		const loadPromise = runtime.ensureLoaded();

		await vi.waitFor(() => {
			expect(loadModelMock).toHaveBeenCalledTimes(1);
		});

		expect(exitMock).not.toHaveBeenCalled();
		const unloadPromise = runtime.unload();
		expect(exitMock).toHaveBeenCalledTimes(1);

		await expect(loadPromise).rejects.toThrow("worker terminated by exit");
		await unloadPromise;

		expect(exitMock).toHaveBeenCalledTimes(1);
		expect(runtime.isReady()).toBe(false);
	});

	it("calls engine.exit() to clean up the worker when loadModel rejects", async () => {
		const exitMock = vi.fn().mockResolvedValue(undefined);
		const loadModelMock = vi.fn().mockRejectedValue(new Error("corrupt gguf"));

		wllamaConstructMock.mockReturnValue({
			loadModel: loadModelMock,
			exit: exitMock,
			getChatTemplate: vi.fn().mockReturnValue(null),
			createChatCompletion: vi.fn(),
			createCompletion: vi.fn(),
		});

		const runtime = new WllamaRuntime("/tmp/model.gguf", "/tmp/wllama.wasm");
		await expect(runtime.ensureLoaded()).rejects.toThrow("corrupt gguf");

		expect(exitMock).toHaveBeenCalledTimes(1);
		expect(runtime.isReady()).toBe(false);
	});

	it("does not call engine.exit() a second time in generate() when unload() already claimed the engine", async () => {
		let rejectCompletion!: (reason?: unknown) => void;
		const exitMock = vi.fn().mockImplementation(async () => {
			rejectCompletion?.(new Error("worker exited during completion"));
		});
		const createCompletionMock = vi.fn().mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectCompletion = reject;
				}),
		);

		wllamaConstructMock.mockReturnValue({
			loadModel: vi.fn().mockResolvedValue(undefined),
			exit: exitMock,
			getChatTemplate: vi.fn().mockReturnValue(null),
			createChatCompletion: vi.fn(),
			createCompletion: createCompletionMock,
		});

		const runtime = new WllamaRuntime("/tmp/model.gguf", "/tmp/wllama.wasm");
		await runtime.ensureLoaded();
		expect(runtime.isReady()).toBe(true);

		const genPromise = runtime.generate("test prompt", 16);
		await vi.waitFor(() => {
			expect(createCompletionMock).toHaveBeenCalledTimes(1);
		});

		const unloadPromise = runtime.unload();

		await expect(genPromise).rejects.toThrow("worker exited during completion");
		await unloadPromise;

		expect(exitMock).toHaveBeenCalledTimes(1);
		expect(runtime.isReady()).toBe(false);
	});

	it("downloads wllama.wasm from WLLAMA_WASM_URLS[0] and verifies SHA-256 when missing on disk", async () => {
		let downloaded = false;
		statSyncMock.mockImplementation(() => {
			if (!downloaded) {
				const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return {
				isFile: () => true,
				size: WLLAMA_WASM_SIZE_BYTES,
				mtimeMs: 2000,
			};
		});

		startModelDownloadMock.mockImplementation(() => {
			downloaded = true;
			return {
				promise: Promise.resolve(),
				cancel: vi.fn(),
			};
		});

		const loadModelMock = vi.fn().mockResolvedValue(undefined);
		wllamaConstructMock.mockReturnValue({
			loadModel: loadModelMock,
			exit: vi.fn().mockResolvedValue(undefined),
			getChatTemplate: vi.fn().mockReturnValue(null),
			createChatCompletion: vi.fn(),
			createCompletion: vi.fn(),
		});

		const runtime = new WllamaRuntime("/tmp/model.gguf", "/tmp/assets/wllama/wasm/wllama.wasm");
		await runtime.ensureLoaded();

		expect(startModelDownloadMock).toHaveBeenCalledTimes(1);
		expect(startModelDownloadMock).toHaveBeenCalledWith(
			WLLAMA_WASM_URLS[0],
			"/tmp/assets/wllama/wasm/wllama.wasm",
			WLLAMA_WASM_SIZE_BYTES,
			expect.any(Function),
		);
		expect(sha256HexOfFileMock).toHaveBeenCalledWith("/tmp/assets/wllama/wasm/wllama.wasm");
		expect(loadModelMock).toHaveBeenCalledTimes(1);
		expect(runtime.isReady()).toBe(true);
	});

	it("unlinks corrupt wllama.wasm, clears partial artifacts, and re-downloads when SHA-256 mismatches", async () => {
		sha256HexOfFileMock
			.mockResolvedValueOnce("0000000000000000000000000000000000000000000000000000000000000000")
			.mockResolvedValueOnce(WLLAMA_WASM_SHA256);

		startModelDownloadMock.mockReturnValue({
			promise: Promise.resolve(),
			cancel: vi.fn(),
		});

		const loadModelMock = vi.fn().mockResolvedValue(undefined);
		wllamaConstructMock.mockReturnValue({
			loadModel: loadModelMock,
			exit: vi.fn().mockResolvedValue(undefined),
			getChatTemplate: vi.fn().mockReturnValue(null),
			createChatCompletion: vi.fn(),
			createCompletion: vi.fn(),
		});

		const wasmPath = "/tmp/assets/wllama/wasm/wllama.wasm";
		const runtime = new WllamaRuntime("/tmp/model.gguf", wasmPath);
		await runtime.ensureLoaded();

		expect(unlinkMock).toHaveBeenCalledWith(wasmPath);
		expect(clearPartialMock).toHaveBeenCalledWith(wasmPath);
		expect(startModelDownloadMock).toHaveBeenCalledTimes(1);
		expect(startModelDownloadMock).toHaveBeenCalledWith(
			WLLAMA_WASM_URLS[0],
			wasmPath,
			WLLAMA_WASM_SIZE_BYTES,
			expect.any(Function),
		);
		expect(sha256HexOfFileMock).toHaveBeenCalledTimes(2);
		expect(loadModelMock).toHaveBeenCalledTimes(1);
		expect(runtime.isReady()).toBe(true);
	});

	it("falls back to WLLAMA_WASM_URLS[1] and cleans up partial artifacts when WLLAMA_WASM_URLS[0] fails", async () => {
		let mirrorAttempt = 0;
		statSyncMock.mockImplementation(() => {
			if (mirrorAttempt === 0) {
				throw new Error("ENOENT");
			}
			return {
				isFile: () => true,
				size: WLLAMA_WASM_SIZE_BYTES,
				mtimeMs: 3000,
			};
		});

		startModelDownloadMock.mockImplementation((url: string) => {
			mirrorAttempt += 1;
			if (url === WLLAMA_WASM_URLS[0]) {
				return {
					promise: Promise.reject(new Error("primary CDN 503")),
					cancel: vi.fn(),
				};
			}
			return {
				promise: Promise.resolve(),
				cancel: vi.fn(),
			};
		});

		const loadModelMock = vi.fn().mockResolvedValue(undefined);
		wllamaConstructMock.mockReturnValue({
			loadModel: loadModelMock,
			exit: vi.fn().mockResolvedValue(undefined),
			getChatTemplate: vi.fn().mockReturnValue(null),
			createChatCompletion: vi.fn(),
			createCompletion: vi.fn(),
		});

		const wasmPath = "/tmp/assets/wllama/wasm/wllama.wasm";
		const runtime = new WllamaRuntime("/tmp/model.gguf", wasmPath);
		await runtime.ensureLoaded();

		expect(startModelDownloadMock).toHaveBeenCalledTimes(2);
		expect(startModelDownloadMock.mock.calls[0]?.[0]).toBe(WLLAMA_WASM_URLS[0]);
		expect(startModelDownloadMock.mock.calls[1]?.[0]).toBe(WLLAMA_WASM_URLS[1]);
		expect(clearPartialMock).toHaveBeenCalledWith(wasmPath);
		expect(loadModelMock).toHaveBeenCalledTimes(1);
		expect(runtime.isReady()).toBe(true);
	});

	it("cancels an in-flight wllama.wasm download on unload() and rejects ensureLoaded() without constructing Wllama", async () => {
		statSyncMock.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		let rejectDownload!: (reason?: unknown) => void;
		const cancelMock = vi.fn().mockImplementation(() => {
			rejectDownload?.(new Error("download cancelled"));
		});

		startModelDownloadMock.mockImplementation(() => ({
			promise: new Promise<void>((_resolve, reject) => {
				rejectDownload = reject;
			}),
			cancel: cancelMock,
		}));

		const runtime = new WllamaRuntime("/tmp/model.gguf", "/tmp/assets/wllama/wasm/wllama.wasm");
		const loadPromise = runtime.ensureLoaded();

		await vi.waitFor(() => {
			expect(startModelDownloadMock).toHaveBeenCalledTimes(1);
		});

		unlinkMock.mockClear();
		clearPartialMock.mockClear();

		const unloadPromise = runtime.unload();
		expect(cancelMock).toHaveBeenCalledTimes(1);

		await expect(loadPromise).rejects.toThrow("wllama runtime unloaded during startup");
		await unloadPromise;

		expect(unlinkMock).not.toHaveBeenCalled();
		expect(clearPartialMock).not.toHaveBeenCalled();
		expect(wllamaConstructMock).not.toHaveBeenCalled();
		expect(runtime.isReady()).toBe(false);
	});

	it("does not unlink wllama.wasm when unload() happens during post-download SHA-256 verification and serializes concurrent ensureLoaded() on the same wasmPath", async () => {
		let downloaded = false;
		statSyncMock.mockImplementation(() => {
			if (!downloaded) {
				const err = new Error("ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return {
				isFile: () => true,
				size: WLLAMA_WASM_SIZE_BYTES,
				mtimeMs: 5000,
			};
		});

		startModelDownloadMock.mockImplementation(() => {
			downloaded = true;
			return {
				promise: Promise.resolve(),
				cancel: vi.fn(),
			};
		});

		let resolveFirstHash!: (digest: string) => void;
		sha256HexOfFileMock
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						resolveFirstHash = resolve;
					}),
			)
			.mockResolvedValueOnce(WLLAMA_WASM_SHA256);

		const loadModelMock = vi.fn().mockResolvedValue(undefined);
		wllamaConstructMock.mockReturnValue({
			loadModel: loadModelMock,
			exit: vi.fn().mockResolvedValue(undefined),
			getChatTemplate: vi.fn().mockReturnValue(null),
			createChatCompletion: vi.fn(),
			createCompletion: vi.fn(),
		});

		const wasmPath = "/tmp/assets/wllama/wasm/shared-wllama.wasm";
		const runtimeA = new WllamaRuntime("/tmp/model.gguf", wasmPath);
		const runtimeB = new WllamaRuntime("/tmp/model.gguf", wasmPath);

		const loadPromiseA = runtimeA.ensureLoaded();
		await vi.waitFor(() => {
			expect(sha256HexOfFileMock).toHaveBeenCalledTimes(1);
		});

		const loadPromiseB = runtimeB.ensureLoaded();
		unlinkMock.mockClear();
		clearPartialMock.mockClear();

		const unloadPromiseA = runtimeA.unload();
		resolveFirstHash(WLLAMA_WASM_SHA256);

		await expect(loadPromiseA).rejects.toThrow("wllama runtime unloaded during startup");
		await unloadPromiseA;

		expect(unlinkMock).not.toHaveBeenCalled();
		expect(clearPartialMock).not.toHaveBeenCalled();

		await loadPromiseB;
		expect(runtimeB.isReady()).toBe(true);
	});

	it("fails fast without calling startModelDownload when unlinking a corrupt wllama.wasm fails with EBUSY", async () => {
		sha256HexOfFileMock.mockResolvedValue(
			"0000000000000000000000000000000000000000000000000000000000000000",
		);
		unlinkMock.mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));

		const wasmPath = "/tmp/assets/wllama/wasm/wllama.wasm";
		const runtime = new WllamaRuntime("/tmp/model.gguf", wasmPath);

		await expect(runtime.ensureLoaded()).rejects.toThrow("EBUSY");
		expect(startModelDownloadMock).not.toHaveBeenCalled();
		expect(wllamaConstructMock).not.toHaveBeenCalled();
		expect(runtime.isReady()).toBe(false);
	});
});
