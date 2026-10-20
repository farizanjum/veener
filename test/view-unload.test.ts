import { afterEach, describe, expect, it } from "vitest";
import { parseFileContent } from "../src/crypto/payload";
import {
	createViewUnloadHarness,
	DEFAULT_DECOY,
	EDITED_DECOY,
	inspectSavedFile,
	SECRET_P0,
	SECRET_P1,
	SECRET_P2_TAIL,
	SECRET_REAL_TITLE,
	TEST_PASSWORD,
	type NativeSaveMode,
	type ViewUnloadHarness,
} from "./helpers/unloadHarness";

describe("View patch unload handoff and native save regressions (Issue #13)", () => {
	let activeHarness: ViewUnloadHarness | null = null;

	afterEach(() => {
		activeHarness?.restorePrototype();
		activeHarness = null;
	});

	it.each(["recompute", "backing-data"] as const satisfies readonly NativeSaveMode[])(
		"sanitizes an unlocked view synchronously on unload and preserves ciphertext on native save (%s mode)",
		async (saveMode) => {
			// Given: a protected note unlocked in an active MarkdownView
			const harness = createViewUnloadHarness({ defaultNativeSaveMode: saveMode });
			activeHarness = harness;
			const { file, pane, session } = await harness.seedProtectedNote({ saveMode });

			const outcome = await harness.sessions.unlock(session, TEST_PASSWORD);
			expect(outcome).toBe("ok");
			expect(pane.getEditorText()).toBe(SECRET_P0);
			expect(pane.getDisplayedTitles().inline).toBe(SECRET_REAL_TITLE);

			const dekSnapshotRef = session.dek;
			expect(dekSnapshotRef).not.toBeNull();
			expect(dekSnapshotRef?.some((byte) => byte !== 0)).toBe(true);

			// User types an edit so undo history has a pre-edit entry
			pane.typeInEditor(`${SECRET_P0} - edited in RAM`);
			expect(pane.undoHistory.length).toBeGreaterThan(0);

			// When: view patches unload synchronously and Obsidian's native save runs
			harness.unloadPatches();

			// Then (IS-1 / IS-4 synchronous confidentiality boundary):
			// Editor, backing data, title DOM, undo history, and DEK must be sanitized before unload returns
			expect(pane.getEditorText()).not.toContain(SECRET_P0);
			expect(pane.getBackingData()).not.toContain(SECRET_P0);
			expect(parseFileContent(pane.getEditorText())).not.toBeNull();
			expect(parseFileContent(pane.getBackingData())).not.toBeNull();
			expect(pane.getDisplayedTitles()).toEqual({
				inline: file.basename,
				header: file.basename,
				tab: file.basename,
			});
			expect(pane.undoHistory).toEqual([]);
			expect(dekSnapshotRef ? Array.from(dekSnapshotRef).every((b) => b === 0) : false).toBe(true);
			expect(harness.sessions.get(pane.view)).toBeNull();

			// And when native save runs after prototype restoration, disk retains decryptable ciphertext
			await pane.view.save();
			const savedOnDisk = harness.disk.get(file.path) ?? "";
			expect(savedOnDisk).not.toContain(SECRET_P0);
			expect(savedOnDisk).not.toContain(SECRET_REAL_TITLE);

			const inspected = await inspectSavedFile(savedOnDisk, TEST_PASSWORD);
			expect(inspected.isProtected).toBe(true);
			expect(inspected.decoyBody).toBe(DEFAULT_DECOY);
			expect(inspected.realText).toBe(SECRET_P0);
			expect(inspected.realTitle).toBe(SECRET_REAL_TITLE);
		},
	);

	it.each(["recompute", "backing-data"] as const satisfies readonly NativeSaveMode[])(
		"hydrates a locked view with the full serialized document on unload so native save does not strip ciphertext (%s mode)",
		async (saveMode) => {
			// Given: a locked protected note whose cover was edited while locked
			const harness = createViewUnloadHarness({ defaultNativeSaveMode: saveMode });
			activeHarness = harness;
			const { file, pane, session } = await harness.seedProtectedNote({ saveMode });
			expect(session.state).toBe("locked");

			// Cover maintenance while locked
			pane.typeInEditor(EDITED_DECOY);

			// When: view patches unload and native save runs
			harness.unloadPatches();

			// Then (IS-2): native view holds the complete serialized file (edited cover + draft_cache)
			expect(parseFileContent(pane.getEditorText())).not.toBeNull();
			expect(parseFileContent(pane.getBackingData())).not.toBeNull();

			await pane.view.save();
			const savedOnDisk = harness.disk.get(file.path) ?? "";
			const inspected = await inspectSavedFile(savedOnDisk, TEST_PASSWORD);
			expect(inspected.isProtected).toBe(true);
			expect(inspected.decoyBody).toBe(EDITED_DECOY);
			expect(inspected.realText).toBe(SECRET_P0);
			expect(inspected.realTitle).toBe(SECRET_REAL_TITLE);
		},
	);

	it.each(["recompute", "backing-data"] as const satisfies readonly NativeSaveMode[])(
		"hands off the newest completed pendingPayload (P1) while excluding an unencrypted dirty tail (P2) (%s mode)",
		async (saveMode) => {
			// Given: an unlocked note with original payload P0, a completed re-encryption P1, and a newer unencrypted edit P2
			const harness = createViewUnloadHarness({ defaultNativeSaveMode: saveMode });
			activeHarness = harness;
			const { file, pane, session } = await harness.seedProtectedNote({
				realText: SECRET_P0,
				saveMode,
			});

			expect(await harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");
			await harness.stageCompletedPendingPayload(session, SECRET_P1);

			// User continues typing an unencrypted tail P2 that has not completed debounce re-encryption
			pane.typeInEditor(SECRET_P2_TAIL);

			// When: unload runs synchronously followed by native save
			harness.unloadPatches();
			await pane.view.save();

			// Then (IS-1 / IS-2 / IS-6): no plaintext sentinel appears on disk, and the file decrypts to P1 (not P0, not P2)
			const savedOnDisk = harness.disk.get(file.path) ?? "";
			expect(savedOnDisk).not.toContain(SECRET_P0);
			expect(savedOnDisk).not.toContain(SECRET_P1);
			expect(savedOnDisk).not.toContain(SECRET_P2_TAIL);

			const inspected = await inspectSavedFile(savedOnDisk, TEST_PASSWORD);
			expect(inspected.isProtected).toBe(true);
			expect(inspected.decoyBody).toBe(DEFAULT_DECOY);
			expect(inspected.realText).toBe(SECRET_P1);
			expect(inspected.realTitle).toBe(SECRET_REAL_TITLE);
		},
	);
});
