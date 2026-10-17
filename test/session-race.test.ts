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
	getEditorText(): string;
	setEditorText(next: string): void;
	setFile(next: TFile | null): void;
	createPane(initialText?: string): FakePane;
	setImageLookupDelay(delayMs: number, onLookup?: () => void): void;
}

function createFakeHarness(initialEditorText: string): FakeHarness {
	let lockedEvents = 0;
	const modifyCalls: string[] = [];
	let imageLookupDelayMs = 0;
	let onImageLookup: (() => void) | undefined;

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
	};

	return {
		app,
		file,
		view: primaryPane.view,
		hooks,
		modifyCalls,
		lockedCount: () => lockedEvents,
		getEditorText: primaryPane.getEditorText,
		setEditorText: primaryPane.setEditorText,
		setFile: primaryPane.setFile,
		createPane,
		setImageLookupDelay: (delayMs: number, callback?: () => void) => {
			imageLookupDelayMs = delayMs;
			onImageLookup = callback;
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
});
