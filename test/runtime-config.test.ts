import { beforeEach, describe, expect, it, vi } from "vitest";

const { openAsBlobMock, wllamaConstructMock } = vi.hoisted(() => ({
	openAsBlobMock: vi.fn(),
	wllamaConstructMock: vi.fn(),
}));

vi.mock("fs", () => ({
	default: {
		openAsBlob: openAsBlobMock,
	},
	openAsBlob: openAsBlobMock,
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

import { WllamaRuntime, gpuLayersForModel } from "../src/llm/runtime";

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
});
