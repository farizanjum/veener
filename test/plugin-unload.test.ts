import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class HostClass {
		open(): void {}
		close(): void {}
	}
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

import { MarkdownView } from "obsidian";
import { parseFileContent, serializeFile } from "../src/crypto/payload";
import { ProtectWizard } from "../src/decoy/wizard";
import VeneerPlugin from "../src/main";
import { PasswordModal } from "../src/ui/modals";
import {
	getSharedLifecycleCoordinator,
	peekSharedLifecycleCoordinator,
	VIEW_LIFECYCLE_SYMBOL,
} from "../src/view/lifecycle";
import { installViewPatches } from "../src/view/patch";
import { SessionManager } from "../src/view/session";
import {
	createDeferred,
	createPluginUnloadHarness,
	DEFAULT_DECOY,
	EDITED_DECOY,
	inspectSavedFile,
	makeMockFile,
	NEXT_TEST_PASSWORD,
	SECRET_P0,
	SECRET_P1,
	SECRET_P2_TAIL,
	SECRET_REAL_TITLE,
	TEST_PASSWORD,
	type NativeSaveMode,
	type PluginUnloadHarness,
	type UnloadCallbackOrder,
} from "./helpers/unloadHarness";

const EVIDENCE_DIR = path.resolve(process.cwd(), ".omo", "evidence", "issue-13");

/** Ensures the `.omo/evidence/issue-13` output directory exists before writing evidence files. */
function ensureEvidenceDir(): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

