import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, type App, type TFile } from "obsidian";
import { createFile, parseFileContent, unlockPayload } from "../src/crypto/payload";
import { installViewPatches } from "../src/view/patch";
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
	linkTargets?: Record<string, { path: string; name: string; extension: string }>,
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
		stat: { mtime: 1000, size: rawImageBytes.byteLength },
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
				return linkTargets?.[link] ?? (link === "Pasted chart.png" ? fakeImageFile : null);
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
		setImageStat: (mtime: number, size: number) => {
			fakeImageFile.stat = { mtime, size };
		},
	};
}

/** Replaces the global blob URL factory so preview URL identity and revocation are assertable. */
function stubObjectUrls() {
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	let counter = 0;
	const revoked = new Set<string>();
	URL.createObjectURL = (_blob: Blob | MediaSource): string => {
		counter += 1;
		return `blob:test/${counter}`;
	};
	URL.revokeObjectURL = (url: string): void => {
		revoked.add(url);
	};
	return {
		revoked,
		restore: () => {
			URL.createObjectURL = originalCreate;
			URL.revokeObjectURL = originalRevoke;
		},
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

	it("debounces rapid edits and updates session.pendingPayload with fresh ciphertext", async () => {
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

	it("stages newly pasted vault images into pendingPayload during scheduleReencrypt and deletes source only when lock() saves to disk", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		env.manager.scheduleReencrypt(session);

		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;

		expect(env.deletedImages).toEqual([]);
		expect(session.pendingPayload?.images?.["Pasted chart.png"]).toBeDefined();

		const unlockedPending = await unlockPayload(session.pendingPayload!, PASSWORD);
		expect(unlockedPending.realText).toBe(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		expect(Array.from(unlockedPending.images["Pasted chart.png"]?.data ?? [])).toEqual(
			Array.from(env.rawImageBytes),
		);
		unlockedPending.dek.fill(0);

		await env.manager.lock(session, "test-cleanup");
		expect(env.modifiedFiles.length).toBe(1);
		expect(env.deletedImages).toEqual(["Pasted chart.png"]);
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
	});

	it("keeps source image intact if vault.modify throws during lock()", async () => {
		const env = createMockEnv(INITIAL_REAL, undefined, true);
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		await expect(env.manager.lock(session, "lock-with-disk-error")).rejects.toThrow("disk full");

		expect(env.deletedImages).toEqual([]);
		expect(session.state).toBe("locked");
	});

	it("keeps one shared preview URL alive across every key referencing the same image data", async () => {
		const urls = stubObjectUrls();
		try {
			const env = createMockEnv(INITIAL_REAL, undefined, false, {
				"attachments/Pasted chart.png": {
					path: "attachments/Pasted chart.png",
					name: "Pasted chart.png",
					extension: "png",
				},
			});
			const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
			const parsed = parseFileContent(fileContent)!;

			const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
			await env.manager.unlock(session, PASSWORD);

			env.setEditorText(`${INITIAL_REAL}\n![[attachments/Pasted chart.png]]`);
			env.manager.scheduleReencrypt(session);
			await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
			if (session.reencryptPromise) await session.reencryptPromise;

			const linkUrl = session.imageUrls.get("attachments/Pasted chart.png");
			const basenameUrl = session.imageUrls.get("Pasted chart.png");
			expect(linkUrl).toBeDefined();
			expect(basenameUrl).toBe(linkUrl);
			for (const url of session.imageUrls.values()) {
				expect(urls.revoked.has(url)).toBe(false);
			}

			await env.manager.lock(session, "test-cleanup");
		} finally {
			urls.restore();
		}
	});

	it("gives distinct images with distinct data their own preview URLs without revoking either", async () => {
		const urls = stubObjectUrls();
		try {
			const env = createMockEnv();
			const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY, undefined, {
				"attachments/chart.png": { mime: "image/png", data: new Uint8Array([1, 2, 3]) },
				"chart.png": { mime: "image/png", data: new Uint8Array([9, 9, 9]) },
			});
			const parsed = parseFileContent(fileContent)!;

			const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
			await env.manager.unlock(session, PASSWORD);

			const folderUrl = session.imageUrls.get("attachments/chart.png");
			const rootUrl = session.imageUrls.get("chart.png");
			expect(folderUrl).toBeDefined();
			expect(rootUrl).toBeDefined();
			expect(folderUrl).not.toBe(rootUrl);
			expect(urls.revoked.size).toBe(0);

			await env.manager.lock(session, "test-cleanup");
		} finally {
			urls.restore();
		}
	});

	it("deletes a staged source image only once its own payload is reported as saved", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		env.manager.scheduleReencrypt(session);
		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;

		const persisted = session.pendingPayload!;
		expect(persisted).not.toBeNull();
		expect(session.stagedFilesByPayload.get(persisted)?.length).toBe(1);
		expect(env.deletedImages).toEqual([]);
		expect(env.manager.savedPayloadFor(session)).toBe(persisted);

		await env.manager.commitPersistedPayload(session, { ...persisted });
		expect(env.deletedImages).toEqual([]);
		expect(session.stagedFilesByPayload.get(persisted)?.length).toBe(1);

		await env.manager.commitPersistedPayload(session, persisted);
		expect(env.deletedImages).toEqual(["Pasted chart.png"]);
		expect(session.stagedFilesByPayload.get(persisted)).toBeUndefined();
		expect(session.originalPayload).toBe(persisted);

		await env.manager.commitPersistedPayload(session, persisted);
		expect(env.deletedImages).toEqual(["Pasted chart.png"]);

		await env.manager.lock(session, "test-cleanup");
	});

	it("does not delete a staged source whose embed was removed before lock()", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		env.manager.scheduleReencrypt(session);
		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;

		const stagedPayload = session.pendingPayload!;
		expect(session.stagedFilesByPayload.get(stagedPayload)?.length).toBe(1);
		expect(env.deletedImages).toEqual([]);

		env.setEditorText(`${INITIAL_REAL}\nDropped the embed before locking`);
		await env.manager.lock(session, "test-cleanup");

		expect(env.deletedImages).toEqual([]);
		const lastSaved = parseFileContent(env.modifiedFiles[env.modifiedFiles.length - 1]!.content)!;
		const unlocked = await unlockPayload(lastSaved.payload, PASSWORD);
		expect(unlocked.realText).toBe(`${INITIAL_REAL}\nDropped the embed before locking`);
		expect(unlocked.images["Pasted chart.png"]).toBeUndefined();
		unlocked.dek.fill(0);
	});

	it("releases a staged source only for the payload whose snapshot still matches the file on disk", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		env.setImageStat(1000, env.rawImageBytes.byteLength);
		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		env.manager.scheduleReencrypt(session);
		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;
		const firstPayload = session.pendingPayload!;
		expect(session.stagedFilesByPayload.get(firstPayload)?.length).toBe(1);

		env.setImageStat(2000, env.rawImageBytes.byteLength);
		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]\nSecond edit`);
		env.manager.scheduleReencrypt(session);
		await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
		if (session.reencryptPromise) await session.reencryptPromise;
		const secondPayload = session.pendingPayload!;
		expect(secondPayload).not.toBe(firstPayload);
		expect(session.stagedFilesByPayload.get(secondPayload)?.length).toBe(1);

		await env.manager.commitPersistedPayload(session, firstPayload);
		expect(env.deletedImages).toEqual([]);

		await env.manager.commitPersistedPayload(session, secondPayload);
		expect(env.deletedImages).toEqual(["Pasted chart.png"]);
	});

	it("serializes MarkdownView.save() with lock() so an in-flight save cannot overwrite newer locked ciphertext", async () => {
		const saveGate = createDeferred<void>();
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		// Wire a Base TextFileView-like save onto MarkdownView.prototype before
		// installViewPatches captures it, so the patched save wraps a save that
		// can be suspended mid-write.
		const proto = MarkdownView.prototype as unknown as {
			data: string;
			file: TFile;
			setViewData: (data: string, clear: boolean) => void;
			getViewData: () => string;
			save: () => Promise<void>;
		};
		proto.setViewData = (data: string) => {
			env.setEditorText(data);
		};
		proto.getViewData = () => env.mockView.editor.getValue();
		proto.save = async function (this: { file: TFile; data: string }) {
			await saveGate.promise;
			await (env.manager as unknown as { app: App }).app.vault.modify(this.file, this.data);
		};

		const cleanups: Array<() => void> = [];
		installViewPatches(env.manager, (fn) => cleanups.push(fn));
		Object.setPrototypeOf(env.mockView, MarkdownView.prototype);
		delete (env.mockView as unknown as { setViewData?: unknown }).setViewData;

		try {
			const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
			await env.manager.unlock(session, PASSWORD);

			env.setEditorText("Older edit v1");
			env.manager.scheduleReencrypt(session);
			await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
			if (session.reencryptPromise) await session.reencryptPromise;

			// Start the save first and let it suspend inside its disk write.
			const inFlightSave = env.mockView.save();

			// A newer edit plus a lock while that save is still in flight. The
			// write queue must hold lock()'s vault write until the save lands, so
			// nothing reaches disk until the gate below is released.
			env.setEditorText("Newest edit before lock v2");
			const lockPromise = env.manager.lock(session, "manual");

			const writesBeforeRelease = env.modifiedFiles.length;
			for (let tick = 0; tick < 50; tick += 1) {
				if (env.modifiedFiles.length > writesBeforeRelease) break;
				await vi.advanceTimersByTimeAsync(0);
			}
			const lockWroteBeforeRelease =
				env.modifiedFiles.length > writesBeforeRelease;

			saveGate.resolve();
			await Promise.all([inFlightSave, lockPromise]);

			expect(session.state).toBe("locked");

			// Census every write to the note: the newest locked ciphertext must be
			// the last thing on disk regardless of which write started first.
			const persistedTexts: string[] = [];
			for (const entry of env.modifiedFiles) {
				if (entry.path !== env.fakeFile.path) continue;
				const parsedEntry = parseFileContent(entry.content);
				if (!parsedEntry) continue;
				const unlocked = await unlockPayload(parsedEntry.payload, PASSWORD);
				persistedTexts.push(unlocked.realText);
				unlocked.dek.fill(0);
			}

			expect(persistedTexts).toContain("Older edit v1");
			expect(persistedTexts[persistedTexts.length - 1]).toBe(
				"Newest edit before lock v2",
			);
			expect(lockWroteBeforeRelease).toBe(false);
		} finally {
			for (const cleanup of cleanups) cleanup();
		}
	});
});
