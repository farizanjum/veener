import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class HostClass {}
	return {
		Plugin: HostClass,
		Modal: HostClass,
		MarkdownView: HostClass,
		PluginSettingTab: HostClass,
		Setting: HostClass,
		TFile: HostClass,
		Notice: HostClass,
		addIcon: () => undefined,
	};
});

import { parseFileContent } from "../src/crypto/payload";
import VeneerPlugin from "../src/main";
import {
	createPluginUnloadHarness,
	DEFAULT_DECOY,
	EDITED_DECOY,
	inspectSavedFile,
	SECRET_P0,
	SECRET_P1,
	SECRET_P2_TAIL,
	SECRET_REAL_TITLE,
	TEST_PASSWORD,
	type NativeSaveMode,
	type PluginUnloadHarness,
	type UnloadCallbackOrder,
} from "./helpers/unloadHarness";

describe("VeneerPlugin.onunload and registered cleanup lifecycle regressions (Issue #13)", () => {
	let activeHarness: PluginUnloadHarness | null = null;

	afterEach(() => {
		activeHarness?.restorePrototype();
		activeHarness = null;
		vi.restoreAllMocks();
	});

	it.each([
		["onunload-first", "recompute"],
		["cleanup-first", "recompute"],
		["onunload-first", "backing-data"],
		["cleanup-first", "backing-data"],
	] as const satisfies readonly [UnloadCallbackOrder, NativeSaveMode][])(
		"retires unlocked sessions synchronously when unloaded (%s, %s) so native save preserves P1 and leaks no plaintext",
		async (order, saveMode) => {
			// Given: a running VeneerPlugin with an unlocked note holding completed P1 and dirty tail P2
			const harness = createPluginUnloadHarness(VeneerPlugin, {
				defaultNativeSaveMode: saveMode,
			});
			activeHarness = harness;
			const { file, pane, session } = await harness.seedProtectedNote({
				realText: SECRET_P0,
				saveMode,
			});

			expect(await harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");
			const dekSnapshotRef = session.dek;
			expect(dekSnapshotRef).not.toBeNull();

			await harness.stageCompletedPendingPayload(session, SECRET_P1);
			pane.typeInEditor(SECRET_P2_TAIL);
			expect(pane.undoHistory.length).toBeGreaterThan(0);

			// When: Obsidian unloads the plugin in the specified callback order
			harness.unloadPlugin(order);

			// Then: synchronous confidentiality and hydration invariants hold immediately
			expect(pane.getEditorText()).not.toContain(SECRET_P0);
			expect(pane.getEditorText()).not.toContain(SECRET_P1);
			expect(pane.getEditorText()).not.toContain(SECRET_P2_TAIL);
			expect(pane.getBackingData()).not.toContain(SECRET_P0);
			expect(pane.getBackingData()).not.toContain(SECRET_P1);
			expect(pane.getBackingData()).not.toContain(SECRET_P2_TAIL);
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

			// And native save writes the complete encrypted document (P1) to disk
			await pane.view.save();
			const savedOnDisk = harness.disk.get(file.path) ?? "";
			expect(savedOnDisk).not.toContain(SECRET_P0);
			expect(savedOnDisk).not.toContain(SECRET_P1);
			expect(savedOnDisk).not.toContain(SECRET_P2_TAIL);
			expect(savedOnDisk).not.toContain(SECRET_REAL_TITLE);

			const inspected = await inspectSavedFile(savedOnDisk, TEST_PASSWORD);
			expect(inspected.isProtected).toBe(true);
			expect(inspected.decoyBody).toBe(DEFAULT_DECOY);
			expect(inspected.realText).toBe(SECRET_P1);
			expect(inspected.realTitle).toBe(SECRET_REAL_TITLE);
		},
	);

	it.each([
		["onunload-first", "recompute"],
		["cleanup-first", "recompute"],
		["onunload-first", "backing-data"],
		["cleanup-first", "backing-data"],
	] as const satisfies readonly [UnloadCallbackOrder, NativeSaveMode][])(
		"preserves locked cover edits and draft_cache across plugin unload (%s, %s)",
		async (order, saveMode) => {
			// Given: a locked protected note with an edited cover in the editor
			const harness = createPluginUnloadHarness(VeneerPlugin, {
				defaultNativeSaveMode: saveMode,
			});
			activeHarness = harness;
			const { file, pane, session } = await harness.seedProtectedNote({
				realText: SECRET_P0,
				saveMode,
			});
			expect(session.state).toBe("locked");
			pane.typeInEditor(EDITED_DECOY);

			// When: plugin unloads and native save runs
			harness.unloadPlugin(order);
			await pane.view.save();

			// Then: the saved file retains the encrypted payload and the edited cover
			const savedOnDisk = harness.disk.get(file.path) ?? "";
			const inspected = await inspectSavedFile(savedOnDisk, TEST_PASSWORD);
			expect(inspected.isProtected).toBe(true);
			expect(inspected.decoyBody).toBe(EDITED_DECOY);
			expect(inspected.realText).toBe(SECRET_P0);
			expect(inspected.realTitle).toBe(SECRET_REAL_TITLE);
		},
	);
});
