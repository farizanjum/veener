import { describe, expect, it, vi } from "vitest";
import type { App, MarkdownView, TFile } from "obsidian";
import { SessionManager, type SessionHooks } from "../src/view/session";
import {
	changePassword,
	createFile,
	parseFileContent,
	unlockPayload,
} from "../src/crypto/payload";
import { computeSavedContent } from "../src/view/saveDecision";

const DECOY = "## Grocery list\n\n- milk, eggs, bread";
const INITIAL_REAL = "Top secret project alpha notes";
const EDITED_REAL = "Top secret project alpha notes\nUpdated line in RAM";
const LATE_EDITED_REAL = "Top secret project alpha notes\nUpdated line in RAM\nTyped during image load";
const PASSWORD = "correct horse battery staple";

interface FakePane {
	readonly view: MarkdownView;
	getEditorText(): string;
	setEditorText(next: string): void;
	setFile(next: TFile | null): void;
}

interface FakeHarness {
	readonly app: App;
	readonly file: TFile;
	readonly view: MarkdownView;
	readonly hooks: SessionHooks;
	readonly modifyCalls: string[];
	readonly lockedCount: () => number;
	readonly lockFailedErrors: unknown[];
	getEditorText(): string;
	setEditorText(next: string): void;
	setFile(next: TFile | null): void;
	createPane(initialText?: string): FakePane;
	setImageLookupDelay(delayMs: number, onLookup?: () => void): void;
	setModifyFailure(error: Error | null): void;
}

function createFakeHarness(initialEditorText: string): FakeHarness {
	let lockedEvents = 0;
	const lockFailedErrors: unknown[] = [];
	const modifyCalls: string[] = [];
	let imageLookupDelayMs = 0;
	let onImageLookup: (() => void) | undefined;
	let modifyFailure: Error | null = null;

	const file = {
		path: "Weekend Errands.md",
		name: "Weekend Errands.md",
		basename: "Weekend Errands",
		extension: "md",
	} as unknown as TFile;

	function createPane(initialText: string = initialEditorText): FakePane {
		let paneText = initialText;
		const viewObj: {
			file: TFile | null;
			editor: { getValue: () => string };
			setViewData: (data: string) => void;
		} = {
			file,
			editor: {
				getValue: () => paneText,
			},
			setViewData: (data: string) => {
				paneText = data;
			},
		};
		return {
			view: viewObj as unknown as MarkdownView,
			getEditorText: () => paneText,
			setEditorText: (next: string) => {
				paneText = next;
			},
			setFile: (next: TFile | null) => {
				viewObj.file = next;
			},
		};
	}

	const primaryPane = createPane(initialEditorText);

	const fakeImageFile = {
		path: "Pasted image.png",
		name: "Pasted image.png",
		extension: "png",
	};

	const app = {
		metadataCache: {
			getFirstLinkpathDest: (link: string) => {
				onImageLookup?.();
				return link === "Pasted image.png" ? fakeImageFile : null;
			},
		},
		vault: {
			getAbstractFileByPath: () => null,
			readBinary: async () => {
				if (imageLookupDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, imageLookupDelayMs));
				}
				return new Uint8Array([137, 80, 78, 71]).buffer;
			},
			delete: async () => undefined,
			modify: async (_target: TFile, data: string) => {
				await new Promise((resolve) => setTimeout(resolve, 15));
				if (modifyFailure !== null) {
					const err = modifyFailure;
					modifyFailure = null;
					throw err;
				}
				modifyCalls.push(data);
			},
		},
	} as unknown as App;

	const hooks: SessionHooks = {
		onUnlocked: () => undefined,
		onLocked: () => {
			lockedEvents += 1;
		},
		onUnlockBlocked: () => undefined,
		onLockFailed: (error: unknown) => {
			lockFailedErrors.push(error);
		},
	};

	return {
		app,
		file,
		view: primaryPane.view,
		hooks,
		modifyCalls,
		lockedCount: () => lockedEvents,
		lockFailedErrors,
		getEditorText: primaryPane.getEditorText,
		setEditorText: primaryPane.setEditorText,
		setFile: primaryPane.setFile,
		createPane,
		setImageLookupDelay: (delayMs: number, callback?: () => void) => {
			imageLookupDelayMs = delayMs;
			onImageLookup = callback;
		},
		setModifyFailure: (error: Error | null) => {
			modifyFailure = error;
		},
	};
}

