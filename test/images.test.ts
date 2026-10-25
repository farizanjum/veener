import { EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
	absorbVaultImages,
	deleteStagedVaultImages,
	extractImageLinks,
	mimeForPath,
	readLinkedVaultImages,
	restoreVaultImages,
} from "../src/crypto/images";
import {
	changePassword,
	createFile,
	parseFileContent,
	reencryptRealText,
	unlockPayload,
} from "../src/crypto/payload";
import VeneerPlugin, { WORD_COUNTER_DEBOUNCE_MS } from "../src/main";
import { WordCounter, countLines, countWords } from "../src/ui/statusBar";
import { buildUnlockedImageExtension } from "../src/view/imageWidget";

const DECOY = "## Grocery list\n\n- milk, eggs, bread\n- check kitchen sink";
const REAL = "Secret note with embedded image:\n![[Pasted image 2026.png]]";
const PASSWORD = "correct horse battery staple";

describe("extractImageLinks and mimeForPath", () => {
	it("extracts wiki embeds and markdown image links while ignoring https URLs", () => {
		const md = [
			"# Notes",
			"![[Pasted image 2026.png]]",
			"![[folder/diagram.webp|400]]",
			"![chart](<Pasted image 2.jpg>)",
			"![pic](assets/photo.png)",
			"![remote](https://example.com/banner.png)",
			"![[Pasted image 2026.png]]",
		].join("\n");

		expect(extractImageLinks(md)).toEqual([
			"Pasted image 2026.png",
			"folder/diagram.webp",
			"Pasted image 2.jpg",
			"assets/photo.png",
		]);
	});

	it("maps image extensions to MIME types", () => {
		expect(mimeForPath("a.png")).toBe("image/png");
		expect(mimeForPath("b.jpg")).toBe("image/jpeg");
		expect(mimeForPath("c.JPEG")).toBe("image/jpeg");
		expect(mimeForPath("d.gif")).toBe("image/gif");
		expect(mimeForPath("e.webp")).toBe("image/webp");
		expect(mimeForPath("f.svg")).toBe("image/svg+xml");
		expect(mimeForPath("g.bmp")).toBe("image/bmp");
	});
});

