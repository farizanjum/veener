import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "obsidian";
import { createFile, parseFileContent } from "../src/crypto/payload";
import { VIEW_LIFECYCLE_SYMBOL } from "../src/view/lifecycle";
import { REENCRYPT_DEBOUNCE_MS } from "../src/view/session";
import {
	createDeferred,
	createViewUnloadHarness,
	DEFAULT_DECOY,
	EDITED_DECOY,
	makeMockFile,
	SECRET_P0,
	SECRET_P1,
	SECRET_REAL_TITLE,
	stubObjectUrls,
	TEST_PASSWORD,
	type ViewUnloadHarness,
} from "./helpers/unloadHarness";

const EVIDENCE_DIR = path.resolve(process.cwd(), ".omo", "evidence", "issue-13");

function ensureEvidenceDir(): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

function assertAllBytesZero(arr: Uint8Array | null | undefined, label: string): void {
	expect(arr, `${label} must be defined`).toBeDefined();
	expect(arr, `${label} must not be null`).not.toBeNull();
	if (!arr) return;
	expect(arr.byteLength, `${label} must be non-empty`).toBeGreaterThan(0);
	expect(
		Array.from(arr).every((byte) => byte === 0),
		`${label} must have every byte equal to 0`,
	).toBe(true);
}

describe("SessionManager terminal lifecycle, owned DEK retirement, and async fencing (Wave 2 Task 3)", () => {
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

	it("synchronously retires owned DEKs (session, lock local copy, command-registered), timers, capture buffers, and blob URLs, and writes task-3-resources.txt", async () => {
		const urlStub = stubObjectUrls();
		try {
			let managerWasDisposedDuringHook = false;
			let ownerPhaseDuringHook = "";
			const harness = createViewUnloadHarness({
				hooks: {
					onLocked: () => {
						if (activeHarness) {
							managerWasDisposedDuringHook = activeHarness.sessions.isDisposed();
							ownerPhaseDuringHook = activeHarness.sessions.getOwnerPhase();
						}
					},
				},
			});
			activeHarness = harness;

			// Seed a protected note that already contains an embedded image so unlock creates a blob: URL
			const imageBytes = new Uint8Array([137, 80, 78, 71, 10, 20, 30, 40]);
			const createdWithImg = await createFile(
				`${SECRET_P0}\n![[chart.png]]`,
				TEST_PASSWORD,
				DEFAULT_DECOY,
				undefined,
				{
					"chart.png": { mime: "image/png", data: imageBytes },
				},
				SECRET_REAL_TITLE,
			);
			const parsedWithImg = parseFileContent(createdWithImg.fileContent)!;
			const file1 = makeMockFile("ResourcesNote.md");
			harness.disk.set(file1.path, createdWithImg.fileContent);
			const pane1 = harness.createPane(file1, DEFAULT_DECOY);
			const session1 = harness.sessions.attachFromLoad(pane1.view, file1, parsedWithImg);

			expect(await harness.sessions.unlock(session1, TEST_PASSWORD)).toBe("ok");
			const session1DekRef = session1.dek;
			expect(session1DekRef).not.toBeNull();
			expect(session1DekRef?.some((b) => b !== 0)).toBe(true);
			expect(urlStub.created.length).toBeGreaterThan(0);
			expect(urlStub.active().length).toBeGreaterThan(0);

			// Start typing a capture trigger `;;ab` so the CaptureBuffer is mid-capture
			expect(session1.capture.feed(";", true).swallowInserted).toBe(false);
			expect(session1.capture.feed(";", false).swallowInserted).toBe(true);
			expect(session1.capture.feed("ab", false).swallowInserted).toBe(true);
			expect(session1.capture.isActive).toBe(true);
			expect(session1.capture.capturedLength).toBe(2);

			// Arm a pending debounce re-encryption timer on session1
			pane1.setEditorText(`${SECRET_P1}\n![[chart.png]]`);
			harness.sessions.scheduleReencrypt(session1);
			expect(session1.reencryptTimer).not.toBeNull();
			expect(vi.getTimerCount()).toBe(1);

			// Create a second unlocked session whose lock() is paused inside image staging,
			// so lock()'s local DEK copy is live in `ownedDeks` and `session2` is in `pendingLocks`
			const readBinaryGate = createDeferred<void>();
			const harnessWithHeldLock = harness.app.vault as unknown as {
				readBinary: () => Promise<ArrayBuffer>;
			};
			const origReadBinary = harnessWithHeldLock.readBinary;
			harnessWithHeldLock.readBinary = async () => {
				await readBinaryGate.promise;
				return imageBytes.buffer.slice(0);
			};

			const file2 = makeMockFile("PendingLockNote.md");
			const created2 = await createFile(SECRET_P0, TEST_PASSWORD, DEFAULT_DECOY);
			const parsed2 = parseFileContent(created2.fileContent)!;
			const pane2 = harness.createPane(file2, DEFAULT_DECOY);
			const session2 = harness.sessions.attachFromLoad(pane2.view, file2, parsed2);
			expect(await harness.sessions.unlock(session2, TEST_PASSWORD)).toBe("ok");
			const session2DekRef = session2.dek!;
			expect(session2DekRef.some((b) => b !== 0)).toBe(true);

			pane2.setEditorText(`${SECRET_P1}\n![[Pasted chart.png]]`);
			const lockPromise2 = harness.sessions.lock(session2, "held-lock");
			// Detach pane2 while lock is in-flight so session2 sits only in pendingLocks
			harness.sessions.detach(pane2.view);

			// Capture the tracked owned DEK arrays before retirement (includes session1.dek, session2.dek, and lock's local copy)
			const commandDek = new Uint8Array([99, 88, 77, 66, 55, 44, 33, 22]);
			const releaseCommandDek = harness.sessions.registerOwnedDek(commandDek);
			const trackedBefore = harness.sessions.getTrackedOwnedDeks();
			expect(trackedBefore.length).toBeGreaterThanOrEqual(4);
			for (const arr of trackedBefore) {
				expect(arr.some((b) => b !== 0)).toBe(true);
			}

			// Queue a deferred save behind a reservation to verify retirement clears deferred saves
			const releaseReservation = harness.sessions.reservePath(file1.path);
			let deferredSaveRan = false;
			harness.sessions.deferSave(file1.path, () => {
				deferredSaveRan = true;
			});

			// Record pre-wipe groups via `beforeWipe` hook for Task 4 compatibility
			let capturedGroupsCount = 0;
			let pendingPayloadObservedBeforeWipe = false;
			session1.pendingPayload = session1.originalPayload;

			// Act: synchronously prepare retirement (NO await)
			const prep = harness.sessions.prepareRetirement({
				beforeWipe: (groups) => {
					capturedGroupsCount = groups.size;
					const g1 = groups.get(file1);
					pendingPayloadObservedBeforeWipe =
						(g1?.sessions[0]?.pendingPayload ?? null) !== null;
				},
			});

			// Assert: synchronous retirement invariants hold IMMEDIATELY before any held promise resolves
			expect(harness.sessions.isDisposed()).toBe(true);
			expect(harness.sessions.getOwnerPhase()).toBe("retiring");
			expect(managerWasDisposedDuringHook).toBe(true);
			expect(ownerPhaseDuringHook).toBe("retiring");
			expect(capturedGroupsCount).toBe(2);
			expect(pendingPayloadObservedBeforeWipe).toBe(true);

			// Every tracked DEK byte array (session1, session2, lock's local copy, commandDek) is all zeros
			for (let i = 0; i < trackedBefore.length; i += 1) {
				assertAllBytesZero(trackedBefore[i], `trackedDek[${i}]`);
			}
			assertAllBytesZero(session1DekRef, "session1DekRef");
			assertAllBytesZero(session2DekRef, "session2DekRef");
			assertAllBytesZero(commandDek, "commandDek");
			expect(harness.sessions.getTrackedOwnedDeks()).toHaveLength(0);

			// Negative control for misleading_success_output: prove our byte-level zero check rejects a non-zeroed array
			const nonWipedNegativeControl = new Uint8Array([0, 0, 1, 0]);
			expect(Array.from(nonWipedNegativeControl).every((b) => b === 0)).toBe(false);

			// Timers, capture buffer, and blob URLs are all cleaned
			expect(vi.getTimerCount()).toBe(0);
			expect(session1.reencryptTimer).toBeNull();
			expect(session1.capture.isActive).toBe(false);
			expect(session1.capture.capturedLength).toBe(0);
			expect(session1.capture.currentSecret).toBe("");
			expect(urlStub.active()).toEqual([]);
			expect([...urlStub.revoked]).toEqual(urlStub.created);
			expect(session1.imageUrls.size).toBe(0);
			expect(session1.state).toBe("locked");
			expect(session2.state).toBe("locked");
			expect(session1.dek).toBeNull();
			expect(session2.dek).toBeNull();
			expect(session1.pendingPayload).toBeNull();
			expect(session1.realTitle).toBeNull();
			expect(harness.sessions.all()).toEqual([]);
			expect(harness.sessions.hasLiveSession(file1.path)).toBe(false);
			expect(harness.sessions.hasLiveSession(file2.path)).toBe(false);

			// Releasing the reservation after retirement never replays deferred saves
			releaseReservation();
			expect(deferredSaveRan).toBe(false);

			// Idempotent second call returns the same preparation without throwing
			const prepSecond = harness.sessions.prepareRetirement();
			expect(prepSecond).toBe(prep);

			// Release the held lock and clean up
			releaseCommandDek();
			readBinaryGate.resolve();
			await lockPromise2;
			harnessWithHeldLock.readBinary = origReadBinary;

			ensureEvidenceDir();
			const resourceDump = [
				"=== Wave 2 Task 3: Synchronous Retirement Resource State Dump ===",
				`Manager isDisposed() immediately after prepareRetirement: ${String(harness.sessions.isDisposed())}`,
				`Owner phase during onLocked hook (marked terminal BEFORE external hooks): ${ownerPhaseDuringHook}`,
				`Captured file groups in beforeWipe: ${capturedGroupsCount} (pendingPayload intact before wipe: ${String(pendingPayloadObservedBeforeWipe)})`,
				`Tracked DEK arrays count before retirement: ${trackedBefore.length}`,
				`session1 DEK bytes after retirement: [${Array.from(session1DekRef ?? []).join(", ")}]`,
				`session2 DEK bytes after retirement: [${Array.from(session2DekRef).join(", ")}]`,
				`lock() local DEK copy bytes after retirement: [${Array.from(trackedBefore[2] ?? []).join(", ")}]`,
				`command-registered DEK bytes after retirement: [${Array.from(commandDek).join(", ")}]`,
				`All tracked DEK bytes === 0: ${String(trackedBefore.every((arr) => Array.from(arr).every((b) => b === 0)))}`,
				`Negative control (non-wiped array [0,0,1,0] rejected by byte check): ${String(!Array.from(nonWipedNegativeControl).every((b) => b === 0))}`,
				`Created blob URLs: ${JSON.stringify(urlStub.created)}`,
				`URL.revokeObjectURL call list: ${JSON.stringify([...urlStub.revoked])}`,
				`Active unrevoked blob URLs after retirement: ${JSON.stringify(urlStub.active())}`,
				`Pending fake timer count after retirement: ${vi.getTimerCount()}`,
				`CaptureBuffer state after retirement: isActive=${String(session1.capture.isActive)}, capturedLength=${session1.capture.capturedLength}, currentSecret="${session1.capture.currentSecret}"`,
				`Post-retirement session1.state: "${session1.state}", session2.state: "${session2.state}"`,
				`Deferred save replayed after retirement: ${String(deferredSaveRan)}`,
				`Repeated prepareRetirement() idempotent: ${String(prepSecond === prep)}`,
			].join("\n");
			fs.writeFileSync(
				path.join(EVIDENCE_DIR, "task-3-resources.txt"),
				`${resourceDump}\n`,
				"utf8",
			);
		} finally {
			urlStub.restore();
		}
	});

	it("isolates per-URL and per-hook exceptions during prepareRetirement so all remaining keys, timers, and URLs are still cleaned", async () => {
		let revokeCallCount = 0;
		const urlStub = stubObjectUrls((url) => {
			revokeCallCount += 1;
			if (revokeCallCount === 1) {
				return new Error(`Revoke failed for ${url}`);
			}
			return null;
		});

		try {
			let hookCallCount = 0;
			const harness = createViewUnloadHarness({
				hooks: {
					onLocked: () => {
						hookCallCount += 1;
						if (hookCallCount === 1) {
							throw new Error("Simulated onLocked hook failure");
						}
					},
				},
			});
			activeHarness = harness;

			const imgBytes1 = new Uint8Array([1, 2, 3, 4]);
			const imgBytes2 = new Uint8Array([5, 6, 7, 8]);
			const created1 = await createFile(SECRET_P0, TEST_PASSWORD, DEFAULT_DECOY, undefined, {
				"one.png": { mime: "image/png", data: imgBytes1 },
			});
			const created2 = await createFile(SECRET_P1, TEST_PASSWORD, EDITED_DECOY, undefined, {
				"two.png": { mime: "image/png", data: imgBytes2 },
			});

			const file1 = makeMockFile("Iso1.md");
			const file2 = makeMockFile("Iso2.md");
			const pane1 = harness.createPane(file1, DEFAULT_DECOY);
			const pane2 = harness.createPane(file2, EDITED_DECOY);

			const s1 = harness.sessions.attachFromLoad(
				pane1.view,
				file1,
				parseFileContent(created1.fileContent)!,
			);
			const s2 = harness.sessions.attachFromLoad(
				pane2.view,
				file2,
				parseFileContent(created2.fileContent)!,
			);

			expect(await harness.sessions.unlock(s1, TEST_PASSWORD)).toBe("ok");
			expect(await harness.sessions.unlock(s2, TEST_PASSWORD)).toBe("ok");

			const dek1 = s1.dek!;
			const dek2 = s2.dek!;
			harness.sessions.scheduleReencrypt(s1);
			harness.sessions.scheduleReencrypt(s2);
			expect(vi.getTimerCount()).toBe(2);

			// When: prepareRetirement runs across the throwing URL revoker and throwing onLocked hook
			const prep = harness.sessions.prepareRetirement();

			// Then: both DEKs are zeroed, both timers cleared, both URLs attempted, and both errors recorded without aborting
			assertAllBytesZero(dek1, "dek1");
			assertAllBytesZero(dek2, "dek2");
			expect(vi.getTimerCount()).toBe(0);
			expect(urlStub.active()).toEqual([]);
			expect(hookCallCount).toBe(2);
			expect(prep.errors.length).toBe(2);
			expect(s1.state).toBe("locked");
			expect(s2.state).toBe("locked");
		} finally {
			urlStub.restore();
		}
	});

	it("fences in-flight KDF, staged-image read, encryption, title microtask, and post-retirement entry points; writes task-3-late-work.txt", async () => {
		const urlStub = stubObjectUrls();
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			unhandledRejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
		const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);

		try {
			const readBinaryGate = createDeferred<void>();
			const harness = createViewUnloadHarness({
				readBinaryGate: readBinaryGate.promise,
			});
			activeHarness = harness;

			// Seed 4 notes for concurrent in-flight operations:
			// 1. LateKdf.md: KDF/unwrap resolves AFTER retirement (captures returned DEK byte array)
			// 2. LateKdfReject.md: KDF/unwrap rejects AFTER retirement
			// 3. LateImageStage.md: staged-image readBinary held in flight across retirement
			// 4. LateEncrypt.md: AES-GCM encryption held in flight across retirement
			const { file: fileKdf, pane: paneKdf, session: sessionKdf } =
				await harness.seedProtectedNote({
					path: "LateKdf.md",
					realText: SECRET_P0,
				});
			const { pane: paneRejectKdf, session: sessionRejectKdf } =
				await harness.seedProtectedNote({
					path: "LateKdfReject.md",
					realText: SECRET_P0,
				});
			const { file: fileStage, pane: paneStage, session: sessionStage } =
				await harness.seedProtectedNote({
					path: "LateImageStage.md",
					realText: SECRET_P0,
				});
			const { file: fileEncrypt, pane: paneEncrypt, session: sessionEncrypt } =
				await harness.seedProtectedNote({
					path: "LateEncrypt.md",
					realText: SECRET_P0,
				});

			// Unlock sessionStage and sessionEncrypt while the manager is still active
			expect(await harness.sessions.unlock(sessionStage, TEST_PASSWORD)).toBe("ok");
			expect(await harness.sessions.unlock(sessionEncrypt, TEST_PASSWORD)).toBe("ok");
			await Promise.resolve(); // flush initial unlock title microtasks

			// Reset title DOM to cover basename before retirement to verify no late microtask or callback re-applies realTitle
			paneStage.inlineTitleEl.textContent = fileStage.basename;
			paneEncrypt.inlineTitleEl.textContent = fileEncrypt.basename;
			paneKdf.inlineTitleEl.textContent = fileKdf.basename;

			// Intercept crypto.subtle.decrypt to hold the KDF/unwrap continuation and capture the exact ArrayBuffer
			// that `unwrapDek` wraps into `dek: Uint8Array<ArrayBuffer>` (32-byte DEK unwrap).
			const kdfResolveGate = createDeferred<void>();
			const kdfRejectGate = createDeferred<void>();
			const kdfEntered = createDeferred<void>();
			let lateDerivedDekBuffer: ArrayBuffer | null = null;
			let interceptDecryptMode: "off" | "hold-kdf" = "hold-kdf";
			let decryptCallIndex = 0;

			vi.spyOn(crypto.subtle, "decrypt").mockImplementation(
				async (algorithm, key, data): Promise<ArrayBuffer> => {
					if (interceptDecryptMode === "hold-kdf") {
						decryptCallIndex += 1;
						// Call 1 is unwrapDek (32-byte DEK) for sessionKdf
						if (decryptCallIndex === 1) {
							const buf = await originalDecrypt(algorithm, key, data);
							lateDerivedDekBuffer = buf;
							kdfEntered.resolve();
							await kdfResolveGate.promise;
							return buf;
						}
						// Call 2 is unwrapDek for sessionRejectKdf (wrong password)
						if (decryptCallIndex === 2) {
							await kdfRejectGate.promise;
							return originalDecrypt(algorithm, key, data);
						}
					}
					return originalDecrypt(algorithm, key, data);
				},
			);

			const inFlightUnlockResolve = harness.sessions.unlock(sessionKdf, TEST_PASSWORD);
			const inFlightUnlockReject = harness.sessions.unlock(sessionRejectKdf, "wrong-pass");

			// Wait until sessionKdf's Argon2id + unwrapDek has produced the raw 32-byte DEK buffer
			await kdfEntered.promise;
			expect(lateDerivedDekBuffer).not.toBeNull();
			const capturedLateDek = new Uint8Array(lateDerivedDekBuffer!);
			expect(capturedLateDek.byteLength).toBe(32);
			expect(capturedLateDek.some((b) => b !== 0)).toBe(true);

			// Start an in-flight staged-image read on sessionStage via scheduleReencrypt
			paneStage.setEditorText(`${SECRET_P1}\n![[Pasted chart.png]]`);
			harness.sessions.scheduleReencrypt(sessionStage);
			await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
			expect(sessionStage.reencryptPromise).not.toBeNull();

			// Hold `crypto.subtle.encrypt` for sessionEncrypt's reencryptRealText call
			const encryptResolveGate = createDeferred<void>();
			const encryptEntered = createDeferred<void>();
			let holdEncrypt = true;
			vi.spyOn(crypto.subtle, "encrypt").mockImplementation(
				async (algorithm, key, data): Promise<ArrayBuffer> => {
					if (holdEncrypt) {
						holdEncrypt = false;
						encryptEntered.resolve();
						await encryptResolveGate.promise;
					}
					return originalEncrypt(algorithm, key, data);
				},
			);

			paneEncrypt.setEditorText(SECRET_P1);
			harness.sessions.scheduleReencrypt(sessionEncrypt);
			await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
			await encryptEntered.promise;
			expect(sessionEncrypt.reencryptPromise).not.toBeNull();

			// Record baseline counts right before retirement
			const writesBeforeRetire = harness.writes.length;
			const createdUrlsBeforeRetire = urlStub.created.length;
			const requestSaveStageBefore = paneStage.getRequestSaveCount();
			const requestSaveEncryptBefore = paneEncrypt.getRequestSaveCount();
			paneStage.setEditorText(DEFAULT_DECOY);
			paneEncrypt.setEditorText(DEFAULT_DECOY);

			// Act: retire synchronously while KDF, image read, and encryption are all suspended in flight
			harness.sessions.prepareRetirement();
			interceptDecryptMode = "off";

			// Now release all held promises after retirement
			kdfResolveGate.resolve();
			kdfRejectGate.resolve();
			readBinaryGate.resolve();
			encryptResolveGate.resolve();

			const [unlockResolveOutcome, unlockRejectOutcome] = await Promise.all([
				inFlightUnlockResolve,
				inFlightUnlockReject,
			]);
			if (sessionStage.reencryptPromise) await sessionStage.reencryptPromise;
			if (sessionEncrypt.reencryptPromise) await sessionEncrypt.reencryptPromise;
			await Promise.resolve();
			await Promise.resolve();

			// Assert: late KDF continuation wiped its derived DEK and returned "blocked"
			expect(unlockResolveOutcome).toBe("blocked");
			expect(unlockRejectOutcome).toBe("blocked");
			assertAllBytesZero(capturedLateDek, "capturedLateDek");

			// Assert: zero state mutations after retirement
			expect(paneKdf.getEditorText()).toBe(DEFAULT_DECOY);
			expect(paneRejectKdf.getEditorText()).toBe(DEFAULT_DECOY);
			expect(paneStage.getEditorText()).toBe(DEFAULT_DECOY);
			expect(paneEncrypt.getEditorText()).toBe(DEFAULT_DECOY);

			expect(paneKdf.getDisplayedTitles().inline).toBe(fileKdf.basename);
			expect(paneStage.getDisplayedTitles().inline).toBe(fileStage.basename);
			expect(paneEncrypt.getDisplayedTitles().inline).toBe(fileEncrypt.basename);

			expect(urlStub.created.length).toBe(createdUrlsBeforeRetire);
			expect(paneStage.getRequestSaveCount()).toBe(requestSaveStageBefore);
			expect(paneEncrypt.getRequestSaveCount()).toBe(requestSaveEncryptBefore);
			expect(harness.writes.length).toBe(writesBeforeRetire);
			expect(harness.deletedImages).toEqual([]);
			expect(sessionKdf.state).toBe("locked");
			expect(sessionStage.state).toBe("locked");
			expect(sessionEncrypt.state).toBe("locked");
			expect(sessionStage.pendingPayload).toBeNull();
			expect(sessionEncrypt.pendingPayload).toBeNull();

			// Also verify post-retirement entry guards on every public SessionManager method
			const postRetireAttach = harness.sessions.attachFromLoad(
				paneKdf.view,
				fileKdf,
				parseFileContent(harness.disk.get(fileKdf.path)!)!,
			);
			expect(harness.sessions.get(paneKdf.view)).toBeNull();
			expect(await harness.sessions.unlock(sessionKdf, TEST_PASSWORD)).toBe("blocked");
			await harness.sessions.lock(sessionKdf, "post-retire");
			harness.sessions.scheduleReencrypt(sessionKdf);
			expect(vi.getTimerCount()).toBe(0);
			await harness.sessions.absorbNewEditorImages(sessionStage);
			await harness.sessions.commitPersistedPayload(sessionStage, sessionStage.originalPayload);
			let reservedWriteRan = false;
			const reservedRes = await harness.sessions.runReservedWrite(
				harness.sessions.currentKillEpoch(),
				async () => {
					reservedWriteRan = true;
				},
			);
			expect(reservedRes).toBe(false);
			expect(reservedWriteRan).toBe(false);
			expect(postRetireAttach.state).toBe("locked");
			expect(unhandledRejections).toEqual([]);

			ensureEvidenceDir();
			const lateWorkDump = [
				"=== Wave 2 Task 3: Post-Retirement Late-Work Fencing Trace ===",
				`Late resolving KDF outcome: "${unlockResolveOutcome}" (expected "blocked")`,
				`Late rejecting KDF outcome: "${unlockRejectOutcome}" (expected "blocked")`,
				`Late derived KDF key bytes after continuation: [${Array.from(capturedLateDek).join(", ")}]`,
				`Late derived KDF key all zero: ${String(Array.from(capturedLateDek).every((b) => b === 0))}`,
				`Editor content writes after retirement: ${String(paneKdf.getEditorText() !== DEFAULT_DECOY || paneStage.getEditorText() !== DEFAULT_DECOY || paneEncrypt.getEditorText() !== DEFAULT_DECOY)}`,
				`Real title applied after retirement: ${String(paneKdf.getDisplayedTitles().inline !== fileKdf.basename || paneStage.getDisplayedTitles().inline !== fileStage.basename || paneEncrypt.getDisplayedTitles().inline !== fileEncrypt.basename)}`,
				`New preview blob URLs created after retirement: ${urlStub.created.length - createdUrlsBeforeRetire}`,
				`requestSave() calls after retirement: ${(paneStage.getRequestSaveCount() - requestSaveStageBefore) + (paneEncrypt.getRequestSaveCount() - requestSaveEncryptBefore)}`,
				`Disk writes (vault.modify / save) after retirement: ${harness.writes.length - writesBeforeRetire}`,
				`Staged source images deleted after retirement: ${JSON.stringify(harness.deletedImages)}`,
				`Post-retirement runReservedWrite result: ${String(reservedRes)} (invoked=${String(reservedWriteRan)})`,
				`Unhandled rejections observed: ${unhandledRejections.length}`,
			].join("\n");
			fs.writeFileSync(
				path.join(EVIDENCE_DIR, "task-3-late-work.txt"),
				`${lateWorkDump}\n`,
				"utf8",
			);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			urlStub.restore();
		}
	});

	it("ensures a losing concurrent unlock wipes only its own derived DEK and never the winner's live DEK, and fences queued enqueueWrite / enqueueCoordinatedWrite tasks on retirement", async () => {
		const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
		const harness = createViewUnloadHarness();
		activeHarness = harness;

		const { file, session } = await harness.seedProtectedNote({
			path: "ConcurrentUnlock.md",
			realText: SECRET_P0,
		});

		const loserGate = createDeferred<void>();
		const loserEntered = createDeferred<void>();
		let decryptCalls = 0;
		let winnerDekBuffer: ArrayBuffer | null = null;
		let loserDekBuffer: ArrayBuffer | null = null;

		const decryptSpy = vi
			.spyOn(crypto.subtle, "decrypt")
			.mockImplementation(async (algorithm, key, data): Promise<ArrayBuffer> => {
				decryptCalls += 1;
				const callNum = decryptCalls;
				const buf = await originalDecrypt(algorithm, key, data);
				if (callNum === 1) {
					winnerDekBuffer = buf;
					return buf;
				}
				if (callNum === 4) {
					loserDekBuffer = buf;
					loserEntered.resolve();
					await loserGate.promise;
					return buf;
				}
				return buf;
			});

		try {
			const winnerPromise = harness.sessions.unlock(session, TEST_PASSWORD);
			expect(await winnerPromise).toBe("ok");
			expect(winnerDekBuffer).not.toBeNull();
			const winnerDek = session.dek!;
			expect(winnerDek).not.toBeNull();
			expect(winnerDek.buffer).toBe(winnerDekBuffer);
			expect(winnerDek.some((b) => b !== 0)).toBe(true);

			session.state = "locked";
			const loserPromise = harness.sessions.unlock(session, TEST_PASSWORD);
			await loserEntered.promise;
			session.state = "unlocked";
			session.dek = winnerDek;

			loserGate.resolve();
			expect(await loserPromise).toBe("ok");

			expect(loserDekBuffer).not.toBeNull();
			const loserDek = new Uint8Array(loserDekBuffer!);
			assertAllBytesZero(loserDek, "loserDek");
			expect(winnerDek.some((b) => b !== 0)).toBe(true);
			expect(session.dek).toBe(winnerDek);
			expect(harness.sessions.getTrackedOwnedDeks()).toContain(winnerDek);
		} finally {
			decryptSpy.mockRestore();
		}

		const gateFirstWrite = createDeferred<void>();
		const firstWriteEntered = createDeferred<void>();
		let secondQueuedWriteRan = false;
		let secondCoordinatedWriteRan = false;

		const p1 = harness.sessions.enqueueWrite(session, async () => {
			firstWriteEntered.resolve();
			await gateFirstWrite.promise;
		});
		await firstWriteEntered.promise;

		const p2 = harness.sessions.enqueueWrite(session, async () => {
			secondQueuedWriteRan = true;
		});

		const coordHoldGate = createDeferred<void>();
		const coordHoldEntered = createDeferred<void>();
		const c1 = harness.sessions.enqueueCoordinatedWrite(
			file,
			async () => {
				coordHoldEntered.resolve();
				await coordHoldGate.promise;
			},
			{ session },
		);
		await coordHoldEntered.promise;

		const c2 = harness.sessions.enqueueCoordinatedWrite(
			file,
			async () => {
				secondCoordinatedWriteRan = true;
			},
			{ session },
		);

		harness.sessions.prepareRetirement();

		gateFirstWrite.resolve();
		coordHoldGate.resolve();
		await Promise.all([p1, p2]);
		const [resC1, resC2] = await Promise.all([c1, c2]);

		expect(secondQueuedWriteRan).toBe(false);
		expect(resC1.status).toBe("committed");
		expect(resC2.status).toBe("declined");
		expect(secondCoordinatedWriteRan).toBe(false);
	});
});