describe("SessionManager race conditions (Issue #2)", () => {
	it("coalesces concurrent lock() calls and never overwrites real text with decoy", async () => {
		// Given: an unlocked session whose user has edited the real note in RAM
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		const outcome = await sessions.unlock(session, PASSWORD);
		expect(outcome).toBe("ok");
		harness.setEditorText(EDITED_REAL);

		// When: two mask triggers fire concurrently
		const firstLock = sessions.lock(session, "leaf-change");
		expect(session.lockingPromise).not.toBeNull();
		const secondLock = sessions.lock(session, "window-blur");
		expect(secondLock).toBe(firstLock);
		await Promise.all([firstLock, secondLock]);

		// Then: vault.modify ran once, persisted the edited real text, and restored decoy to view
		expect(session.lockingPromise).toBeNull();
		expect(session.state).toBe("locked");
		expect(harness.getEditorText()).toBe(DECOY);
		expect(harness.modifyCalls).toHaveLength(1);
		const savedOnDisk = parseFileContent(harness.modifyCalls[0] ?? "");
		expect(savedOnDisk).not.toBeNull();
		if (!savedOnDisk) throw new Error("Expected saved payload on disk");
		const unlockedAgain = await unlockPayload(savedOnDisk.payload, PASSWORD);
		expect(unlockedAgain.realText).toBe(EDITED_REAL);
		unlockedAgain.dek.fill(0);
	});

	it("captures edits typed while absorbNewEditorImages is awaiting during lock()", async () => {
		// Given: an unlocked note containing an embedded image that takes time to read
		const textWithImage = `${EDITED_REAL}\n![[Pasted image.png]]`;
		const finalTypedDuringImageLoad = `${textWithImage}\n${LATE_EDITED_REAL}`;
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		await sessions.unlock(session, PASSWORD);
		harness.setEditorText(textWithImage);

		// When: the user types additional real text while absorbNewEditorImages is awaiting readBinary
		harness.setImageLookupDelay(20, () => {
			harness.setEditorText(finalTypedDuringImageLoad);
		});
		await sessions.lock(session, "layout-change");

		// Then: the saved payload includes the edits made while the image was loading
		expect(harness.modifyCalls).toHaveLength(1);
		const savedOnDisk = parseFileContent(harness.modifyCalls[0] ?? "");
		if (!savedOnDisk) throw new Error("Expected saved payload on disk");
		const unlockedAgain = await unlockPayload(savedOnDisk.payload, PASSWORD);
		expect(unlockedAgain.realText).toBe(finalTypedDuringImageLoad);
		unlockedAgain.dek.fill(0);
	});

	it("snapshots DEK before awaiting and does not write old decoy if view switched files mid-lock", async () => {
		// Given: an unlocked session where a file transition happens while lock() is awaiting
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		await sessions.unlock(session, PASSWORD);
		const textWithImage = `${EDITED_REAL}\n![[Pasted image.png]]`;
		harness.setEditorText(textWithImage);

		const newFile = {
			path: "Other Note.md",
			name: "Other Note.md",
			basename: "Other Note",
			extension: "md",
		} as unknown as TFile;
		const newFileText = "# Normal Second File Content";

		// When: during image absorption, the view switches to a different file and zeroes session.dek
		harness.setImageLookupDelay(20, () => {
			session.dek?.fill(0);
			session.dek = null;
			harness.setFile(newFile);
			harness.setEditorText(newFileText);
		});
		await sessions.lock(session, "file-switch");

		// Then: the original file was still encrypted using the snapshotted DEK, and the new file's editor was not overwritten with the old decoy
		expect(harness.modifyCalls).toHaveLength(1);
		expect(harness.getEditorText()).toBe(newFileText);
		const savedOnDisk = parseFileContent(harness.modifyCalls[0] ?? "");
		if (!savedOnDisk) throw new Error("Expected saved payload on disk");
		const unlockedAgain = await unlockPayload(savedOnDisk.payload, PASSWORD);
		expect(unlockedAgain.realText).toBe(textWithImage);
		unlockedAgain.dek.fill(0);
	});

	it("cancels pending scheduleReencrypt timer synchronously when lock() begins", async () => {
		// Given: an unlocked session with a scheduled debounce re-encryption timer
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		await sessions.unlock(session, PASSWORD);
		harness.setEditorText(EDITED_REAL);
		sessions.scheduleReencrypt(session);
		expect(session.reencryptTimer).not.toBeNull();

		// When: lock() is invoked before the debounce timer fires
		const lockPromise = sessions.lock(session, "manual");

		// Then: the timer is cleared synchronously on lock entry and stays null after completion
		expect(session.reencryptTimer).toBeNull();
		await lockPromise;
		expect(session.reencryptTimer).toBeNull();
		expect(session.pendingPayload).toBeNull();
	});

	it("discardAndDetach zeroes the DEK and detaches without writing decoy back to disk", async () => {
		// Given: an unlocked session with a live DEK in memory
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		await sessions.unlock(session, PASSWORD);
		const liveDek = session.dek;
		expect(liveDek).not.toBeNull();
		harness.setEditorText(EDITED_REAL);

		// When: discardAndDetach is called during permanent unprotection
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		sessions.scheduleReencrypt(session);
		sessions.discardAndDetach(harness.view);

		// Then: DEK bytes are zeroed, session is removed, and neither vault.modify nor decoy view overwrite occurs
		expect(liveDek?.every((byte) => byte === 0)).toBe(true);
		expect(session.dek).toBeNull();
		expect(session.state).toBe("locked");
		expect(session.reencryptTimer).toBeNull();
		expect(clearSpy).toHaveBeenCalled();
		expect(sessions.get(harness.view)).toBeNull();
		expect(sessions.getByPath(harness.file.path)).toBeNull();
		expect(harness.modifyCalls).toHaveLength(0);
		expect(harness.getEditorText()).toBe(EDITED_REAL);
		expect(harness.lockedCount()).toBe(1);
		clearSpy.mockRestore();
	});

	it("synchronizes password rotation and unprotection across multiple panes open to the same file", async () => {
		// Given: two panes (pane1 and pane2) showing the same protected note
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const secondPane = harness.createPane(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);

		const session1 = sessions.attachFromLoad(harness.view, harness.file, parsed);
		const session2 = sessions.attachFromLoad(secondPane.view, harness.file, parsed);
		expect(sessions.getAllByPath(harness.file.path)).toHaveLength(2);

		// Unlock pane 1, edit real text, and lock so both panes receive the flushed payload
		await sessions.unlock(session1, PASSWORD);
		harness.setEditorText(EDITED_REAL);
		await sessions.lock(session1, "change-password");
		expect(session2.originalPayload).toEqual(session1.originalPayload);

		// When: password is rotated across all sessions for the file path
		const newPassword = "brand new passphrase 2026";
		const rotated = await changePassword(session1.originalPayload, PASSWORD, newPassword);
		for (const openSession of sessions.getAllByPath(harness.file.path)) {
			openSession.originalPayload = rotated;
			if (openSession.pendingPayload !== null) {
				openSession.pendingPayload = rotated;
			}
		}

		// Then: saving from the FIRST pane (not just the last attached pane) uses the rotated password
		const savedFromFirstPane = computeSavedContent({
			unlocked: session1.state === "unlocked",
			editorValue: harness.getEditorText(),
			decoyBody: session1.decoyBody,
			originalPayload: session1.originalPayload,
			pendingPayload: session1.pendingPayload,
		});
		const reparsed = parseFileContent(savedFromFirstPane);
		expect(reparsed).not.toBeNull();
		if (!reparsed) throw new Error("Expected reparsed file");
		await expect(unlockPayload(reparsed.payload, PASSWORD)).rejects.toThrow();
		const unlockedWithNew = await unlockPayload(reparsed.payload, newPassword);
		expect(unlockedWithNew.realText).toBe(EDITED_REAL);
		unlockedWithNew.dek.fill(0);

		// And when: unprotecting detaches all sessions for the path
		for (const openSession of sessions.getAllByPath(harness.file.path)) {
			sessions.discardAndDetach(openSession.view);
		}
		expect(sessions.getAllByPath(harness.file.path)).toHaveLength(0);
		expect(sessions.get(harness.view)).toBeNull();
		expect(sessions.get(secondPane.view)).toBeNull();
	});

	it("aborts in-flight lock() disk write if discardAndDetach or hardKillAll runs mid-lock", async () => {
		// Given: an unlocked session whose lock() is awaiting image absorption
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		await sessions.unlock(session, PASSWORD);
		harness.setEditorText(`${EDITED_REAL}\n![[Pasted image.png]]`);

		// When: discardAndDetach runs while lock() is awaiting readBinary
		harness.setImageLookupDelay(20, () => {
			sessions.discardAndDetach(harness.view);
		});
		await sessions.lock(session, "detach-race");

		// Then: the in-flight lock() aborted before calling vault.modify
		expect(harness.modifyCalls).toHaveLength(0);
		expect(session.lockingPromise).toBeNull();
		expect(session.dek).toBeNull();
	});

	it("rejects the shared lock() promise and invokes onLockFailed when vault.modify throws", async () => {
		// Given: an unlocked session whose vault.modify will throw on the next write
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		await sessions.unlock(session, PASSWORD);
		harness.setEditorText(EDITED_REAL);
		const diskError = new Error("ENOSPC: no space left on device");
		harness.setModifyFailure(diskError);

		// When: lock() runs and encounters the modify failure
		await expect(sessions.lock(session, "manual")).rejects.toThrow("ENOSPC: no space left on device");

		// Then: the session still zeroes keys, restores decoy, and surfaces the failure via onLockFailed
		expect(session.state).toBe("locked");
		expect(session.dek).toBeNull();
		expect(session.lockingPromise).toBeNull();
		expect(harness.getEditorText()).toBe(DECOY);
		expect(harness.lockFailedErrors).toEqual([diskError]);
	});

	it("prevents absorbNewEditorImages from merging images or creating blob URLs after hardKillAll mid-lock", async () => {
		// Given: an unlocked session with an embedded image and stubbed URL.createObjectURL
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const createdUrls: string[] = [];
		const revokedUrls: string[] = [];
		const originalCreate = URL.createObjectURL;
		const originalRevoke = URL.revokeObjectURL;
		URL.createObjectURL = () => {
			const u = `blob:test-${createdUrls.length + 1}`;
			createdUrls.push(u);
			return u;
		};
		URL.revokeObjectURL = (u: string) => {
			revokedUrls.push(u);
		};

		try {
			const harness = createFakeHarness(DECOY);
			const sessions = new SessionManager(
				harness.app,
				harness.hooks,
				() => ";;",
				() => null,
			);
			const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
			await sessions.unlock(session, PASSWORD);
			harness.setEditorText(`${EDITED_REAL}\n![[Pasted image.png]]`);

			// When: hardKillAll runs while absorbNewEditorImages is awaiting readBinary
			harness.setImageLookupDelay(20, () => {
				sessions.hardKillAll();
			});
			await sessions.lock(session, "shred-race");

			// Then: the image was never merged into originalPayload and no unrevoked blob URLs remain
			expect(session.originalPayload.images?.["Pasted image.png"]).toBeUndefined();
			expect(session.imageUrls.size).toBe(0);
			expect(createdUrls).toHaveLength(0);
			expect(harness.modifyCalls).toHaveLength(0);
		} finally {
			URL.createObjectURL = originalCreate;
			URL.revokeObjectURL = originalRevoke;
		}
	});

	it("aborts an in-flight unlock() and zeroes the derived DEK if hardKillAll runs before unlockPayload resolves", async () => {
		// Given: a locked session with a valid password
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);

		// When: unlock() is started and hardKillAll() runs synchronously while Argon2id is in flight
		const unlockPromise = sessions.unlock(session, PASSWORD);
		sessions.hardKillAll();
		const outcome = await unlockPromise;

		// Then: unlock returns "blocked" silently, keeps state locked, and leaves decoy in the editor
		expect(outcome).toBe("blocked");
		expect(session.state).toBe("locked");
		expect(session.dek).toBeNull();
		expect(harness.getEditorText()).toBe(DECOY);
	});

	it("reports hasLiveSession accurately across locked, unlocked, in-flight lock, and detached states", async () => {
		// Given: a newly attached locked session
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(false);

		// When: the session is unlocked and then locked
		await sessions.unlock(session, PASSWORD);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(true);
		const lockPromise = sessions.lock(session, "manual");
		expect(sessions.hasLiveSession(harness.file.path)).toBe(true);
		await lockPromise;
		expect(sessions.hasLiveSession(harness.file.path)).toBe(false);

		// Then: unlocking again and calling discardAndDetach clears live status immediately
		await sessions.unlock(session, PASSWORD);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(true);
		sessions.discardAndDetach(harness.view);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(false);
	});

	it("masks all remaining sessions in lockAll even when the first session's lock fails, then rethrows the first error", async () => {
		// Given: two unlocked sessions where the first session's vault.modify fails
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const secondPane = harness.createPane(DECOY);
		const secondFile = {
			path: "Second Secret.md",
			name: "Second Secret.md",
			basename: "Second Secret",
			extension: "md",
		} as unknown as TFile;
		secondPane.setFile(secondFile);

		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session1 = sessions.attachFromLoad(harness.view, harness.file, parsed);
		const session2 = sessions.attachFromLoad(secondPane.view, secondFile, parsed);
		await sessions.unlock(session1, PASSWORD);
		await sessions.unlock(session2, PASSWORD);
		harness.setEditorText(EDITED_REAL);
		secondPane.setEditorText(EDITED_REAL);
		harness.setModifyFailure(new Error("First pane write failed"));

		// When: lockAll is invoked across both sessions
		await expect(sessions.lockAll("panic")).rejects.toThrow("First pane write failed");

		// Then: both sessions were masked and the second session still persisted its payload
		expect(session1.state).toBe("locked");
		expect(session2.state).toBe("locked");
		expect(harness.getEditorText()).toBe(DECOY);
		expect(secondPane.getEditorText()).toBe(DECOY);
		expect(harness.modifyCalls).toHaveLength(1);
	});

	it("blocks unlock and reports a live session while a path is reserved, then releases idempotently", async () => {
		// Given: a locked session whose path is not reserved
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		expect(sessions.isPathReserved(harness.file.path)).toBe(false);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(false);

		// When: a caller reserves the path for a direct write
		const release = sessions.reservePath(harness.file.path);

		// Then: the path counts as live and unlock is refused without touching the session
		expect(sessions.isPathReserved(harness.file.path)).toBe(true);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(true);
		expect(await sessions.unlock(session, PASSWORD)).toBe("blocked");
		expect(session.state).toBe("locked");
		expect(session.dek).toBeNull();

		// When: the release is called twice (idempotent)
		release();
		release();

		// Then: the reservation is gone, the session is no longer live, and unlock succeeds
		expect(sessions.isPathReserved(harness.file.path)).toBe(false);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(false);
		expect(await sessions.unlock(session, PASSWORD)).toBe("ok");
		expect(session.state).toBe("unlocked");
	});

	it("no-ops lock() while the path is reserved so the direct writer keeps exclusive access", async () => {
		// Given: an unlocked session with unsaved edits and a reserved path
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		await sessions.unlock(session, PASSWORD);
		harness.setEditorText(EDITED_REAL);
		const release = sessions.reservePath(harness.file.path);

		try {
			// When: lock() is triggered while the path is reserved
			await sessions.lock(session, "reserved");

			// Then: no write is attempted and the session keeps its unlocked state and edits
			expect(harness.modifyCalls).toHaveLength(0);
			expect(session.state).toBe("unlocked");
			expect(session.lockingPromise).toBeNull();
			expect(session.dek).not.toBeNull();
			expect(harness.getEditorText()).toBe(EDITED_REAL);
		} finally {
			release();
		}
	});

	it("lets an in-flight lock finish and persist its snapshot when the view is reassigned to another file", async () => {
		// Given: an unlocked session whose lock() is suspended inside absorbNewEditorImages
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		await sessions.unlock(session, PASSWORD);
		harness.setEditorText(EDITED_REAL);

		// When: lock() starts and the view is synchronously reassigned to another note mid-flight
		const lockPromise = sessions.lock(session, "reassign-race");
		const otherFile = {
			path: "Other Note.md",
			name: "Other Note.md",
			basename: "Other Note",
			extension: "md",
		} as unknown as TFile;
		sessions.attachFromLoad(harness.view, otherFile, parsed);
		await lockPromise;

		// Then: the orphaned lock was not killed, wrote exactly once, and persisted the latest real text
		expect(session.killGeneration).toBe(0);
		expect(session.state).toBe("locked");
		expect(harness.modifyCalls).toHaveLength(1);
		const rewritten = parseFileContent(harness.modifyCalls[0]);
		if (!rewritten) throw new Error("Expected serialized payload");
		const { realText } = await unlockPayload(rewritten.payload, PASSWORD);
		expect(realText).toBe(EDITED_REAL);
	});

	it("aborts an in-flight unlock() that loses its view mapping even without a generation bump", async () => {
		// Given: a locked session with a valid password
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);

		// When: unlock() is started and the view is detached synchronously while the KDF is in flight
		const unlockPromise = sessions.unlock(session, PASSWORD);
		sessions.detach(harness.view);
		const outcome = await unlockPromise;

		// Then: the orphaned unlock is refused without a generation bump, so no key or text leaks into the pane
		expect(outcome).toBe("blocked");
		expect(session.killGeneration).toBe(0);
		expect(session.state).toBe("locked");
		expect(session.dek).toBeNull();
		expect(harness.getEditorText()).toBe(DECOY);
	});
});