describe("encrypted image payload round-trip", () => {
	it("encrypts rawImages in PayloadV1, decrypts on unlockPayload, and preserves across reencryptRealText and changePassword", async () => {
		const sampleBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
		const rawImages = {
			"Pasted image 2026.png": {
				mime: "image/png",
				data: sampleBytes,
			},
		};

		const { fileContent, payload } = await createFile(
			REAL,
			PASSWORD,
			DECOY,
			undefined,
			rawImages,
		);

		expect(payload.images).toBeDefined();
		const encEntry = payload.images?.["Pasted image 2026.png"];
		expect(encEntry).toBeDefined();
		expect(encEntry?.mime).toBe("image/png");
		expect(encEntry?.ct).not.toBe(Buffer.from(sampleBytes).toString("base64"));

		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		if (!parsed) throw new Error("Expected parsed file");

		const unlocked = await unlockPayload(parsed.payload, PASSWORD);
		expect(unlocked.realText).toBe(REAL);
		expect(unlocked.images["Pasted image 2026.png"]).toBeDefined();
		expect(unlocked.images["Pasted image 2026.png"]?.mime).toBe("image/png");
		expect(Array.from(unlocked.images["Pasted image 2026.png"]?.data ?? [])).toEqual(
			Array.from(sampleBytes),
		);

		const reencrypted = await reencryptRealText(
			parsed.payload,
			unlocked.dek,
			`${REAL}\nEdited line`,
		);
		unlocked.dek.fill(0);
		expect(reencrypted.images).toEqual(parsed.payload.images);

		const rotated = await changePassword(reencrypted, PASSWORD, "new secret passphrase");
		expect(rotated.images).toEqual(parsed.payload.images);

		const unlockedAfterRotate = await unlockPayload(rotated, "new secret passphrase");
		expect(unlockedAfterRotate.realText).toBe(`${REAL}\nEdited line`);
		expect(
			Array.from(unlockedAfterRotate.images["Pasted image 2026.png"]?.data ?? []),
		).toEqual(Array.from(sampleBytes));
		unlockedAfterRotate.dek.fill(0);
	});

	it("absorbs and restores vault images via mock App", async () => {
		const rawBytes = new Uint8Array([10, 20, 30, 40]);
		const deletedFiles: string[] = [];
		const createdFiles = new Map<string, Uint8Array>();

		const fakeFile = {
			path: "Pasted image 2026.png",
			name: "Pasted image 2026.png",
			extension: "png",
		};

		const mockApp = {
			metadataCache: {
				getFirstLinkpathDest: (link: string) =>
					link === "Pasted image 2026.png" ? fakeFile : null,
			},
			vault: {
				getAbstractFileByPath: (path: string) =>
					createdFiles.has(path) ? { path, name: path, extension: "png" } : null,
				readBinary: async () => rawBytes.buffer.slice(0),
				delete: async (file: { path: string }) => {
					deletedFiles.push(file.path);
				},
				createFolder: async () => undefined,
				createBinary: async (path: string, data: ArrayBuffer) => {
					createdFiles.set(path, new Uint8Array(data));
				},
			},
		};

		const absorbed = await absorbVaultImages(
			mockApp as unknown as import("obsidian").App,
			"Note.md",
			REAL,
		);
		expect(deletedFiles).toEqual(["Pasted image 2026.png"]);
		expect(Array.from(absorbed["Pasted image 2026.png"]?.data ?? [])).toEqual([10, 20, 30, 40]);

		await restoreVaultImages(mockApp as unknown as import("obsidian").App, "", absorbed);
		expect(Array.from(createdFiles.get("Pasted image 2026.png") ?? [])).toEqual([
			10, 20, 30, 40,
		]);
	});

	it("skips deleting a staged image if its file stat changed before deleteStagedVaultImages", async () => {
		const rawBytes = new Uint8Array([10, 20, 30, 40]);
		const deletedFiles: string[] = [];
		const fakeFile = {
			path: "Pasted image 2026.png",
			name: "Pasted image 2026.png",
			extension: "png",
			stat: { mtime: 1000, size: 4 },
		};

		const mockApp = {
			metadataCache: {
				getFirstLinkpathDest: (link: string) =>
					link === "Pasted image 2026.png" ? fakeFile : null,
			},
			vault: {
				readBinary: async () => rawBytes.buffer.slice(0),
				delete: async (file: { path: string }) => {
					deletedFiles.push(file.path);
				},
			},
		} as unknown as import("obsidian").App;

		const staged = await readLinkedVaultImages(mockApp, "Note.md", REAL);
		fakeFile.stat.mtime = 2000;
		await deleteStagedVaultImages(mockApp, staged.filesToDelete);

		expect(deletedFiles).toEqual([]);
	});
});