describe("VeneerPlugin.onunload and registered cleanup lifecycle regressions (Issue #13)", () => {
	let activeHarness: PluginUnloadHarness | null = null;

	afterEach(() => {
		activeHarness?.restorePrototype();
		activeHarness = null;
		const holder = MarkdownView.prototype as unknown as Record<symbol, unknown>;
		delete holder[VIEW_LIFECYCLE_SYMBOL];
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

	it("orders submitted write A -> plugin unload -> native save B -> successor owner2 read/write strictly, handles partial startup, locked+unlocked simultaneous notes, switched views, and outer prototype wrappers; writes task-5-lifecycle.txt", async () => {
		const gateA = createDeferred<void>();
		const enteredA = createDeferred<void>();
		const lifecycleEvents: string[] = [];

		let holdFirstOrderedModify = true;
		// Given: an active plugin instance with an already-submitted write A on OrderedNote.md, plus simultaneous locked+edited and switched notes
		const harness = createPluginUnloadHarness(VeneerPlugin, {
			defaultNativeSaveMode: "recompute",
			onModifyStart: (targetPath) => {
				if (targetPath === "OrderedNote.md" && holdFirstOrderedModify) {
					lifecycleEvents.push("A:start");
					enteredA.resolve();
				}
			},
			modifyGateForPath: (targetPath) => {
				if (targetPath === "OrderedNote.md" && holdFirstOrderedModify) {
					holdFirstOrderedModify = false;
					return gateA.promise.then(() => {
						lifecycleEvents.push("A:commit");
					});
				}
				return null;
			},
			onNativeSaveStart: ({ path: targetPath }) => {
				if (targetPath === "OrderedNote.md") {
					lifecycleEvents.push("B:start");
				}
			},
		});
		activeHarness = harness;

		const {
			file: orderedFile,
			pane: orderedPane,
			session: orderedSession,
		} = await harness.seedProtectedNote({
			path: "OrderedNote.md",
			realText: SECRET_P0,
		});

		const {
			file: lockedFile,
			pane: lockedPane,
		} = await harness.seedProtectedNote({
			path: "SimultaneousLocked.md",
			realText: SECRET_P0,
		});
		lockedPane.typeInEditor(EDITED_DECOY);

		const {
			pane: switchedPane,
			session: switchedSession,
		} = await harness.seedProtectedNote({
			path: "SwitchedProtected.md",
			realText: SECRET_P0,
		});
		expect(await harness.sessions.unlock(switchedSession, TEST_PASSWORD)).toBe("ok");
		const plainFile = makeMockFile("PlainSwitched.md");
		const plainText = "# Plain Unprotected File\n\nSafe plain text.";
		harness.disk.set(plainFile.path, plainText);
		switchedPane.switchFile(plainFile);
		switchedPane.setEditorText(plainText);
		switchedPane.setBackingData(plainText);

		expect(await harness.sessions.unlock(orderedSession, TEST_PASSWORD)).toBe("ok");
		const payloadP1 = await harness.stageCompletedPendingPayload(orderedSession, SECRET_P1);
		orderedPane.typeInEditor(SECRET_P2_TAIL);

		const serializedP0 = harness.disk.get(orderedFile.path) ?? "";
		const promiseA = harness.sessions.enqueueCoordinatedWrite(
			orderedFile,
			async () => {
				await harness.app.vault.modify(orderedFile, serializedP0);
			},
			{ session: orderedSession },
		);

		await enteredA.promise;
		expect(lifecycleEvents).toEqual(["A:start"]);

		// When: plugin unloads while write A is in flight, native save B is invoked, and successor owner2 waits on predecessorReady before reading and writing
		harness.unloadPlugin("onunload-first");
		lifecycleEvents.push("plugin1:unloaded");
		const diskImmediatelyAfterUnload = harness.disk.get(orderedFile.path) ?? "";

		const promiseB = orderedPane.view.save(true).then(() => {
			lifecycleEvents.push("B:commit");
		});

		const coordinator = getSharedLifecycleCoordinator();
		const sessions2 = new SessionManager(
			harness.app,
			{
				onUnlocked: () => undefined,
				onLocked: () => undefined,
				onUnlockBlocked: () => undefined,
			},
			() => ";;",
			() => null,
			coordinator,
		);
		const cleanups2: Array<() => void> = [];
		const controller2 = installViewPatches(sessions2, (fn) => cleanups2.push(fn));

		let successorObservedRead = "";
		const promiseSuccessor = (async () => {
			lifecycleEvents.push("successor:wait-predecessor");
			await coordinator.predecessorReady(harness.app, orderedFile);
			lifecycleEvents.push("successor:first-read");
			successorObservedRead = await harness.app.vault.cachedRead(orderedFile);
			const parsedBySuccessor = parseFileContent(successorObservedRead);
			expect(parsedBySuccessor).not.toBeNull();
			await sessions2.enqueueCoordinatedWrite(orderedFile, async () => {
				lifecycleEvents.push("successor:write-start");
				await harness.app.vault.modify(
					orderedFile,
					serializeFile(EDITED_DECOY, payloadP1),
				);
				lifecycleEvents.push("successor:write-commit");
			});
		})();

		await Promise.resolve();
		expect(lifecycleEvents).toEqual([
			"A:start",
			"plugin1:unloaded",
			"successor:wait-predecessor",
		]);

		// Release write A and let B and successor complete in strict sequence
		gateA.resolve();
		await promiseA;
		await promiseB;
		const diskAfterNativeSaveB = harness.disk.get(orderedFile.path) ?? "";
		await promiseSuccessor;
		const diskAfterSuccessorWrite = harness.disk.get(orderedFile.path) ?? "";

		await lockedPane.view.save();
		const diskLockedNote = harness.disk.get(lockedFile.path) ?? "";

		// Then: the order is strictly A -> B -> successor-read -> successor-write, and all files decrypt cleanly with zero plaintext sentinel exposure
		const idxACommit = lifecycleEvents.indexOf("A:commit");
		const idxBStart = lifecycleEvents.indexOf("B:start");
		const idxBCommit = lifecycleEvents.indexOf("B:commit");
		const idxSuccessorRead = lifecycleEvents.indexOf("successor:first-read");
		const idxSuccessorWrite = lifecycleEvents.indexOf("successor:write-commit");

		expect(idxACommit).toBeGreaterThanOrEqual(0);
		expect(idxBStart).toBeGreaterThan(idxACommit);
		expect(idxBCommit).toBeGreaterThan(idxBStart);
		expect(idxSuccessorRead).toBeGreaterThan(idxBCommit);
		expect(idxSuccessorWrite).toBeGreaterThan(idxSuccessorRead);

		const verifyOrderPredicate = (events: readonly string[]): boolean => {
			const a = events.indexOf("A:commit");
			const b = events.indexOf("B:commit");
			const r = events.indexOf("successor:first-read");
			const w = events.indexOf("successor:write-commit");
			return a >= 0 && b > a && r > b && w > r;
		};
		expect(verifyOrderPredicate(lifecycleEvents)).toBe(true);
		expect(
			verifyOrderPredicate([
				"B:commit",
				"A:commit",
				"successor:first-read",
				"successor:write-commit",
			]),
		).toBe(false);

		expect(successorObservedRead).toBe(diskAfterNativeSaveB);
		expect(diskAfterNativeSaveB).not.toContain(SECRET_P0);
		expect(diskAfterNativeSaveB).not.toContain(SECRET_P1);
		expect(diskAfterNativeSaveB).not.toContain(SECRET_P2_TAIL);

		const inspectedAfterB = await inspectSavedFile(diskAfterNativeSaveB, TEST_PASSWORD);
		expect(inspectedAfterB.isProtected).toBe(true);
		expect(inspectedAfterB.realText).toBe(SECRET_P1);

		const inspectedAfterSuccessor = await inspectSavedFile(
			diskAfterSuccessorWrite,
			TEST_PASSWORD,
		);
		expect(inspectedAfterSuccessor.isProtected).toBe(true);
		expect(inspectedAfterSuccessor.decoyBody).toBe(EDITED_DECOY);
		expect(inspectedAfterSuccessor.realText).toBe(SECRET_P1);

		const inspectedLocked = await inspectSavedFile(diskLockedNote, TEST_PASSWORD);
		expect(inspectedLocked.isProtected).toBe(true);
		expect(inspectedLocked.decoyBody).toBe(EDITED_DECOY);
		expect(inspectedLocked.realText).toBe(SECRET_P0);

		expect(switchedPane.getEditorText()).toBe(plainText);

		// Also verify outer third-party wrapper around MarkdownView.prototype.save survives reload cycles
		const proto = MarkdownView.prototype as unknown as {
			save: (this: MarkdownView, clear?: boolean) => Promise<void>;
		};
		const wrappedTarget = proto.save;
		const outerSaveCalls: string[] = [];
		const outerWrapper = async function (this: MarkdownView, clear?: boolean): Promise<void> {
			outerSaveCalls.push("outer:save");
			await wrappedTarget.call(this, clear);
		};
		proto.save = outerWrapper;

		controller2.retireAndHandoff();
		await controller2.drainPromise();
		for (const fn of cleanups2) fn();
		expect(proto.save).toBe(outerWrapper);
		await orderedPane.view.save();
		expect(outerSaveCalls).toEqual(["outer:save"]);

		// Also verify partial-startup teardown safety when lockEngine, generator, and status widgets are omitted
		const partialHarness = createPluginUnloadHarness(VeneerPlugin, {
			omitLockEngine: true,
			omitGenerator: true,
			omitStatusWidgets: true,
		});
		expect(() => partialHarness.unloadPlugin("onunload-first")).not.toThrow();
		expect(() => partialHarness.unloadPlugin("cleanup-first")).not.toThrow();
		partialHarness.restorePrototype();

		ensureEvidenceDir();
		const lifecycleDump = [
			"=== Wave 3 Task 5: Lifecycle Ordering & Native Handoff Evidence ===",
			`Ordered lifecycle trace: ${JSON.stringify(lifecycleEvents)}`,
			`Order predicate (A:commit < B:commit < successor:first-read < successor:write-commit): ${String(verifyOrderPredicate(lifecycleEvents))}`,
			`Reversed-order negative control rejected: ${String(!verifyOrderPredicate(["B:commit", "A:commit", "successor:first-read", "successor:write-commit"]))}`,
			`Successor first read equals post-B bytes: ${String(successorObservedRead === diskAfterNativeSaveB)}`,
			`Post-B file decrypts to SECRET_P1: ${String(inspectedAfterB.realText === SECRET_P1)}`,
			`Post-successor file decrypts to SECRET_P1 with EDITED_DECOY: ${String(inspectedAfterSuccessor.realText === SECRET_P1 && inspectedAfterSuccessor.decoyBody === EDITED_DECOY)}`,
			`Simultaneous locked note preserved EDITED_DECOY + SECRET_P0: ${String(inspectedLocked.decoyBody === EDITED_DECOY && inspectedLocked.realText === SECRET_P0)}`,
			`Switched view plain note preserved untouched: ${String(switchedPane.getEditorText() === plainText)}`,
			`Outer prototype wrapper preserved across controller retirement: ${String(outerSaveCalls.length === 1)}`,
			`Partial-startup teardown threw no error: true`,
			"",
			"--- Step 1: Disk Content Immediately After Unload (while A in flight) ---",
			diskImmediatelyAfterUnload,
			"",
			"--- Step 2: Disk Content After Native Save B ---",
			diskAfterNativeSaveB,
			"",
			"--- Step 3: Disk Content Observed by Successor First Read & After Successor Write ---",
			diskAfterSuccessorWrite,
		].join("\n");
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, "task-5-lifecycle.txt"),
			`${lifecycleDump}\n`,
			"utf8",
		);
	});

	it("fences command commit boundaries (protect, password, refresh, unprotect, shred), stops LockEngine during maskAll, and isolates clipboard/generator rejections; writes task-5-failures.txt", async () => {
		const failureEvidenceLines: string[] = [];

		// Scenario 1: Paused write + retirement + shred dominance + rejected write isolation
		{
			const writeGate = createDeferred<void>();
			const writeEntered = createDeferred<void>();
			const rejectGate = createDeferred<void>();
			const rejectEntered = createDeferred<void>();
			let shouldRejectSecondFile = false;

			let holdShredModify = true;
			let holdRejectModify = true;

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: (targetPath) => {
					if (targetPath === "ShredRace.md" && holdShredModify) {
						writeEntered.resolve();
					} else if (targetPath === "RejectWrite.md" && holdRejectModify) {
						rejectEntered.resolve();
					}
				},
				modifyGateForPath: (targetPath) => {
					if (targetPath === "ShredRace.md" && holdShredModify) {
						holdShredModify = false;
						return writeGate.promise;
					}
					if (targetPath === "RejectWrite.md" && holdRejectModify) {
						holdRejectModify = false;
						return rejectGate.promise;
					}
					return null;
				},
				shouldFailModify: (targetPath) =>
					targetPath === "RejectWrite.md" && shouldRejectSecondFile
						? new Error("Simulated modify rejection")
						: null,
			});
			activeHarness = harness;

			const { file: shredFile, session: shredSession } = await harness.seedProtectedNote({
				path: "ShredRace.md",
				realText: SECRET_P0,
			});
			await harness.plugin.registry.add(shredFile.path, {
				noteId: shredSession.originalPayload.note_id,
				addedAt: 1,
				mode: "portable",
			});

			const { file: rejectFile, session: rejectSession } = await harness.seedProtectedNote({
				path: "RejectWrite.md",
				realText: SECRET_P0,
			});

			const heldShredWrite = harness.sessions.enqueueCoordinatedWrite(
				shredFile,
				async () => {
					await harness.app.vault.modify(
						shredFile,
						serializeFile(DEFAULT_DECOY, shredSession.originalPayload),
					);
				},
			);
			await writeEntered.promise;

			shouldRejectSecondFile = true;
			const heldRejectWrite = harness.sessions.enqueueCoordinatedWrite(
				rejectFile,
				async () => {
					await harness.app.vault.modify(
						rejectFile,
						serializeFile(EDITED_DECOY, rejectSession.originalPayload),
					);
				},
			);
			await rejectEntered.promise;

			// Trigger duress shred while write is paused
			const shredPromise = (harness.plugin as unknown as { runShred: () => Promise<void> }).runShred();
			writeGate.resolve();
			rejectGate.resolve();

			await heldShredWrite;
			await expect(heldRejectWrite).rejects.toThrow("Simulated modify rejection");
			await shredPromise;

			const postShredDisk = harness.disk.get(shredFile.path) ?? "";
			expect(parseFileContent(postShredDisk)).toBeNull();
			expect(postShredDisk).toBe(`${DEFAULT_DECOY}\n`);
			expect(harness.plugin.registry.list()).toEqual([]);
			failureEvidenceLines.push(
				`1. Paused write + duress shred dominance: final disk is cover-only (${String(parseFileContent(postShredDisk) === null)}) and rejected write isolated`,
			);

			harness.restorePrototype();
			activeHarness = null;
		}

		// Scenario 2: Unprotect at pre-submit vs submitted-success vs submitted-failure boundaries
		{
			let pauseModifyGate: Promise<void> | null = null;
			let failNextModify = false;
			const modifyStarted = createDeferred<void>();

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: () => {
					modifyStarted.resolve();
				},
				modifyGateForPath: () => pauseModifyGate,
				shouldFailModify: () =>
					failNextModify ? new Error("Simulated unprotect disk write failure") : null,
			});
			activeHarness = harness;

			// 2a: Pre-submit unprotect cancelled by unload (paused at password modal)
			const { file: filePre, pane: panePre } = await harness.seedProtectedNote({
				path: "UnprotectPreSubmit.md",
				realText: SECRET_P0,
			});
			await harness.plugin.registry.add(filePre.path, {
				noteId: "note-pre",
				addedAt: 1,
				mode: "portable",
			});

			const unprotectPrePromise = (
				harness.plugin as unknown as { unprotectViaModal: () => Promise<void> }
			).unprotectViaModal();
			await Promise.resolve();
			await Promise.resolve();

			// Unload closes tracked PasswordModal and cancels unsubmitted unprotect
			harness.unloadPlugin("onunload-first");
			await unprotectPrePromise;

			const preDisk = harness.disk.get(filePre.path) ?? "";
			const inspectedPre = await inspectSavedFile(preDisk, TEST_PASSWORD);
			expect(inspectedPre.isProtected).toBe(true);
			expect(inspectedPre.realText).toBe(SECRET_P0);
			expect(
				harness.plugin.registry.list().some((e) => e.path === filePre.path),
			).toBe(true);
			await panePre.view.save();
			expect((await inspectSavedFile(harness.disk.get(filePre.path) ?? "", TEST_PASSWORD)).isProtected).toBe(true);
			failureEvidenceLines.push(
				`2a. Pre-submit unprotect cancelled on unload: remains protected=${String(inspectedPre.isProtected)}, registry retained=true`,
			);

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			// 2b: Already-submitted unprotect SUCCEEDS across retirement -> ends unprotected & removed from registry
			const unprotectWriteGate = createDeferred<void>();
			const unprotectWriteStarted = createDeferred<void>();

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: (targetPath) => {
					if (targetPath === "UnprotectSubmittedSuccess.md") {
						unprotectWriteStarted.resolve();
					}
				},
				modifyGateForPath: (targetPath) =>
					targetPath === "UnprotectSubmittedSuccess.md"
						? unprotectWriteGate.promise
						: null,
			});
			activeHarness = harness;

			const { file: fileSucc, pane: paneSucc } = await harness.seedProtectedNote({
				path: "UnprotectSubmittedSuccess.md",
				realText: SECRET_P0,
			});
			await harness.plugin.registry.add(fileSucc.path, {
				noteId: "note-succ",
				addedAt: 1,
				mode: "portable",
			});
			vi.spyOn(PasswordModal.prototype, "ask").mockResolvedValue(TEST_PASSWORD);

			const unprotectSuccPromise = (
				harness.plugin as unknown as { unprotectViaModal: () => Promise<void> }
			).unprotectViaModal();
			await unprotectWriteStarted.promise;

			// Unload while unprotect vault.modify is already submitted in flight
			harness.unloadPlugin("onunload-first");
			unprotectWriteGate.resolve();
			await unprotectSuccPromise;
			await harness.patchController.drainPromise();

			const diskAfterSucc = harness.disk.get(fileSucc.path) ?? "";
			expect(diskAfterSucc).toBe(`${SECRET_P0}\n`);
			expect(parseFileContent(diskAfterSucc)).toBeNull();
			expect(
				harness.plugin.registry.list().some((e) => e.path === fileSucc.path),
			).toBe(false);

			// Subsequent native save does NOT resurrect old ciphertext over the unprotected note
			await paneSucc.view.save();
			expect(harness.disk.get(fileSucc.path)).toBe(`${SECRET_P0}\n`);
			expect(parseFileContent(harness.disk.get(fileSucc.path) ?? "")).toBeNull();
			failureEvidenceLines.push(
				`2b. Submitted unprotect succeeded across unload: final is plaintext=${String(parseFileContent(harness.disk.get(fileSucc.path) ?? "") === null)}, registry removed=true`,
			);

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			// 2c: Already-submitted unprotect FAILS across retirement -> remains protected and preserves ciphertext
			const unprotectFailGate = createDeferred<void>();
			const unprotectFailStarted = createDeferred<void>();

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: (targetPath) => {
					if (targetPath === "UnprotectSubmittedFail.md") {
						unprotectFailStarted.resolve();
					}
				},
				modifyGateForPath: (targetPath) =>
					targetPath === "UnprotectSubmittedFail.md"
						? unprotectFailGate.promise
						: null,
				shouldFailModify: (targetPath) =>
					targetPath === "UnprotectSubmittedFail.md"
						? new Error("Simulated disk full on unprotect")
						: null,
			});
			activeHarness = harness;

			const { file: fileFail, pane: paneFail } = await harness.seedProtectedNote({
				path: "UnprotectSubmittedFail.md",
				realText: SECRET_P0,
			});
			await harness.plugin.registry.add(fileFail.path, {
				noteId: "note-fail",
				addedAt: 1,
				mode: "portable",
			});
			vi.spyOn(PasswordModal.prototype, "ask").mockResolvedValue(TEST_PASSWORD);

			const unprotectFailPromise = (
				harness.plugin as unknown as { unprotectViaModal: () => Promise<void> }
			).unprotectViaModal();
			await unprotectFailStarted.promise;

			harness.unloadPlugin("cleanup-first");
			unprotectFailGate.resolve();
			await unprotectFailPromise;
			await harness.patchController.drainPromise();

			await paneFail.view.save();
			const inspectedFail = await inspectSavedFile(
				harness.disk.get(fileFail.path) ?? "",
				TEST_PASSWORD,
			);
			expect(inspectedFail.isProtected).toBe(true);
			expect(inspectedFail.realText).toBe(SECRET_P0);
			expect(
				harness.plugin.registry.list().some((e) => e.path === fileFail.path),
			).toBe(true);
			failureEvidenceLines.push(
				`2c. Submitted unprotect failed across unload: remains protected=${String(inspectedFail.isProtected)}, registry retained=true`,
			);

			harness.restorePrototype();
			activeHarness = null;
		}

		// Scenario 3: protectFile submitted write commits across retirement -> registry.add completes, staged image deletion and retitle skipped
		{
			const protectWriteGate = createDeferred<void>();
			const protectWriteStarted = createDeferred<void>();

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: (targetPath) => {
					if (targetPath === "PlainToProtect.md") {
						protectWriteStarted.resolve();
					}
				},
				modifyGateForPath: (targetPath) =>
					targetPath === "PlainToProtect.md" ? protectWriteGate.promise : null,
			});
			activeHarness = harness;

			const plainFile = makeMockFile("PlainToProtect.md");
			const plainWithImage = `${SECRET_P0}\n![[Pasted chart.png]]`;
			harness.disk.set(plainFile.path, plainWithImage);
			harness.disk.set("Pasted chart.png", "raw-image-bytes");
			harness.createPane(plainFile, plainWithImage);

			let capturedOnProtect:
				| ((res: { decoy: string; password: string }) => Promise<void>)
				| null = null;
			vi.spyOn(ProtectWizard.prototype, "open").mockImplementation(function (
				this: ProtectWizard,
			) {
				const deps = (
					this as unknown as {
						deps: {
							onProtect: (res: { decoy: string; password: string }) => Promise<void>;
						};
					}
				).deps;
				capturedOnProtect = deps.onProtect;
			});

			await (
				harness.plugin as unknown as { protectFile: (f: typeof plainFile) => Promise<void> }
			).protectFile(plainFile);
			expect(capturedOnProtect).not.toBeNull();

			const onProtectPromise = capturedOnProtect!({
				decoy: `# Cover Title\n\n${DEFAULT_DECOY}`,
				password: TEST_PASSWORD,
			});
			await protectWriteStarted.promise;

			// Unload while protectFile's vault.modify is in flight
			harness.unloadPlugin("onunload-first");
			protectWriteGate.resolve();
			await onProtectPromise;

			expect(
				harness.plugin.registry.list().some((e) => e.path === "PlainToProtect.md"),
			).toBe(true);
			expect(harness.deletedImages).toEqual([]);
			expect(harness.disk.has("Pasted chart.png")).toBe(true);
			expect(plainFile.path).toBe("PlainToProtect.md");
			failureEvidenceLines.push(
				`3. protectFile committed across unload: registry added=true, staged source images deleted=${harness.deletedImages.length} (expected 0), retitle skipped=${String(plainFile.path === "PlainToProtect.md")}`,
			);

			harness.restorePrototype();
			activeHarness = null;
		}

		// Scenario 4: password change & refreshDecoy paused at crypto / submitted-I/O boundaries
		{
			const pwWriteGate = createDeferred<void>();
			const pwWriteStarted = createDeferred<void>();

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: (targetPath) => {
					if (targetPath === "PasswordCommit.md") {
						pwWriteStarted.resolve();
					}
				},
				modifyGateForPath: (targetPath) =>
					targetPath === "PasswordCommit.md" ? pwWriteGate.promise : null,
			});
			activeHarness = harness;

			const { file: pwFile, pane: pwPane } = await harness.seedProtectedNote({
				path: "PasswordCommit.md",
				realText: SECRET_P0,
			});
			vi.spyOn(PasswordModal.prototype, "ask")
				.mockResolvedValueOnce(TEST_PASSWORD)
				.mockResolvedValueOnce(NEXT_TEST_PASSWORD);

			const pwPromise = (
				harness.plugin as unknown as { changePasswordViaModal: () => Promise<void> }
			).changePasswordViaModal();
			await pwWriteStarted.promise;

			harness.unloadPlugin("onunload-first");
			pwWriteGate.resolve();
			await pwPromise;
			await harness.patchController.drainPromise();

			await pwPane.view.save();
			const inspectedRotated = await inspectSavedFile(
				harness.disk.get(pwFile.path) ?? "",
				NEXT_TEST_PASSWORD,
			);
			expect(inspectedRotated.isProtected).toBe(true);
			expect(inspectedRotated.realText).toBe(SECRET_P0);
			failureEvidenceLines.push(
				`4. Submitted password rotation committed across unload: decrypts with NEXT_TEST_PASSWORD=${String(inspectedRotated.realText === SECRET_P0)}`,
			);

			harness.restorePrototype();
			activeHarness = null;
		}

		// Scenario 5: LockEngine stopped while maskAll awaits lockAll + clipboard permission rejection + generator unload rejection
		{
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const generatorError = new Error("Simulated generator unload failure");
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				generatorUnloadError: generatorError,
			});
			activeHarness = harness;

			const { session } = await harness.seedProtectedNote({
				path: "LockEngineStop.md",
				realText: SECRET_P0,
			});
			expect(await harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");

			harness.plugin.settings.clearClipboardOnLock = true;
			harness.plugin.lockEngine.clipboard.markTainted(SECRET_P0);
			const origClipboard = Object.getOwnPropertyDescriptor(globalThis, "navigator");
			Object.defineProperty(globalThis, "navigator", {
				value: {
					clipboard: {
						readText: async () => {
							throw new Error("Simulated clipboard permission denied");
						},
						writeText: async () => {
							throw new Error("Simulated clipboard write denied");
						},
					},
				},
				configurable: true,
			});

			const lockAllGate = createDeferred<void>();
			const lockAllEntered = createDeferred<void>();
			vi.spyOn(harness.sessions, "lockAll").mockImplementation(async () => {
				lockAllEntered.resolve();
				await lockAllGate.promise;
			});

			try {
				const maskPromise = harness.plugin.lockEngine.maskAll("window-blur");
				await lockAllEntered.promise;

				// Unload stops LockEngine while maskAll is suspended inside lockAll, and triggers generator unload + clipboard clear
				harness.unloadPlugin("onunload-first");
				expect(harness.plugin.lockEngine.isStopped()).toBe(true);
				expect(vi.getTimerCount()).toBe(0);

				lockAllGate.resolve();
				await maskPromise;
				await Promise.resolve();
				await Promise.resolve();

				// Stopped LockEngine must NOT rearm idleTimer after lockAll resolves
				expect(vi.getTimerCount()).toBe(0);
				harness.plugin.lockEngine.armIdleTimer();
				harness.plugin.lockEngine.onSessionUnlocked();
				expect(vi.getTimerCount()).toBe(0);
				expect(harness.generatorUnloadCalls()).toBe(1);

				failureEvidenceLines.push(
					`5. LockEngine stopped mid-maskAll: timers after resolution=${vi.getTimerCount()} (expected 0), clipboard & generator rejections isolated=true`,
				);
			} finally {
				if (origClipboard) {
					Object.defineProperty(globalThis, "navigator", origClipboard);
				}
				warnSpy.mockRestore();
				vi.useRealTimers();
			}

			harness.restorePrototype();
			activeHarness = null;
			expect(peekSharedLifecycleCoordinator()).toBeNull();
		}

		ensureEvidenceDir();
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, "task-5-failures.txt"),
			[
				"=== Wave 3 Task 5: Command Commit Boundaries & Failure Isolation Evidence ===",
				...failureEvidenceLines,
			].join("\n") + "\n",
			"utf8",
		);
	}, 20000);

	it("releases terminal dispositions after unprotect/shred, reconciles frozen P1 over committed P0 on successor attach, avoids outer-wrapper recursion across reloads, and orders guarded save behind in-flight enqueueWrite", async () => {
		{
			const harness = createPluginUnloadHarness(VeneerPlugin);
			activeHarness = harness;

			const { file, pane } = await harness.seedProtectedNote({
				path: "LiveUnprotectEdit.md",
				realText: SECRET_P0,
			});
			await harness.plugin.registry.add(file.path, {
				noteId: "note-live-unprotect",
				addedAt: 1,
				mode: "portable",
			});
			vi.spyOn(PasswordModal.prototype, "ask").mockResolvedValueOnce(TEST_PASSWORD);

			await (
				harness.plugin as unknown as { unprotectViaModal: () => Promise<void> }
			).unprotectViaModal();

			const editedOrdinaryLive = `${SECRET_P0}\n\nNew ordinary paragraph after live unprotect.`;
			pane.typeInEditor(editedOrdinaryLive);
			await pane.view.save();

			expect(harness.disk.get(file.path)).toBe(editedOrdinaryLive);
			expect(parseFileContent(harness.disk.get(file.path) ?? "")).toBeNull();

			pane.typeInEditor("");
			await pane.view.save();
			expect(harness.disk.get(file.path)).toBe("");

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			const unprotectGate = createDeferred<void>();
			const unprotectStarted = createDeferred<void>();
			let holdModify = true;

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: (targetPath) => {
					if (targetPath === "UnloadUnprotectEdit.md" && holdModify) {
						unprotectStarted.resolve();
					}
				},
				modifyGateForPath: (targetPath) => {
					if (targetPath === "UnloadUnprotectEdit.md" && holdModify) {
						holdModify = false;
						return unprotectGate.promise;
					}
					return null;
				},
			});
			activeHarness = harness;

			const { file, pane } = await harness.seedProtectedNote({
				path: "UnloadUnprotectEdit.md",
				realText: SECRET_P0,
			});
			await harness.plugin.registry.add(file.path, {
				noteId: "note-unload-unprotect",
				addedAt: 1,
				mode: "portable",
			});
			vi.spyOn(PasswordModal.prototype, "ask").mockResolvedValueOnce(TEST_PASSWORD);

			const unprotectPromise = (
				harness.plugin as unknown as { unprotectViaModal: () => Promise<void> }
			).unprotectViaModal();
			await unprotectStarted.promise;

			harness.unloadPlugin("onunload-first");
			unprotectGate.resolve();
			await unprotectPromise;
			await harness.patchController.drainPromise();

			const editedBeforeFirstSave = `${SECRET_P0}\n\nEdited before the very first save after unload unprotect.`;
			pane.typeInEditor(editedBeforeFirstSave);
			await pane.view.save();
			expect(harness.disk.get(file.path)).toBe(editedBeforeFirstSave);
			expect(parseFileContent(harness.disk.get(file.path) ?? "")).toBeNull();

			const editedOrdinaryAfterUnload = `${editedBeforeFirstSave}\n\nNew ordinary paragraph after unload unprotect.`;
			pane.typeInEditor(editedOrdinaryAfterUnload);
			await pane.view.save();

			expect(harness.disk.get(file.path)).toBe(editedOrdinaryAfterUnload);
			expect(parseFileContent(harness.disk.get(file.path) ?? "")).toBeNull();

			pane.typeInEditor("");
			await pane.view.save();
			expect(harness.disk.get(file.path)).toBe("");

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			const unprotectGate = createDeferred<void>();
			const unprotectStarted = createDeferred<void>();
			let holdModify = true;

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: (targetPath) => {
					if (targetPath === "TwoPaneUnloadUnprotect.md" && holdModify) {
						unprotectStarted.resolve();
					}
				},
				modifyGateForPath: (targetPath) => {
					if (targetPath === "TwoPaneUnloadUnprotect.md" && holdModify) {
						holdModify = false;
						return unprotectGate.promise;
					}
					return null;
				},
			});
			activeHarness = harness;

			const {
				file,
				pane: pane1,
				initialFileContent,
			} = await harness.seedProtectedNote({
				path: "TwoPaneUnloadUnprotect.md",
				realText: SECRET_P0,
			});
			const pane2 = harness.createPane(file, DEFAULT_DECOY);
			pane2.view.setViewData(initialFileContent, true);

			await harness.plugin.registry.add(file.path, {
				noteId: "note-two-pane-unload-unprotect",
				addedAt: 1,
				mode: "portable",
			});
			vi.spyOn(PasswordModal.prototype, "ask").mockResolvedValueOnce(TEST_PASSWORD);

			const unprotectPromise = (
				harness.plugin as unknown as { unprotectViaModal: () => Promise<void> }
			).unprotectViaModal();
			await unprotectStarted.promise;

			harness.unloadPlugin("onunload-first");

			const queuedSave1 = pane1.view.save();
			const queuedSave2 = pane2.view.save();

			unprotectGate.resolve();
			await Promise.all([unprotectPromise, queuedSave1, queuedSave2]);
			await harness.patchController.drainPromise();

			expect(harness.disk.get(file.path)).toBe(`${SECRET_P0}\n`);
			expect(parseFileContent(harness.disk.get(file.path) ?? "")).toBeNull();

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			const registryRemoveStarted = createDeferred<void>();
			const registryRemoveGate = createDeferred<void>();

			const harness = createPluginUnloadHarness(VeneerPlugin);
			activeHarness = harness;

			const { file, pane } = await harness.seedProtectedNote({
				path: "UnloadDuringRegistryRemove.md",
				realText: SECRET_P0,
			});
			await harness.plugin.registry.add(file.path, {
				noteId: "note-unload-during-registry-remove",
				addedAt: 1,
				mode: "portable",
			});
			const origRemove = harness.plugin.registry.remove.bind(harness.plugin.registry);
			vi.spyOn(harness.plugin.registry, "remove").mockImplementationOnce(
				async (targetPath: string) => {
					registryRemoveStarted.resolve();
					await registryRemoveGate.promise;
					await origRemove(targetPath);
				},
			);
			vi.spyOn(PasswordModal.prototype, "ask").mockResolvedValueOnce(TEST_PASSWORD);

			const unprotectPromise = (
				harness.plugin as unknown as { unprotectViaModal: () => Promise<void> }
			).unprotectViaModal();
			await registryRemoveStarted.promise;

			harness.unloadPlugin("onunload-first");
			registryRemoveGate.resolve();
			await unprotectPromise;
			await harness.patchController.drainPromise();

			await pane.view.save();
			expect(harness.disk.get(file.path)).toBe(`${SECRET_P0}\n`);
			expect(parseFileContent(harness.disk.get(file.path) ?? "")).toBeNull();

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			const harness = createPluginUnloadHarness(VeneerPlugin);
			activeHarness = harness;

			const { file, pane, session, initialFileContent } = await harness.seedProtectedNote({
				path: "ShreddedCoverEdit.md",
				realText: SECRET_P0,
			});
			await harness.plugin.registry.add(file.path, {
				noteId: session.originalPayload.note_id,
				addedAt: 1,
				mode: "portable",
			});

			const untrackedPane = harness.createPane(file, DEFAULT_DECOY, "backing-data");
			(untrackedPane.view as unknown as { data: string }).data = initialFileContent;

			await (harness.plugin as unknown as { runShred: () => Promise<void> }).runShred();
			expect(harness.disk.get(file.path)).toBe(`${DEFAULT_DECOY}\n`);

			await untrackedPane.view.save();
			expect(parseFileContent(harness.disk.get(file.path) ?? "")).toBeNull();
			expect(harness.disk.get(file.path)).toBe(`${DEFAULT_DECOY}\n`);
			expect(
				getSharedLifecycleCoordinator().getCommittedDisposition(harness.app, file),
			).toBeNull();

			const newCoverEdits = `${EDITED_DECOY}\n- oat milk`;
			pane.typeInEditor(newCoverEdits);
			await pane.view.save();

			expect(harness.disk.get(file.path)).toBe(newCoverEdits);
			expect(parseFileContent(harness.disk.get(file.path) ?? "")).toBeNull();

			let reprotectCallback:
				| ((res: { decoy: string; password: string }) => Promise<void>)
				| null = null;
			vi.spyOn(ProtectWizard.prototype, "open").mockImplementationOnce(function (
				this: ProtectWizard,
			) {
				const deps = (
					this as unknown as {
						deps: {
							onProtect: (res: { decoy: string; password: string }) => Promise<void>;
						};
					}
				).deps;
				reprotectCallback = deps.onProtect;
			});

			await (
				harness.plugin as unknown as { protectFile: (f: typeof file) => Promise<void> }
			).protectFile(file);
			expect(reprotectCallback).not.toBeNull();
			await reprotectCallback!({
				decoy: `# Shredded CoverEdit\n\n${DEFAULT_DECOY}`,
				password: NEXT_TEST_PASSWORD,
			});

			const reprotectedDisk = harness.disk.get(file.path) ?? "";
			const inspectedReprotected = await inspectSavedFile(
				reprotectedDisk,
				NEXT_TEST_PASSWORD,
			);
			expect(inspectedReprotected.isProtected).toBe(true);
			expect(inspectedReprotected.realText).toBe(newCoverEdits);

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			const harness = createPluginUnloadHarness(VeneerPlugin);
			activeHarness = harness;

			const { file, pane, session } = await harness.seedProtectedNote({
				path: "CommittedP0FrozenP1.md",
				realText: SECRET_P0,
			});
			expect(await harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");

			await pane.view.save();
			const coordinator = getSharedLifecycleCoordinator();
			expect(coordinator.getCommittedDisposition(harness.app, file)?.kind).toBe("protected");

			await harness.stageCompletedPendingPayload(session, SECRET_P1);
			const diskStillP0 = harness.disk.get(file.path) ?? "";
			expect((await inspectSavedFile(diskStillP0, TEST_PASSWORD)).realText).toBe(SECRET_P0);

			harness.unloadPlugin("onunload-first");
			expect(coordinator.getFrozenSnapshot(harness.app, file)).not.toBeNull();

			const sessions2 = new SessionManager(
				harness.app,
				{
					onUnlocked: () => undefined,
					onLocked: () => undefined,
					onUnlockBlocked: () => undefined,
				},
				() => ";;",
				() => null,
				coordinator,
			);
			const parsedStaleDisk = parseFileContent(diskStillP0);
			expect(parsedStaleDisk).not.toBeNull();
			const successorSession = sessions2.attachFromLoad(pane.view, file, parsedStaleDisk!);

			expect(await sessions2.unlock(successorSession, TEST_PASSWORD)).toBe("ok");
			expect(pane.getEditorText()).toBe(SECRET_P1);

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			const harness = createPluginUnloadHarness(VeneerPlugin);
			activeHarness = harness;

			const { pane } = await harness.seedProtectedNote({
				path: "OuterWrapperReload.md",
				realText: SECRET_P0,
			});

			const proto = MarkdownView.prototype as unknown as {
				save: (this: MarkdownView, clear?: boolean) => Promise<void>;
			};
			const veneeredSave = proto.save;
			let outerCallCount = 0;
			const outerWrapper = async function (this: MarkdownView, clear?: boolean): Promise<void> {
				outerCallCount += 1;
				if (outerCallCount > 5) {
					throw new Error("Infinite recursion detected in outerWrapper");
				}
				await veneeredSave.call(this, clear);
			};
			proto.save = outerWrapper;

			harness.unloadPlugin("onunload-first");
			await harness.patchController.drainPromise();

			const coordinator = getSharedLifecycleCoordinator();
			const sessions2 = new SessionManager(
				harness.app,
				{
					onUnlocked: () => undefined,
					onLocked: () => undefined,
					onUnlockBlocked: () => undefined,
				},
				() => ";;",
				() => null,
				coordinator,
			);
			const cleanups2: Array<() => void> = [];
			const controller2 = installViewPatches(sessions2, (fn) => cleanups2.push(fn));

			await pane.view.save();
			expect(outerCallCount).toBe(1);

			controller2.retireAndHandoff();
			await controller2.drainPromise();
			for (const fn of cleanups2) fn();

			harness.restorePrototype();
			activeHarness = null;
		}

		{
			const gateP0 = createDeferred<void>();
			const startedP0 = createDeferred<void>();
			const orderTrace: string[] = [];
			let holdFirstModify = true;

			const harness = createPluginUnloadHarness(VeneerPlugin, {
				onModifyStart: (targetPath) => {
					if (targetPath === "EnqueueWriteOrder.md" && holdFirstModify) {
						orderTrace.push("enqueueWrite:P0:start");
						startedP0.resolve();
					}
				},
				modifyGateForPath: (targetPath) => {
					if (targetPath === "EnqueueWriteOrder.md" && holdFirstModify) {
						holdFirstModify = false;
						return gateP0.promise.then(() => {
							orderTrace.push("enqueueWrite:P0:commit");
						});
					}
					return null;
				},
				onNativeSaveStart: ({ path: targetPath }) => {
					if (targetPath === "EnqueueWriteOrder.md") {
						orderTrace.push("guardedSave:P1:start");
					}
				},
			});
			activeHarness = harness;

			const { file, pane, session, initialFileContent } = await harness.seedProtectedNote({
				path: "EnqueueWriteOrder.md",
				realText: SECRET_P0,
			});
			expect(await harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");

			const inFlightP0 = harness.sessions.enqueueWrite(session, async () => {
				await harness.app.vault.modify(file, initialFileContent);
			});
			await startedP0.promise;

			await harness.stageCompletedPendingPayload(session, SECRET_P1);
			harness.unloadPlugin("onunload-first");

			const guardedSaveP1 = pane.view.save().then(() => {
				orderTrace.push("guardedSave:P1:commit");
			});

			await Promise.resolve();
			expect(orderTrace).toEqual(["enqueueWrite:P0:start"]);

			gateP0.resolve();
			await inFlightP0;
			await guardedSaveP1;

			expect(orderTrace).toEqual([
				"enqueueWrite:P0:start",
				"enqueueWrite:P0:commit",
				"guardedSave:P1:start",
				"guardedSave:P1:commit",
			]);

			const finalDisk = harness.disk.get(file.path) ?? "";
			const inspectedFinal = await inspectSavedFile(finalDisk, TEST_PASSWORD);
			expect(inspectedFinal.isProtected).toBe(true);
			expect(inspectedFinal.realText).toBe(SECRET_P1);

			harness.restorePrototype();
			activeHarness = null;
		}
	}, 20000);
});
