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
import { executeShred } from "../src/shred/duress";

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
		expect(sessions.discardAndDetach(session)).toBe(true);

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
			expect(sessions.discardAndDetach(openSession)).toBe(true);
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
			sessions.discardAndDetach(session);
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
		sessions.discardAndDetach(session);
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

	it("cancels and awaits an orphaned pending lock during executeShred so destroyed notes never return", async () => {
		// Given: an unlocked session on Note A whose lock() is paused in absorbNewEditorImages
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsedA = parseFileContent(fileContent);
		if (!parsedA) throw new Error("Expected parsed payload A");

		const otherDecoy = "## Travel packing\n\n- passport, charger";
		const { fileContent: otherContent } = await createFile("Other secret", PASSWORD, otherDecoy);
		const parsedB = parseFileContent(otherContent);
		if (!parsedB) throw new Error("Expected parsed payload B");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const sessionA = sessions.attachFromLoad(harness.view, harness.file, parsedA);
		await sessions.unlock(sessionA, PASSWORD);
		harness.setEditorText(`${EDITED_REAL}\n![[Pasted image.png]]`);

		const noteB = {
			path: "Travel Packing.md",
			name: "Travel Packing.md",
			basename: "Travel Packing",
			extension: "md",
		} as unknown as TFile;

		const shredState: {
			promise?: Promise<unknown>;
			liveWhileOrphaned: boolean;
			order: string[];
		} = {
			liveWhileOrphaned: false,
			order: [],
		};
		harness.setImageLookupDelay(25, () => {
			harness.setFile(noteB);
			harness.setEditorText(otherDecoy);
			sessions.attachFromLoad(harness.view, noteB, parsedB);
			shredState.liveWhileOrphaned = sessions.hasLiveSession(harness.file.path);

			shredState.promise = executeShred([{ path: harness.file.path, mode: "portable" }], {
				zeroSessions: () => sessions.hardKillAll(),
				rewritePortable: async () => {
					shredState.order.push("rewrite-start");
					await harness.app.vault.modify(harness.file, `${DECOY}\n`);
				},
				deleteStealth: async () => undefined,
				clearRegistry: async () => undefined,
			});
		});

		// When: Note A's lock and the concurrent shred both complete
		await sessions.lock(sessionA, "file-switch").finally(() => {
			shredState.order.push("lock-settled");
		});
		expect(shredState.promise).toBeDefined();
		await shredState.promise;

		// Then: Note A remained live while orphaned, its lock settled before rewritePortable started, Note B's view was untouched, and disk holds only plain decoy
		expect(shredState.liveWhileOrphaned).toBe(true);
		expect(shredState.order).toEqual(["lock-settled", "rewrite-start"]);
		expect(sessionA.killGeneration).toBeGreaterThan(0);
		expect(sessionA.dek).toBeNull();
		expect(harness.getEditorText()).toBe(otherDecoy);
		expect(harness.modifyCalls).toEqual([`${DECOY}\n`]);
		expect(parseFileContent(harness.modifyCalls[0] ?? "")).toBeNull();
	});

	it("reference-counts reservePath and blocks an already-running unlock() when reserved before unlockPayload resolves", async () => {
		// Given: a locked session
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

		// When: unlock() starts before any reservation, then two overlapping reservations are taken and only the first is released while KDF runs
		const unlockPromise = sessions.unlock(session, PASSWORD);
		const release1 = sessions.reservePath(harness.file.path);
		const release2 = sessions.reservePath(harness.file.path);
		release1();
		release1();
		expect(sessions.isPathReserved(harness.file.path)).toBe(true);

		const outcome = await unlockPromise;

		// Then: unlock() re-checks reservation after unlockPayload, zeroes the DEK, and returns "blocked"
		expect(outcome).toBe("blocked");
		expect(session.state).toBe("locked");
		expect(session.dek).toBeNull();
		expect(harness.getEditorText()).toBe(DECOY);

		// And when: the second reservation is released, the path is unreserved and unlock succeeds
		release2();
		expect(sessions.isPathReserved(harness.file.path)).toBe(false);
		expect(await sessions.unlock(session, PASSWORD)).toBe("ok");
		expect(session.state).toBe("unlocked");
	});

	it("discardAndDetach detaches only if the captured session still owns its pane", async () => {
		// Given: sessionA in a pane that is then reassigned to another protected note (sessionB) during an async unprotect write
		const { fileContent: contentA } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsedA = parseFileContent(contentA);
		if (!parsedA) throw new Error("Expected parsed payload A");

		const otherDecoy = "## Reading list\n\n- Designing Data-Intensive Applications";
		const otherReal = "Confidential M&A term sheet";
		const { fileContent: contentB } = await createFile(otherReal, PASSWORD, otherDecoy);
		const parsedB = parseFileContent(contentB);
		if (!parsedB) throw new Error("Expected parsed payload B");

		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const sessionA = sessions.attachFromLoad(harness.view, harness.file, parsedA);

		const fileB = {
			path: "Reading List.md",
			name: "Reading List.md",
			basename: "Reading List",
			extension: "md",
		} as unknown as TFile;
		harness.setFile(fileB);
		harness.setEditorText(otherDecoy);
		const sessionB = sessions.attachFromLoad(harness.view, fileB, parsedB);

		// When: unprotect finishes writing fileA and calls discardAndDetach(sessionA)
		const detachedOwnPane = sessions.discardAndDetach(sessionA);

		// Then: discardAndDetach returns false, the pane still holds sessionB, and the editor still shows otherFile's decoy (not realText)
		expect(detachedOwnPane).toBe(false);
		expect(sessions.get(harness.view)).toBe(sessionB);
		expect(harness.getEditorText()).toBe(otherDecoy);
	});

	it("preserves the rotated payload when a cover save occurs during the password rotation write window", async () => {
		// Given: a locked session undergoing password rotation where the path is reserved and originalPayload is updated before vault.modify finishes
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
		const newPassword = "rotated passphrase 2026";
		const rotated = await changePassword(session.originalPayload, PASSWORD, newPassword);

		// When: password rotation reserves the path and updates session.originalPayload before vault.modify completes, and a cover edit/save occurs in the window
		const release = sessions.reservePath(harness.file.path);
		session.originalPayload = rotated;
		const editedCover = `${DECOY}\n- coffee beans`;
		harness.setEditorText(editedCover);
		const savedDuringRotation = computeSavedContent({
			unlocked: session.state === "unlocked",
			editorValue: harness.getEditorText(),
			decoyBody: session.decoyBody,
			originalPayload: session.originalPayload,
			pendingPayload: session.pendingPayload,
		});
		release();

		// Then: the saved content carries the rotated payload (cannot be unlocked with the old password, unlocks with the new password)
		const savedParsed = parseFileContent(savedDuringRotation);
		expect(savedParsed).not.toBeNull();
		if (!savedParsed) throw new Error("Expected saved parsed payload");
		expect(savedParsed.decoyBody).toBe(editedCover);
		await expect(unlockPayload(savedParsed.payload, PASSWORD)).rejects.toThrow();
		const unlocked = await unlockPayload(savedParsed.payload, newPassword);
		expect(unlocked.realText).toBe(INITIAL_REAL);
		unlocked.dek.fill(0);
	});

	it("aborts an in-flight lock() disk write if the path becomes reserved before vault.modify", async () => {
		// Given: an unlocked session with an embedded image whose lock() pauses inside absorbNewEditorImages
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

		const reservationHolder: { release?: () => void } = {};
		harness.setImageLookupDelay(20, () => {
			reservationHolder.release = sessions.reservePath(harness.file.path);
		});

		try {
			// When: lock() resumes after the path has been reserved by a direct writer
			await sessions.lock(session, "late-reserve");

			// Then: lock() skips vault.modify and still cleans up its RAM state in finally
			expect(harness.modifyCalls).toHaveLength(0);
			expect(session.state).toBe("locked");
			expect(session.dek).toBeNull();
			expect(session.lockingPromise).toBeNull();
		} finally {
			reservationHolder.release?.();
		}
		expect(sessions.hasLiveSession(harness.file.path)).toBe(false);
	});

	it("replays deferred saves only after the last reservation release and isolates a throwing save", () => {
		// Given: a path reserved twice with three deferred saves queued behind it
		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(
			harness.app,
			harness.hooks,
			() => ";;",
			() => null,
		);
		const release1 = sessions.reservePath(harness.file.path);
		const release2 = sessions.reservePath(harness.file.path);

		const order: string[] = [];
		let reservedAtFlush: boolean | null = null;
		sessions.deferSave(harness.file.path, () => {
			reservedAtFlush = sessions.isPathReserved(harness.file.path);
			order.push("first");
		});
		sessions.deferSave(harness.file.path, () => {
			order.push("throwing");
			throw new Error("deferred save exploded");
		});
		sessions.deferSave(harness.file.path, () => order.push("second"));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			// When: one reservation releases (ref-count still > 0) and then the last one releases
			release1();
			release1();
			expect(order).toEqual([]);
			expect(sessions.isPathReserved(harness.file.path)).toBe(true);

			release2();

			// Then: every deferred save ran once in order, the throwing one was isolated, and the
			// flush observed the path as no longer reserved
			expect(order).toEqual(["first", "throwing", "second"]);
			expect(reservedAtFlush).toBe(false);
			expect(warnSpy).toHaveBeenCalledWith(
				"Veneer: deferred save after reservation failed",
				expect.any(Error),
			);
			expect(sessions.isPathReserved(harness.file.path)).toBe(false);
			expect(sessions.hasLiveSession(harness.file.path)).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("replays a save queued during unprotect only after the session has been detached", async () => {
		// Given: a locked, still-attached session on a path reserved for a direct plaintext
		// write (the reservation unprotectViaModal holds), with a cover save already queued
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
		expect(session.state).toBe("locked");

		// getViewData() masks again whenever sessions.get(view) still resolves, so the replay
		// records exactly that read
		const attachedWhenReplayed: boolean[] = [];
		const releasePath = sessions.reservePath(harness.file.path);
		sessions.deferSave(harness.file.path, () => {
			attachedWhenReplayed.push(sessions.get(harness.view) !== null);
		});

		// When: unprotectViaModal's order runs -- discard and detach under the reservation, then release
		const detached = sessions.discardAndDetach(session);
		releasePath();

		// Then: the queued save replayed only after detach, so its getViewData() read fell through
		// to the plaintext editor value instead of re-serializing the decoy and ciphertext
		expect(detached).toBe(true);
		expect(attachedWhenReplayed).toEqual([false]);
		expect(sessions.get(harness.view)).toBeNull();
		expect(sessions.hasLiveSession(harness.file.path)).toBe(false);
	});

	it("re-masks the note when a queued unprotect save is replayed before the detach", async () => {
		// Given: the same locked, attached session with a cover save queued under a reservation
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

		const attachedWhenReplayed: boolean[] = [];
		const releasePath = sessions.reservePath(harness.file.path);
		sessions.deferSave(harness.file.path, () => {
			attachedWhenReplayed.push(sessions.get(harness.view) !== null);
		});

		// When: the reservation is released while the session is still attached, the order
		// unprotectViaModal used before the fix
		releasePath();

		// Then: the replay saw the still-attached masked session and would have overwritten the
		// plaintext with decoy + ciphertext, the regression releasing after detach prevents
		expect(attachedWhenReplayed).toEqual([true]);
		expect(sessions.discardAndDetach(session)).toBe(true);
	});

	it("ignores foreign editor text typed after a mid-lock detach instead of persisting it", async () => {
		// Given: an unlocked session on a note with an embedded image, and a detach during absorption
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
		const foreignText = "## Different cover\n\n- unrelated";

		// When: the pane is detached and its text replaced with a foreign note while lock() awaits the image read
		harness.setImageLookupDelay(20, () => {
			sessions.detach(harness.view);
			harness.setEditorText(foreignText);
		});
		await sessions.lock(session, "detach-race");

		// Then: lock() re-read no text from the detached pane, so the payload keeps the real snapshot
		expect(harness.modifyCalls).toHaveLength(1);
		expect(session.state).toBe("locked");
		expect(session.dek).toBeNull();
		expect(session.lockingPromise).toBeNull();
		const savedOnDisk = parseFileContent(harness.modifyCalls[0] ?? "");
		if (!savedOnDisk) throw new Error("Expected saved payload on disk");
		const unlockedAgain = await unlockPayload(savedOnDisk.payload, PASSWORD);
		expect(unlockedAgain.realText).toBe(textWithImage);
		expect(unlockedAgain.realText).not.toContain("Different cover");
		unlockedAgain.dek.fill(0);
	});

	it("lets a concurrent unlock loser discard only its own key without re-running the unlock hooks", async () => {
		// Given: a locked session unlocked twice before either derivation resolves
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("Expected parsed payload");

		const harness = createFakeHarness(DECOY);
		let unlockedCalls = 0;
		const sessions = new SessionManager(
			harness.app,
			{ ...harness.hooks, onUnlocked: () => (unlockedCalls += 1) },
			() => ";;",
			() => null,
		);
		const registerDekSpy = vi.spyOn(
			sessions as unknown as {
				registerOwnedDek: (dek: Uint8Array<ArrayBuffer>) => () => void;
			},
			"registerOwnedDek",
		);
		const session = sessions.attachFromLoad(harness.view, harness.file, parsed);
		expect(session.unlocking).toBe(false);

		// When: both unlock() calls are in flight at their unlockPayload await
		const first = sessions.unlock(session, PASSWORD);
		expect(session.unlocking).toBe(true);
		const second = sessions.unlock(session, PASSWORD);
		expect(session.unlocking).toBe(true);
		const outcomes = await Promise.all([first, second]);

		// Then: both report success, only one derivation ran, unlocking is reset, and only one unlock was announced
		expect(outcomes).toEqual(["ok", "ok"]);
		expect(session.unlocking).toBe(false);
		expect(registerDekSpy).toHaveBeenCalledTimes(1);
		expect(session.state).toBe("unlocked");
		expect(session.killGeneration).toBe(0);
		expect(session.dek).not.toBeNull();
		expect(unlockedCalls).toBe(1);
		expect(harness.getEditorText()).toBe(INITIAL_REAL);
	});

	it("resets session.unlocking to false after a failed unlock attempt", async () => {
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
		expect(session.unlocking).toBe(false);

		const attempt = sessions.unlock(session, "wrong password");
		expect(session.unlocking).toBe(true);
		const outcome = await attempt;

		expect(outcome).toBe("wrong");
		expect(session.unlocking).toBe(false);
		expect(session.state).toBe("locked");
	});

	it("cancels any partial capture buffer progress when unlock() begins", async () => {
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
		session.capture.feed(";;partial", true);
		expect(session.capture.isActive).toBe(true);

		const unlockPromise = sessions.unlock(session, PASSWORD);
		expect(session.capture.isActive).toBe(false);
		expect(session.capture.capturedLength).toBe(0);
		expect(await unlockPromise).toBe("ok");
	});

	it("hardKillAll detaches the killed session from its pane and path", async () => {
		// Given: an unlocked session attached to a pane and a path
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
		expect(sessions.get(harness.view)).toBe(session);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(true);

		// When: the shred hard-kills every session
		await sessions.hardKillAll();

		// Then: the pane and path no longer reference the dead session
		expect(sessions.get(harness.view)).toBeNull();
		expect(sessions.getByPath(harness.file.path)).toBeNull();
		expect(sessions.getAllByPath(harness.file.path)).toEqual([]);
		expect(sessions.hasLiveSession(harness.file.path)).toBe(false);
		expect(session.state).toBe("locked");
		expect(session.dek).toBeNull();
	});

	it("hardKillAll discards deferred saves queued behind a reservation", async () => {
		// Given: an unlocked session whose path is reserved, with a save deferred behind it
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

		const release = sessions.reservePath(harness.file.path);
		const replay = vi.fn();
		sessions.deferSave(harness.file.path, replay);

		// When: the shred hard-kills the session and the reservation later releases
		await sessions.hardKillAll();
		release();

		// Then: the deferred save is discarded, never replayed, and no disk write happened
		expect(replay).not.toHaveBeenCalled();
		expect(harness.modifyCalls).toEqual([]);
	});

	it("hardKillAll awaits an in-flight save write that no lock() owns", async () => {
		// Given: an unlocked session with a ciphertext write in flight via enqueueWrite
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

		const vault = harness.app.vault as unknown as {
			modify: (target: TFile, data: string) => Promise<void>;
		};
		const originalModify = vault.modify;
		let releaseWrite: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let markEntered: () => void = () => undefined;
		const writeEntered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		vault.modify = async (target: TFile, data: string) => {
			markEntered();
			await gate;
			await originalModify(target, data);
		};

		try {
			// When: a save write is in flight and the shred hard-kills the session
			const savePromise = sessions.enqueueWrite(session, () =>
				vault.modify(harness.file, "ciphertext"),
			);
			await writeEntered;
			expect(session.lockingPromise).toBeNull();

			let killSettled = false;
			const killPromise = sessions.hardKillAll().then(() => {
				killSettled = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Then: hardKillAll has not resolved while the write is still in flight
			expect(killSettled).toBe(false);

			releaseWrite();
			await killPromise;
			expect(killSettled).toBe(true);
			expect(harness.modifyCalls).toEqual(["ciphertext"]);
			await savePromise;
		} finally {
			vault.modify = originalModify;
		}
	});

	it("runReservedWrite declines writes once the kill epoch is stale and distinguishes accepted writes via boolean result", async () => {
		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(harness.app, harness.hooks, () => ";;", () => null);

		let ran = false;
		const stale = await sessions.runReservedWrite(-1, () => {
			ran = true;
			return Promise.resolve();
		});
		expect(stale).toBe(false);
		expect(ran).toBe(false);

		const startEpoch = sessions.currentKillEpoch();
		let ranLive = false;
		const accepted = await sessions.runReservedWrite(startEpoch, () => {
			ranLive = true;
			return Promise.resolve();
		});
		expect(accepted).toBe(true);
		expect(ranLive).toBe(true);

		let ranAfterKill = false;
		void sessions.hardKillAll();
		const declined = await sessions.runReservedWrite(startEpoch, () => {
			ranAfterKill = true;
			return Promise.resolve();
		});
		expect(declined).toBe(false);
		expect(ranAfterKill).toBe(false);
	});

	it("hardKillAll waits for in-flight reserved writes before resolving", async () => {
		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(harness.app, harness.hooks, () => ";;", () => null);
		const startEpoch = sessions.currentKillEpoch();

		let writeSettled = false;
		let releaseWrite = () => {};
		const write = sessions.runReservedWrite(startEpoch, () =>
			new Promise<void>((resolve) => {
				releaseWrite = () => {
					writeSettled = true;
					resolve();
				};
			}),
		);

		let killSettled = false;
		const killPromise = sessions.hardKillAll();
		void killPromise.then(() => {
			killSettled = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(writeSettled).toBe(false);
		expect(killSettled).toBe(false);

		releaseWrite();
		await write;
		await killPromise;
		expect(writeSettled).toBe(true);
		expect(killSettled).toBe(true);
	});

	it("remembers decoy fallbacks per path and moves them on rename", async () => {
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		if (parsed === null) throw new Error("Expected parseable payload");
		const harness = createFakeHarness(DECOY);
		const sessions = new SessionManager(harness.app, harness.hooks, () => ";;", () => null);
		sessions.attachFromLoad(harness.view, harness.file, parsed);

		expect(sessions.getDecoyFallback(harness.file.path)).toBe(parsed.decoyBody);
		expect(sessions.getDecoyFallback("missing.md")).toBeNull();

		sessions.renamePath(harness.file.path, "renamed.md");
		expect(sessions.getDecoyFallback("renamed.md")).toBe(parsed.decoyBody);
		expect(sessions.getDecoyFallback(harness.file.path)).toBeNull();
	});

	it("runs lockAll concurrently across distinct paths while keeping same-path locks sequential", async () => {
		// Given: two panes on Note A and one pane on Note B, all unlocked
		const { fileContent: contentA } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsedA = parseFileContent(contentA);
		if (!parsedA) throw new Error("Expected parsed payload A");

		const { fileContent: contentB } = await createFile("Second note secret", PASSWORD, DECOY);
		const parsedB = parseFileContent(contentB);
		if (!parsedB) throw new Error("Expected parsed payload B");

		const harness = createFakeHarness(DECOY);
		const paneA2 = harness.createPane(DECOY);
		const paneB = harness.createPane(DECOY);
		const fileB = {
			path: "Note B.md",
			name: "Note B.md",
			basename: "Note B",
			extension: "md",
		} as unknown as TFile;
		paneB.setFile(fileB);

		const sessions = new SessionManager(harness.app, harness.hooks, () => ";;", () => null);
		const sessionA1 = sessions.attachFromLoad(harness.view, harness.file, parsedA);
		const sessionA2 = sessions.attachFromLoad(paneA2.view, harness.file, parsedA);
		const sessionB = sessions.attachFromLoad(paneB.view, fileB, parsedB);

		await sessions.unlock(sessionA1, PASSWORD);
		await sessions.unlock(sessionA2, PASSWORD);
		await sessions.unlock(sessionB, PASSWORD);
		harness.setEditorText("Edit A1");
		paneA2.setEditorText("Edit A2");
		paneB.setEditorText("Edit B");

		const events: string[] = [];
		const originalLock = sessions.lock.bind(sessions);
		const lockSpy = vi.spyOn(sessions, "lock");
		let releaseA1!: () => void;
		const gateA1 = new Promise<void>((resolve) => {
			releaseA1 = resolve;
		});
		lockSpy.mockImplementation((session, reason) => {
			const label =
				session === sessionA1 ? "A1" : session === sessionA2 ? "A2" : "B";
			events.push(`start:${label}`);
			if (session === sessionA1) {
				return gateA1.then(() => originalLock(session, reason));
			}
			return originalLock(session, reason);
		});

		try {
			// When: lockAll starts while sessionA1 is held at gateA1
			const lockAllPromise = sessions.lockAll("panic");
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Then: Note B starts concurrently with A1, while A2 waits for A1 on the same path
			expect(events).toEqual(["start:A1", "start:B"]);

			releaseA1();
			await lockAllPromise;
			expect(events).toEqual(["start:A1", "start:B", "start:A2"]);
		} finally {
			lockSpy.mockRestore();
		}
	});
});