describe("buildUnlockedImageExtension O(1) token gating", () => {
	it("short-circuits when token is null, rebuilds on token transition even when docChanged is false, skips cursor-only updates, and resets on lock", () => {
		let currentToken: string | null = null;
		const getImageUrl = vi.fn((_state: EditorState, link: string) =>
			link === "secret.png" ? "blob:1" : null,
		);
		const getImageStateToken = vi.fn(() => currentToken);

		const plugin = buildUnlockedImageExtension(getImageUrl, getImageStateToken) as unknown as {
			create: (view: EditorView) => {
				decorations: DecorationSet;
				update: (update: ViewUpdate) => void;
			};
		};

		const state = EditorState.create({ doc: "![[secret.png]]\nline two" });
		const lineAtSpy = vi.spyOn(state.doc, "lineAt");
		const view = {
			state,
			visibleRanges: [{ from: 0, to: state.doc.length }],
		} as unknown as EditorView;

		const instance = plugin.create(view);
		expect(lineAtSpy).toHaveBeenCalledTimes(0);
		expect(getImageUrl).toHaveBeenCalledTimes(0);
		expect(instance.decorations).toBe(Decoration.none);

		instance.update({
			docChanged: true,
			viewportChanged: true,
			state,
			view,
		} as unknown as ViewUpdate);
		expect(lineAtSpy).toHaveBeenCalledTimes(0);
		expect(getImageUrl).toHaveBeenCalledTimes(0);
		expect(instance.decorations).toBe(Decoration.none);

		currentToken = "secret.png\0blob:1\n";
		instance.update({
			docChanged: false,
			viewportChanged: false,
			state,
			view,
		} as unknown as ViewUpdate);
		expect(lineAtSpy).toHaveBeenCalled();
		expect(getImageUrl).toHaveBeenCalledWith(state, "secret.png");
		expect(instance.decorations.size).toBe(1);

		lineAtSpy.mockClear();
		getImageUrl.mockClear();
		instance.update({
			docChanged: false,
			viewportChanged: false,
			state,
			view,
		} as unknown as ViewUpdate);
		expect(lineAtSpy).toHaveBeenCalledTimes(0);
		expect(getImageUrl).toHaveBeenCalledTimes(0);
		expect(instance.decorations.size).toBe(1);

		currentToken = null;
		instance.update({
			docChanged: false,
			viewportChanged: false,
			state,
			view,
		} as unknown as ViewUpdate);
		expect(lineAtSpy).toHaveBeenCalledTimes(0);
		expect(getImageUrl).toHaveBeenCalledTimes(0);
		expect(instance.decorations).toBe(Decoration.none);
	});
});

describe("countWords, countLines, WordCounter, and debounced scheduleWordCounterUpdate", () => {
	it("computes word and line counts without array splits and updates status bar item", () => {
		expect(countWords("")).toBe(0);
		expect(countWords("   \n\t  ")).toBe(0);
		expect(countWords("one two\nthree\tfour")).toBe(4);

		expect(countLines("")).toBe(0);
		expect(countLines("single")).toBe(1);
		expect(countLines("a\nb\nc")).toBe(3);

		let textContent = "";
		let visible = true;
		const mockEl = {
			addClass: vi.fn(),
			setText: vi.fn((t: string) => {
				textContent = t;
			}),
			show: vi.fn(() => {
				visible = true;
			}),
			hide: vi.fn(() => {
				visible = false;
			}),
		} as unknown as HTMLElement;

		const counter = new WordCounter(() => mockEl);
		expect(visible).toBe(false);

		const sample = "one two\nthree\tfour";
		counter.update(sample, "unlocked");
		expect(textContent).toBe("4 words | 18 chars | 2 lines");
		expect(visible).toBe(true);

		counter.update(sample, "locked", { chars: 18, lines: 2 });
		expect(textContent).toBe("4 words | 18 chars | 2 lines");
		expect(visible).toBe(true);

		counter.update(sample, "normal");
		expect(visible).toBe(false);

		counter.update("", "unlocked");
		expect(visible).toBe(false);
	});

	it("coalesces rapid scheduleWordCounterUpdate calls within 150 ms and cancels pending timer on teardown", () => {
		vi.useFakeTimers();
		try {
			const updateSpy = vi.fn();
			const plugin = Object.create(VeneerPlugin.prototype) as VeneerPlugin;
			Object.assign(plugin, {
				isShuttingDown: false,
				teardownDone: false,
				wordCounterTimer: null,
				updateWordCounter: updateSpy,
			});

			const schedule = (
				plugin as unknown as { scheduleWordCounterUpdate: () => void }
			).scheduleWordCounterUpdate.bind(plugin);

			for (let i = 0; i < 10; i += 1) {
				schedule();
				vi.advanceTimersByTime(10);
			}
			expect(updateSpy).toHaveBeenCalledTimes(0);

			vi.advanceTimersByTime(WORD_COUNTER_DEBOUNCE_MS);
			expect(updateSpy).toHaveBeenCalledTimes(1);

			schedule();
			plugin.teardown();
			vi.advanceTimersByTime(WORD_COUNTER_DEBOUNCE_MS * 2);
			expect(updateSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
