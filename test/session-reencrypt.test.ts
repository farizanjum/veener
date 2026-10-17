import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, MarkdownView, TFile } from "obsidian";
import { createFile, parseFileContent, unlockPayload } from "../src/crypto/payload";
import { REENCRYPT_DEBOUNCE_MS, SessionManager } from "../src/view/session";

const DECOY = "## Weekend Grocery List\n\n- milk, eggs, bread";
const INITIAL_REAL = "Top secret project roadmap v1";
const PASSWORD = "correct horse battery staple";

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function createMockEnv(
	initialEditorText = INITIAL_REAL,
	readBinaryGate?: Promise<void>,
	shouldFailModify = false,
) {
	let editorText = initialEditorText;
	let requestSaveCount = 0;
	let metadataLookups = 0;
	const deletedImages: string[] = [];
	const modifiedFiles: Array<{ path: string; content: string }> = [];
	const rawImageBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

	const fakeFile = {
		path: "Weekend Grocery List.md",
		basename: "Weekend Grocery List",
		name: "Weekend Grocery List.md",
		extension: "md",
	} as unknown as TFile;

	const fakeImageFile = {
		path: "Pasted chart.png",
		name: "Pasted chart.png",
		extension: "png",
	};

	const mockView = {
		file: fakeFile,
		editor: {
			getValue: () => editorText,
			cm: {
				dispatch: vi.fn(),
			},
		},
		setViewData: (data: string) => {
			editorText = data;
		},
		requestSave: () => {
			requestSaveCount += 1;
		},
	} as unknown as MarkdownView;

	const mockApp = {
		metadataCache: {
			getFirstLinkpathDest: (link: string) => {
				metadataLookups += 1;
				return link === "Pasted chart.png" ? fakeImageFile : null;
			},
		},
		vault: {
			readBinary: async () => {
				if (readBinaryGate) {
					await readBinaryGate;
				}
				return rawImageBytes.buffer.slice(0);
			},
			delete: async (file: { path: string }) => {
				deletedImages.push(file.path);
			},
			modify: async (file: { path: string }, content: string) => {
				if (shouldFailModify) {
					throw new Error("disk full");
				}
				modifiedFiles.push({ path: file.path, content });
			},
		},
	} as unknown as App;

	const manager = new SessionManager(
		mockApp,
		{
			onUnlocked: () => undefined,
			onLocked: () => undefined,
			onUnlockBlocked: () => undefined,
		},
		() => ";;",
		() => null,
	);

	return {
		manager,
		mockView,
		fakeFile,
		setEditorText: (next: string) => {
			editorText = next;
		},
		getRequestSaveCount: () => requestSaveCount,
		getMetadataLookups: () => metadataLookups,
		deletedImages,
		modifiedFiles,
		rawImageBytes,
	};
}

