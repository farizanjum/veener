import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "obsidian";
import { changePassword, createFile, parseFileContent } from "../src/crypto/payload";
import { VIEW_LIFECYCLE_SYMBOL } from "../src/view/lifecycle";
import { REENCRYPT_DEBOUNCE_MS } from "../src/view/session";
import {
	createDeferred,
	createViewUnloadHarness,
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
	type ViewUnloadHarness,
} from "./helpers/unloadHarness";

const EVIDENCE_DIR = path.resolve(process.cwd(), ".omo", "evidence", "issue-13");

/** Ensures the `.omo/evidence/issue-13` output directory exists before writing evidence files. */
function ensureEvidenceDir(): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

describe("View patch unload handoff and native save regressions (Issue #13)", () => {
	let activeHarness: ViewUnloadHarness | null = null;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		activeHarness?.restorePrototype();
		activeHarness = null;
		const holder = MarkdownView.prototype as unknown as Record<symbol, unknown>;
		delete holder[VIEW_LIFECYCLE_SYMBOL];
		vi.restoreAllMocks();
		vi.useRealTimers();
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

	it("freezes identical canonical snapshots (EDITED_DECOY + P1, excluding held in-flight P2) across disagreeing locked/unlocked panes regardless of pane attachment order, and writes task-4-snapshots.txt + task-4-native-save.md", async () => {
		const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);

		const runDisagreeingOrderScenario = async (
			order: "unlocked-first" | "locked-first",
		): Promise<{
			handedOffPaneA: string;
			handedOffPaneB: string;
			savedOnDisk: string;
			inspectedHandedOff: Awaited<ReturnType<typeof inspectSavedFile>>;
			inspectedSaved: Awaited<ReturnType<typeof inspectSavedFile>>;
			snapshotRevision: number;
		}> => {
			const harness = createViewUnloadHarness({ defaultNativeSaveMode: "recompute" });
			activeHarness = harness;

			const file = makeMockFile("DisagreeingPanes.md");
			const created = await createFile(
				SECRET_P0,
				TEST_PASSWORD,
				DEFAULT_DECOY,
				undefined,
				undefined,
				SECRET_REAL_TITLE,
			);
			harness.disk.set(file.path, created.fileContent);

			const paneFirst = harness.createPane(file, DEFAULT_DECOY, "recompute");
			paneFirst.view.setViewData(created.fileContent, true);
			const sessionFirst = harness.sessions.get(paneFirst.view)!;

			const paneSecond = harness.createPane(file, DEFAULT_DECOY, "backing-data");
			paneSecond.view.setViewData(created.fileContent, true);
			const sessionSecond = harness.sessions.get(paneSecond.view)!;

			const unlockedPane = order === "unlocked-first" ? paneFirst : paneSecond;
			const unlockedSession = order === "unlocked-first" ? sessionFirst : sessionSecond;
			const lockedPane = order === "unlocked-first" ? paneSecond : paneFirst;
			const lockedSession = order === "unlocked-first" ? sessionSecond : sessionFirst;

			// Given: unlocked pane has completed re-encryption P1 and an in-flight held re-encryption for P2, while locked sibling pane has edited cover EDITED_DECOY
			expect(await harness.sessions.unlock(unlockedSession, TEST_PASSWORD)).toBe("ok");
			await harness.stageCompletedPendingPayload(unlockedSession, SECRET_P1);

			lockedPane.typeInEditor(EDITED_DECOY);
			expect(lockedSession.state).toBe("locked");

			const holdP2Gate = createDeferred<void>();
			const p2EncryptEntered = createDeferred<void>();
			let holdNextEncrypt = true;
			const encryptSpy = vi
				.spyOn(crypto.subtle, "encrypt")
				.mockImplementation(async (alg, key, data): Promise<ArrayBuffer> => {
					if (holdNextEncrypt) {
						holdNextEncrypt = false;
						p2EncryptEntered.resolve();
						await holdP2Gate.promise;
					}
					return originalEncrypt(alg, key, data);
				});

			try {
				unlockedPane.typeInEditor(SECRET_P2_TAIL);
				harness.sessions.scheduleReencrypt(unlockedSession);
				await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
				await p2EncryptEntered.promise;

				// When: shutdownAndHandoff runs synchronously while P2 encryption is still in flight
				harness.unloadPatches();

				const handoff = harness.sessions.getShutdownHandoffResult();
				expect(handoff).not.toBeNull();
				const frozen = handoff?.snapshotsByFile.get(file);
				expect(frozen).toBeDefined();

				holdP2Gate.resolve();
				if (unlockedSession.reencryptPromise) {
					await unlockedSession.reencryptPromise;
				}
			} finally {
				encryptSpy.mockRestore();
			}

			// Then: both panes hold the exact same full serialized document, native setter was called with (fullRaw, true), and native save persists P1 + EDITED_DECOY
			const handedOffUnlocked = unlockedPane.getEditorText();
			const handedOffLocked = lockedPane.getEditorText();
			expect(handedOffUnlocked).toBe(handedOffLocked);
			expect(unlockedPane.getBackingData()).toBe(handedOffUnlocked);
			expect(lockedPane.getBackingData()).toBe(handedOffLocked);
			expect(unlockedPane.undoHistory).toEqual([]);
			expect(lockedPane.undoHistory).toEqual([]);

			const lastSetCalls = harness.nativeSetCalls.slice(-2);
			expect(lastSetCalls).toHaveLength(2);
			for (const call of lastSetCalls) {
				expect(call.clear).toBe(true);
				expect(call.data).toBe(handedOffUnlocked);
			}

			expect(handedOffUnlocked).not.toContain(SECRET_P0);
			expect(handedOffUnlocked).not.toContain(SECRET_P1);
			expect(handedOffUnlocked).not.toContain(SECRET_P2_TAIL);
			expect(handedOffUnlocked).not.toContain(SECRET_REAL_TITLE);

			await unlockedPane.view.save();
			const savedOnDisk = harness.disk.get(file.path) ?? "";

			const inspectedHandedOff = await inspectSavedFile(handedOffUnlocked, TEST_PASSWORD);
			const inspectedSaved = await inspectSavedFile(savedOnDisk, TEST_PASSWORD);

			const snapshotRevision =
				harness.sessions.getShutdownHandoffResult()?.snapshotsByFile.get(file)?.revision ?? 0;

			harness.restorePrototype();
			activeHarness = null;
			const holder = MarkdownView.prototype as unknown as Record<symbol, unknown>;
			delete holder[VIEW_LIFECYCLE_SYMBOL];

			return {
				handedOffPaneA: handedOffUnlocked,
				handedOffPaneB: handedOffLocked,
				savedOnDisk,
				inspectedHandedOff,
				inspectedSaved,
				snapshotRevision,
			};
		};

		const orderUnlockedFirst = await runDisagreeingOrderScenario("unlocked-first");
		const orderLockedFirst = await runDisagreeingOrderScenario("locked-first");

		const coverOnlyNegativeControl = await inspectSavedFile(EDITED_DECOY, TEST_PASSWORD);
		expect(coverOnlyNegativeControl.isProtected).toBe(false);

		expect(orderUnlockedFirst.inspectedHandedOff.isProtected).toBe(true);
		expect(orderUnlockedFirst.inspectedHandedOff.decoyBody).toBe(EDITED_DECOY);
		expect(orderUnlockedFirst.inspectedHandedOff.realText).toBe(SECRET_P1);
		expect(orderUnlockedFirst.inspectedHandedOff.realTitle).toBe(SECRET_REAL_TITLE);

		expect(orderUnlockedFirst.inspectedSaved.isProtected).toBe(true);
		expect(orderUnlockedFirst.inspectedSaved.decoyBody).toBe(EDITED_DECOY);
		expect(orderUnlockedFirst.inspectedSaved.realText).toBe(SECRET_P1);
		expect(orderUnlockedFirst.inspectedSaved.realTitle).toBe(SECRET_REAL_TITLE);

		expect(orderLockedFirst.inspectedHandedOff.isProtected).toBe(true);
		expect(orderLockedFirst.inspectedHandedOff.decoyBody).toBe(EDITED_DECOY);
		expect(orderLockedFirst.inspectedHandedOff.realText).toBe(SECRET_P1);
		expect(orderLockedFirst.inspectedHandedOff.realTitle).toBe(SECRET_REAL_TITLE);

		expect(orderLockedFirst.inspectedSaved.isProtected).toBe(true);
		expect(orderLockedFirst.inspectedSaved.decoyBody).toBe(EDITED_DECOY);
		expect(orderLockedFirst.inspectedSaved.realText).toBe(SECRET_P1);
		expect(orderLockedFirst.inspectedSaved.realTitle).toBe(SECRET_REAL_TITLE);

		expect(orderUnlockedFirst.inspectedSaved.decoyBody).toBe(
			orderLockedFirst.inspectedSaved.decoyBody,
		);
		expect(orderUnlockedFirst.inspectedSaved.realText).toBe(
			orderLockedFirst.inspectedSaved.realText,
		);
		expect(orderUnlockedFirst.inspectedSaved.realTitle).toBe(
			orderLockedFirst.inspectedSaved.realTitle,
		);

		ensureEvidenceDir();
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, "task-4-native-save.md"),
			orderUnlockedFirst.savedOnDisk,
			"utf8",
		);
		const snapshotsEvidence = [
			"=== Wave 3 Task 4: Canonical Safe Snapshot & Native Save Evidence ===",
			`Cover-only negative control rejected (isProtected === false): ${String(coverOnlyNegativeControl.isProtected === false)}`,
			`Order 1 (unlocked-first) handed-off parses via parseFileContent: ${String(orderUnlockedFirst.inspectedHandedOff.isProtected)}`,
			`Order 1 (unlocked-first) handed-off decoyBody === EDITED_DECOY: ${String(orderUnlockedFirst.inspectedHandedOff.decoyBody === EDITED_DECOY)}`,
			`Order 1 (unlocked-first) handed-off decrypts to SECRET_P1: ${String(orderUnlockedFirst.inspectedHandedOff.realText === SECRET_P1)}`,
			`Order 1 (unlocked-first) SECRET_P2_TAIL absent from raw & decrypted: ${String(!orderUnlockedFirst.savedOnDisk.includes(SECRET_P2_TAIL) && orderUnlockedFirst.inspectedSaved.realText !== SECRET_P2_TAIL)}`,
			`Order 1 (unlocked-first) SECRET_P1 absent from raw decoy body: ${String(!orderUnlockedFirst.savedOnDisk.includes(SECRET_P1))}`,
			`Order 2 (locked-first / reversed) handed-off parses via parseFileContent: ${String(orderLockedFirst.inspectedHandedOff.isProtected)}`,
			`Order 2 (locked-first / reversed) handed-off decoyBody === EDITED_DECOY: ${String(orderLockedFirst.inspectedHandedOff.decoyBody === EDITED_DECOY)}`,
			`Order 2 (locked-first / reversed) handed-off decrypts to SECRET_P1: ${String(orderLockedFirst.inspectedHandedOff.realText === SECRET_P1)}`,
			`Order 1 and Order 2 decrypted outcomes identical: ${String(orderUnlockedFirst.inspectedSaved.realText === orderLockedFirst.inspectedSaved.realText && orderUnlockedFirst.inspectedSaved.decoyBody === orderLockedFirst.inspectedSaved.decoyBody)}`,
			"",
			"--- Full Handed-Off Serialized Safe File (Order 1: unlocked-first) ---",
			orderUnlockedFirst.handedOffPaneA,
			"",
			"--- Full Handed-Off Serialized Safe File (Order 2: locked-first / reversed) ---",
			orderLockedFirst.handedOffPaneA,
			"",
			"--- Post-Native-Save File Content ---",
			orderUnlockedFirst.savedOnDisk,
		].join("\n");
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, "task-4-snapshots.txt"),
			`${snapshotsEvidence}\n`,
			"utf8",
		);
	});

	it("orders completed re-encryptions by input-capture revision (not promise completion order), honors coordinator settled state on initial load, and publishes password/refresh authority only on host commit", async () => {
		const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
		const harness = createViewUnloadHarness();
		activeHarness = harness;

		const { file, pane: paneA, session: sessionA } = await harness.seedProtectedNote({
			path: "RevisionOrder.md",
			realText: SECRET_P0,
		});
		const paneB = harness.createPane(file, DEFAULT_DECOY);
		const sessionB = harness.sessions.attachFromLoad(paneB.view, file, parseFileContent(harness.disk.get(file.path)!)!);

		expect(await harness.sessions.unlock(sessionA, TEST_PASSWORD)).toBe("ok");
		expect(await harness.sessions.unlock(sessionB, TEST_PASSWORD)).toBe("ok");

		// Given: Pane A captures encryption input first (OLDER_INPUT) and is held inside crypto.subtle.encrypt, while Pane B captures encryption input second (NEWER_INPUT) and finishes first
		const olderGate = createDeferred<void>();
		const olderEntered = createDeferred<void>();
		let encryptCount = 0;
		const encryptSpy = vi
			.spyOn(crypto.subtle, "encrypt")
			.mockImplementation(async (alg, key, data): Promise<ArrayBuffer> => {
				encryptCount += 1;
				if (encryptCount === 1) {
					olderEntered.resolve();
					await olderGate.promise;
				}
				return originalEncrypt(alg, key, data);
			});

		try {
			paneA.setEditorText("OLDER_CAPTURED_INPUT_R1");
			harness.sessions.scheduleReencrypt(sessionA);
			await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
			await olderEntered.promise;

			paneB.setEditorText(SECRET_P1);
			harness.sessions.scheduleReencrypt(sessionB);
			await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
			if (sessionB.reencryptPromise) {
				await sessionB.reencryptPromise;
			}

			olderGate.resolve();
			if (sessionA.reencryptPromise) {
				await sessionA.reencryptPromise;
			}
		} finally {
			encryptSpy.mockRestore();
		}

		await harness.sessions.lock(sessionA, "pre-rotate");
		await harness.sessions.lock(sessionB, "pre-rotate");

		const rotatedUncommitted = await changePassword(
			sessionB.originalPayload,
			TEST_PASSWORD,
			NEXT_TEST_PASSWORD,
		);
		const releaseReserve = harness.sessions.reservePath(file.path);
		sessionA.originalPayload = rotatedUncommitted;
		sessionB.originalPayload = rotatedUncommitted;

		const initialP0Payload = parseFileContent(
			(await createFile(SECRET_P0, TEST_PASSWORD, DEFAULT_DECOY)).fileContent,
		)!.payload;
		sessionA.originalPayload = initialP0Payload;
		sessionB.originalPayload = initialP0Payload;
		releaseReserve();

		// When: unload and native save run
		harness.unloadPatches();
		await paneA.view.save();

		// Then: the saved file still decrypts with TEST_PASSWORD to SECRET_P1 (neither OLDER_CAPTURED_INPUT_R1 nor uncommitted NEXT_TEST_PASSWORD nor rollback P0 replaced it)
		const saved = harness.disk.get(file.path) ?? "";
		const inspected = await inspectSavedFile(saved, TEST_PASSWORD);
		expect(inspected.isProtected).toBe(true);
		expect(inspected.realText).toBe(SECRET_P1);
	});

	it("handles staging/encryption rejection, throwing native setter fallback + save-blocked unrecoverable view, switched view, and detached pendingLock outside byPath; writes task-4-failures.txt", async () => {
		let failNativeSetterForViews = new Set<MarkdownView>();

		const harness = createViewUnloadHarness({
			shouldFailNativeSetter: (view) =>
				failNativeSetterForViews.has(view)
					? new Error("Simulated native setViewData failure")
					: null,
		});
		activeHarness = harness;

		// Given: multi-pane notes with rejected encryption, throwing native setter, throwing fallback setter, throwing title DOM setter, switched file, and detached pendingLock
		const { file: file1, pane: pane1A, session: session1A } = await harness.seedProtectedNote({
			path: "RejectAndFallback.md",
			realText: SECRET_P0,
		});
		const parsed1 = parseFileContent(harness.disk.get(file1.path)!)!;
		const pane1B = harness.createPane(file1, DEFAULT_DECOY);
		const session1B = harness.sessions.attachFromLoad(pane1B.view, file1, parsed1);
		const pane1C = harness.createPane(file1, DEFAULT_DECOY);
		const session1C = harness.sessions.attachFromLoad(pane1C.view, file1, parsed1);

		expect(await harness.sessions.unlock(session1A, TEST_PASSWORD)).toBe("ok");
		expect(await harness.sessions.unlock(session1B, TEST_PASSWORD)).toBe("ok");
		expect(await harness.sessions.unlock(session1C, TEST_PASSWORD)).toBe("ok");

		await harness.stageCompletedPendingPayload(session1A, SECRET_P1);

		const encryptSpy = vi
			.spyOn(crypto.subtle, "encrypt")
			.mockRejectedValueOnce(new Error("Simulated WebCrypto encrypt failure"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			pane1A.setEditorText(SECRET_P2_TAIL);
			harness.sessions.scheduleReencrypt(session1A);
			await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
			if (session1A.reencryptPromise) {
				await session1A.reencryptPromise;
			}
		} finally {
			encryptSpy.mockRestore();
			warnSpy.mockRestore();
		}

		failNativeSetterForViews = new Set([pane1A.view, pane1B.view]);
		pane1B.view.editor.setValue = () => {
			throw new Error("Simulated fallback editor.setValue failure");
		};

		let allowTitleThrow = true;
		let inlineTitleText = SECRET_REAL_TITLE;
		Object.defineProperty(pane1C.inlineTitleEl, "textContent", {
			get: () => inlineTitleText,
			set: (val: string) => {
				if (allowTitleThrow && val === file1.basename) {
					throw new Error("Simulated inline-title DOM failure");
				}
				inlineTitleText = val;
			},
			configurable: true,
		});

		const modifyGate2 = createDeferred<void>();
		const modifyEntered2 = createDeferred<void>();
		const origModify = harness.app.vault.modify;
		harness.app.vault.modify = async (f, content) => {
			if (f.path === "SwitchedAndPendingLock.md") {
				modifyEntered2.resolve();
				await modifyGate2.promise;
			}
			return origModify(f, content);
		};

		const { file: file2, pane: pane2A, session: session2A } = await harness.seedProtectedNote({
			path: "SwitchedAndPendingLock.md",
			realText: SECRET_P0,
		});
		const parsed2 = parseFileContent(harness.disk.get(file2.path)!)!;
		const pane2B = harness.createPane(file2, DEFAULT_DECOY);
		const session2B = harness.sessions.attachFromLoad(pane2B.view, file2, parsed2);
		const pane2C = harness.createPane(file2, DEFAULT_DECOY);
		harness.sessions.attachFromLoad(pane2C.view, file2, parsed2);

		expect(await harness.sessions.unlock(session2A, TEST_PASSWORD)).toBe("ok");
		expect(await harness.sessions.unlock(session2B, TEST_PASSWORD)).toBe("ok");

		pane2C.typeInEditor(EDITED_DECOY);

		pane2A.setEditorText(SECRET_P1);
		const lockPromise2A = harness.sessions.lock(session2A, "pending-lock-outside-bypath");
		await modifyEntered2.promise;
		harness.sessions.detach(pane2A.view);
		expect(harness.sessions.getAllByPath(file2.path)).not.toContain(session2A);

		const unrelatedFile = makeMockFile("UnrelatedPlainNote.md");
		const unrelatedContent = "# Ordinary Unprotected Note\n\nNo veneer payload here.";
		harness.disk.set(unrelatedFile.path, unrelatedContent);
		pane2B.switchFile(unrelatedFile);
		pane2B.setEditorText(unrelatedContent);
		pane2B.setBackingData(unrelatedContent);

		// When: unloadPatches (shutdownAndHandoff) runs synchronously across all failure conditions
		harness.unloadPatches();
		const handoff = harness.sessions.getShutdownHandoffResult()!;
		expect(handoff).not.toBeNull();

		const secondHandoff = harness.sessions.shutdownAndHandoff();
		expect(secondHandoff).toBe(handoff);

		// Then: fallback views recover, unrecoverable views are save-blocked, switched views are skipped, and pendingLocks preserve P1
		const outcome1A = handoff.viewOutcomes.find((o) => o.view === pane1A.view);
		expect(outcome1A?.status).toBe("fallback-hydrated");
		expect(parseFileContent(pane1A.getEditorText())).not.toBeNull();
		await pane1A.view.save();
		const inspected1 = await inspectSavedFile(harness.disk.get(file1.path) ?? "", TEST_PASSWORD);
		expect(inspected1.isProtected).toBe(true);
		expect(inspected1.realText).toBe(SECRET_P1);

		const outcome1B = handoff.viewOutcomes.find((o) => o.view === pane1B.view);
		expect(outcome1B?.status).toBe("save-blocked");
		expect(handoff.hasSaveBlockedViews).toBe(true);
		expect(handoff.saveBlockedViews).toContain(pane1B.view);
		expect(harness.sessions.getCoordinator().isViewSaveBlocked(harness.app, pane1B.view)).toBe(
			true,
		);
		await expect(pane1B.view.save()).rejects.toThrow(/refusing native save/i);

		expect(parseFileContent(pane1C.getEditorText())).not.toBeNull();
		expect(pane1C.headerTitleEl.textContent).toBe(file1.basename);
		expect(pane1C.tabHeaderTitleEl.textContent).toBe(file1.basename);

		const outcome2B = handoff.viewOutcomes.find((o) => o.view === pane2B.view);
		expect(outcome2B?.status).toBe("skipped-switched-file");
		expect(pane2B.getEditorText()).toBe(unrelatedContent);
		expect(pane2B.getBackingData()).toBe(unrelatedContent);
		expect(pane2B.getDisplayedTitles().inline).toBe(unrelatedFile.basename);

		expect(parseFileContent(pane2A.getEditorText())).not.toBeNull();
		expect(parseFileContent(pane2C.getEditorText())).not.toBeNull();
		await pane2C.view.save();
		const inspected2 = await inspectSavedFile(harness.disk.get(file2.path) ?? "", TEST_PASSWORD);
		expect(inspected2.isProtected).toBe(true);
		expect(inspected2.decoyBody).toBe(EDITED_DECOY);
		expect(inspected2.realText).toBe(SECRET_P1);

		allowTitleThrow = false;
		modifyGate2.resolve();
		await lockPromise2A;

		ensureEvidenceDir();
		const failuresEvidence = [
			"=== Wave 3 Task 4: Failure Isolation & Save-Blocking Evidence ===",
			`1. Rejected encryption candidate preserved prior P1: ${String(inspected1.realText === SECRET_P1)}`,
			`2a. Throwing native setter with working fallback outcome: "${outcome1A?.status ?? ""}"`,
			`2b. Unrecoverable view (native setter + fallback both threw) outcome: "${outcome1B?.status ?? ""}"`,
			`2b. Unrecoverable view marked save-blocked in coordinator: ${String(harness.sessions.getCoordinator().isViewSaveBlocked(harness.app, pane1B.view))}`,
			`2b. Unrecoverable view in handoff.saveBlockedViews: ${String(handoff.saveBlockedViews.includes(pane1B.view))}`,
			`2c. Throwing inline-title setter isolated (pane1C editor sanitized, header/tab titles restored): ${String(parseFileContent(pane1C.getEditorText()) !== null && pane1C.headerTitleEl.textContent === file1.basename)}`,
			`3. Switched view (UnrelatedPlainNote.md) outcome: "${outcome2B?.status ?? ""}", content untouched: ${String(pane2B.getEditorText() === unrelatedContent)}`,
			`4. Detached pendingLock outside byPath contributed P1 and sanitized view: ${String(inspected2.realText === SECRET_P1 && parseFileContent(pane2A.getEditorText()) !== null)}`,
			`5. Disagreeing locked cover (EDITED_DECOY) + unlocked P1 combined cleanly: ${String(inspected2.decoyBody === EDITED_DECOY && inspected2.realText === SECRET_P1)}`,
			`6. Repeated shutdownAndHandoff() idempotent: ${String(secondHandoff === handoff)}`,
			`Recorded handoff failures count: ${handoff.failures.length}`,
			`Recorded isolated errors count: ${handoff.errors.length}`,
		].join("\n");
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, "task-4-failures.txt"),
			`${failuresEvidence}\n`,
			"utf8",
		);
	});
});
