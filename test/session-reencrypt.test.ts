import { describe, expect, it, vi } from "vitest";
import type { App, MarkdownView, TFile } from "obsidian";
import { createFile, parseFileContent, unlockPayload } from "../src/crypto/payload";
import { REENCRYPT_DEBOUNCE_MS, SessionManager } from "../src/view/session";

const DECOY = "## Weekend Grocery List\n\n- milk, eggs, bread";
const INITIAL_REAL = "Top secret project roadmap v1";
const PASSWORD = "correct horse battery staple";

function createMockEnv(initialEditorText = INITIAL_REAL) {
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
			readBinary: async () => rawImageBytes.buffer.slice(0),
			delete: async (file: { path: string }) => {
				deletedImages.push(file.path);
			},
			modify: async (file: { path: string }, content: string) => {
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

		// Simulate rapid typing across multiple editor-change events
		env.setEditorText("Top secret project roadmap v2 - draft");
		env.manager.scheduleReencrypt(session);
		const firstTimer = session.reencryptTimer;
		expect(firstTimer).not.toBeNull();

		env.setEditorText("Top secret project roadmap v2 - final");
		env.manager.scheduleReencrypt(session);
		expect(session.reencryptTimer).not.toBeNull();
		expect(session.reencryptTimer).not.toBe(firstTimer);

		// Wait for the debounce window + async re-encryption to complete
		await new Promise((resolve) => setTimeout(resolve, REENCRYPT_DEBOUNCE_MS + 250));

		expect(session.reencryptTimer).toBeNull();
		expect(session.pendingPayload).not.toBeNull();
		expect(session.pendingPayload).not.toBe(session.originalPayload);
		expect(env.getRequestSaveCount()).toBe(1);
		// Fast-exit check: text has no "!", so metadataCache should never be queried
		expect(env.getMetadataLookups()).toBe(0);

		const unlockedPending = await unlockPayload(session.pendingPayload!, PASSWORD);
		expect(unlockedPending.realText).toBe("Top secret project roadmap v2 - final");
		unlockedPending.dek.fill(0);

		await env.manager.lock(session, "test-cleanup");
	});

	it("absorbs newly pasted vault images during scheduleReencrypt and populates blob: URLs live", async () => {
		const env = createMockEnv();
		const { fileContent } = await createFile(INITIAL_REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;

		const session = env.manager.attachFromLoad(env.mockView, env.fakeFile, parsed);
		await env.manager.unlock(session, PASSWORD);

		// User pastes a screenshot into the unlocked editor
		env.setEditorText(`${INITIAL_REAL}\n![[Pasted chart.png]]`);
		env.manager.scheduleReencrypt(session);

		await new Promise((resolve) => setTimeout(resolve, REENCRYPT_DEBOUNCE_MS + 250));

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

		// Wait past the original debounce window to verify the cancelled timer does not fire
		await new Promise((resolve) => setTimeout(resolve, REENCRYPT_DEBOUNCE_MS + 150));
		expect(session.pendingPayload).toBeNull();
		expect(env.getRequestSaveCount()).toBe(0);
	});
});