describe("SessionManager.scheduleReencrypt (Issue #1)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sets REENCRYPT_DEBOUNCE_MS to 600ms to prevent excessive crypto churn on fast typing", () => {
		expect(REENCRYPT_DEBOUNCE_MS).toBe(600);
	});

	it("debounces rapid edits, updates session.pendingPayload with fresh ciphertext, and triggers requestSave", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY, undefined, undefined, "Roadmap");
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		const outcome = await env.manager.unlock(session, PASSWORD);
		expect(outcome).toBe("ok");
		expect(session.state).toBe("unlocked");

		env.setEditorText("Top secret project roadmap v2 - draft");
		env.manager.scheduleReencrypt(session);
		const firstTimer = session.reencryptTimer;
		expect(firstTimer).not.toBeNull();

		env.setEditorText("Top secret project roadmap v2 - final");
		env.manager.scheduleReencrypt(session);
		expect(session.reencryptTimer).not.toBeNull();
		expect(session.reencryptTimer).not.toBe(firstTimer);

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;

		expect(session.reencryptTimer).toBeNull();
		expect(session.pendingPayload).not.toBeNull();
		expect(session.pendingPayload).not.toBe(parsed.payload);
		expect(env.getRequestSaveCount()).toBe(1);
		expect(env.getMetadataLookups()).toBe(0);

		const unlockedPending = await unlockPayload(session.pendingPayload!, PASSWORD);
		expect(unlockedPending.realText).toBe("Top secret project roadmap v2 - final");
		unlockedPending.dek.fill(0);

		await env.manager.lock(session, "test-cleanup");
	});

	it("absorbs newly pasted vault images during scheduleReencrypt and deletes source only after saving", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		env.manager.scheduleReencrypt(session);

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;

		expect(env.modifiedFiles.length).toBeGreaterThanOrEqual(1);
		expect(env.deletedImages).toEqual(["Pasted chart.png"]);
		expect(session.originalPayload.images?.["Pasted chart.png"]).toBeDefined();
		expect(session.pendingPayload?.images?.["Pasted chart.png"]).toBeDefined();

		const unlockedPending = await unlockPayload(session.pendingPayload!, PASSWORD);
		expect(unlockedPending.realText).toBe(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		expect(Array.from(unlockedPending.images["Pasted chart.png"]?.data ?? [])).toEqual(
			Array.from(env.rawImageBytes),
		);
		unlockedPending.dek.fill(0);

		await env.manager.lock(session, "test-cleanup");
	});

	it("does not delete source image if user removes embed and locks while image read is in-flight", async () => {
		const gate = createDeferred<void>();
		const env = createMockEnv(INITIAL_REAL, gate.promise);
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		env.manager.scheduleReencrypt(session);

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		expect(session.reencryptPromise).not.toBeNull();

		env.setEditorText(`${INITIAL_REAL}\nRemoved the image embed before lock`);
		const lockPromise = env.manager.lock(session, "tab-switch");
		gate.resolve();
		await lockPromise;

		expect(session.state).toBe("locked");
		expect(env.deletedImages).toEqual([]);
		const lastSaved = parseFileContent(env.modifiedFiles[env.modifiedFiles.length - 1]!.content)!;
		const unlocked = await unlockPayload(lastSaved.payload, PASSWORD);
		expect(unlocked.realText).toBe(`${INITIAL_REAL}\nRemoved the image embed before lock`);
		expect(unlocked.images["Pasted chart.png"]).toBeUndefined();
		unlocked.dek.fill(0);
	});

	it("prevents an older in-flight reencrypt job from overwriting a newer edit", async () => {
		const gate = createDeferred<void>();
		const env = createMockEnv(INITIAL_REAL, gate.promise);
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]\nOlder edit v1`);
		env.manager.scheduleReencrypt(session);

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		expect(session.reencryptPromise).not.toBeNull();

		env.setEditorText(`${INITIAL_REAL}\nNewer edit v2 without image`);
		env.manager.scheduleReencrypt(session);
		gate.resolve();

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;

		expect(env.deletedImages).toEqual([]);
		expect(session.pendingPayload).not.toBeNull();
		const unlocked = await unlockPayload(session.pendingPayload!, PASSWORD);
		expect(unlocked.realText).toBe(`${INITIAL_REAL}\nNewer edit v2 without image`);
		unlocked.dek.fill(0);

		await env.manager.lock(session, "test-cleanup");
	});

	it("cancels pending scheduleReencrypt timer when lock() is called before debounce expires", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText("Edited right before lock");
		env.manager.scheduleReencrypt(session);
		expect(session.reencryptTimer).not.toBeNull();

		await env.manager.lock(session, "manual-lock");
		expect(session.state).toBe("locked");
		expect(session.reencryptTimer).toBeNull();
		expect(session.pendingPayload).toBeNull();

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS + 150);
		expect(session.pendingPayload).toBeNull();
		expect(env.getRequestSaveCount()).toBe(0);
	});

	it("keeps source image intact and rolls back pendingPayload if vault.modify throws during scheduleReencrypt", async () => {
		const env = createMockEnv(INITIAL_REAL, undefined, true);
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);
		const initialPending = session.pendingPayload;

		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		env.manager.scheduleReencrypt(session);

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;

		expect(env.deletedImages).toEqual([]);
		expect(session.pendingPayload).toBe(initialPending);
		expect(session.originalPayload).toBe(parsed.payload);
	});

	it("does not lock or overwrite real text with decoy if attachFromLoad receives the session's own saved payload", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText("Updated secret text while unlocked");
		env.manager.scheduleReencrypt(session);

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;

		const savedDiskContent = env.modifiedFiles[env.modifiedFiles.length - 1]!.content;
		const reparsed = parseFileContent(savedDiskContent)!;

		env.manager.attachFromLoad(env.mockView, env.fakeFile, reparsed);

		expect(session.state).toBe("unlocked");
		expect(env.mockView.editor.getValue()).toBe("Updated secret text while unlocked");

		await env.manager.lock(session, "test-cleanup");
		const finalSaved = parseFileContent(env.modifiedFiles[env.modifiedFiles.length - 1]!.content)!;
		const unlocked = await unlockPayload(finalSaved.payload, PASSWORD);
		expect(unlocked.realText).toBe("Updated secret text while unlocked");
		unlocked.dek.fill(0);
	});

	it("masks in memory without encrypting decoy over disk when an external reload delivers a different payload", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		const external = await createFile("External update from another device", PASSWORD, DECOY);
		const externalParsed = parseFileContent(external.fileContent)!;

		env.setEditorText(DECOY);
		env.manager.attachFromLoad(env.mockView, env.fakeFile, externalParsed);

		expect(session.state).toBe("locked");
		expect(env.modifiedFiles).toEqual([]);
		const unlocked = await unlockPayload(session.originalPayload, PASSWORD);
		expect(unlocked.realText).toBe("External update from another device");
		unlocked.dek.fill(0);
	});
});
