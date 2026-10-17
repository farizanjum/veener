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
const PASSWORD = "correct horse battery staple";

interface FakeHarness {
	readonly app: App;
	readonly file: TFile;
	readonly view: MarkdownView;
	readonly hooks: SessionHooks;
	readonly modifyCalls: string[];
	readonly lockedCount: () => number;
	getEditorText(): string;
	setEditorText(next: string): void;
}

function createFakeHarness(initialEditorText: string): FakeHarness {
	let editorText = initialEditorText;
	let lockedEvents = 0;
	const modifyCalls: string[] = [];

	const file = {
		path: "Weekend Errands.md",
		name: "Weekend Errands.md",
		basename: "Weekend Errands",
		extension: "md",
	} as unknown as TFile;

	const view = {
		file,
		editor: {
			getValue: () => editorText,
		},
		setViewData: (data: string) => {
			editorText = data;
		},
	} as unknown as MarkdownView;

	const app = {
		metadataCache: {
			getFirstLinkpathDest: () => null,
		},
		vault: {
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
		view,
		hooks,
		modifyCalls,
		lockedCount: () => lockedEvents,
		getEditorText: () => editorText,
		setEditorText: (next: string) => {
			editorText = next;
		},
	};
}

describe("SessionManager race conditions (Issue #2)", () => {
	it("coalesces concurrent lock() calls and snapshots plaintext before async awaits", async () => {
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

		// When: two mask triggers fire concurrently and editor text is mutated mid-flight
		const firstLock = sessions.lock(session, "leaf-change");
		expect(session.lockingPromise).not.toBeNull();
		harness.setEditorText(DECOY);
		const secondLock = sessions.lock(session, "window-blur");
		await Promise.all([firstLock, secondLock]);

		// Then: vault.modify ran exactly once and persisted the edited real text, never the decoy
		expect(session.lockingPromise).toBeNull();
		expect(session.state).toBe("locked");
		expect(harness.modifyCalls).toHaveLength(1);
		const savedOnDisk = parseFileContent(harness.modifyCalls[0] ?? "");
		expect(savedOnDisk).not.toBeNull();
		if (!savedOnDisk) throw new Error("Expected saved payload on disk");
		const unlockedAgain = await unlockPayload(savedOnDisk.payload, PASSWORD);
		expect(unlockedAgain.realText).toBe(EDITED_REAL);
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

	it("preserves rotated password payload on an open session across subsequent saves", async () => {
		// Given: an open session that flushed unlocked edits before password rotation
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
		await sessions.lock(session, "change-password");

		// When: password is rotated and synced onto the open session
		const newPassword = "brand new passphrase 2026";
		const rotated = await changePassword(session.originalPayload, PASSWORD, newPassword);
		session.originalPayload = rotated;
		if (session.pendingPayload !== null) {
			session.pendingPayload = rotated;
		}
		const savedAfterRotation = computeSavedContent({
			unlocked: session.state === "unlocked",
			editorValue: harness.getEditorText(),
			decoyBody: session.decoyBody,
			originalPayload: session.originalPayload,
			pendingPayload: session.pendingPayload,
		});

		// Then: the saved content unlocks with the new password and preserves the flushed edits
		const reparsed = parseFileContent(savedAfterRotation);
		expect(reparsed).not.toBeNull();
		if (!reparsed) throw new Error("Expected reparsed file");
		await expect(unlockPayload(reparsed.payload, PASSWORD)).rejects.toThrow();
		const unlockedWithNew = await unlockPayload(reparsed.payload, newPassword);
		expect(unlockedWithNew.realText).toBe(EDITED_REAL);
		unlockedWithNew.dek.fill(0);
	});
});
