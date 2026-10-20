import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, type TFile } from "obsidian";
import {
	createFile,
	parseFileContent,
	serializeFile,
	type PayloadV1,
} from "../src/crypto/payload";
import {
	getSharedLifecycleCoordinator,
	peekSharedLifecycleCoordinator,
	VIEW_LIFECYCLE_SYMBOL,
	ViewLifecycleCoordinator,
	type FrozenSafeSnapshot,
	type PrototypeWrapperHandlers,
} from "../src/view/lifecycle";
import {
	createDeferred,
	DEFAULT_DECOY,
	EDITED_DECOY,
	inspectSavedFile,
	makeMockFile,
	SECRET_P0,
	SECRET_P1,
	SECRET_REAL_TITLE,
	TEST_PASSWORD,
} from "./helpers/unloadHarness";

const EVIDENCE_DIR = path.resolve(process.cwd(), ".omo", "evidence", "issue-13");

function ensureEvidenceDir(): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

async function makeProtectedFixture(
	filePath = "Note.md",
	realText = SECRET_P0,
	decoyBody = DEFAULT_DECOY,
): Promise<{
	file: TFile;
	payload: PayloadV1;
	rawSerialized: string;
	snapshot: FrozenSafeSnapshot;
}> {
	const file = makeMockFile(filePath);
	const created = await createFile(
		realText,
		TEST_PASSWORD,
		decoyBody,
		undefined,
		undefined,
		SECRET_REAL_TITLE,
	);
	const snapshot: FrozenSafeSnapshot = {
		file,
		path: file.path,
		revision: 1,
		decoyBody,
		payload: created.payload,
		rawSerialized: created.fileContent,
	};
	return {
		file,
		payload: created.payload,
		rawSerialized: created.fileContent,
		snapshot,
	};
}

describe("ViewLifecycleCoordinator (Wave 2 Task 2)", () => {
	afterEach(() => {
		const holder = MarkdownView.prototype as unknown as Record<symbol, unknown>;
		delete holder[VIEW_LIFECYCLE_SYMBOL];
		vi.restoreAllMocks();
	});

	it("orders submitted A -> retirement B -> guarded native C -> owner2 D strictly and writes task-2-ordering.txt", async () => {
		// Given: an active owner1 with an already-submitted write A and an unstarted queued write
		const app = { id: "vault-ordering" };
		const coordinator = getSharedLifecycleCoordinator();
		expect(peekSharedLifecycleCoordinator()).toBe(coordinator);

		const fixtureP0 = await makeProtectedFixture("Ordered.md", SECRET_P0, DEFAULT_DECOY);
		const fixtureP1 = await makeProtectedFixture("Ordered.md", SECRET_P1, EDITED_DECOY);
		const file = fixtureP0.file;
		const snapshotB: FrozenSafeSnapshot = {
			...fixtureP1.snapshot,
			file,
			path: file.path,
			revision: 2,
		};

		const disk = new Map<string, string>([[file.path, fixtureP0.rawSerialized]]);
		const trace: string[] = [];

		const gateA = createDeferred<void>();
		const gateB = createDeferred<void>();
		const gateC = createDeferred<void>();

		const owner1 = coordinator.registerOwner(app, "owner-1");
		expect(coordinator.getOwnerPhase(owner1)).toBe("active");

		const promiseA = coordinator.enqueueFileWrite(app, {
			file,
			owner: owner1,
			kind: "normal",
			task: async () => {
				trace.push("A:start");
				await gateA.promise;
				disk.set(file.path, fixtureP0.rawSerialized);
				trace.push("A:commit");
			},
		});

		await Promise.resolve();
		expect(trace).toEqual(["A:start"]);

		let unstartedOwner1Invoked = false;
		const promiseUnstarted = coordinator.enqueueFileWrite(app, {
			file,
			owner: owner1,
			kind: "normal",
			task: async () => {
				unstartedOwner1Invoked = true;
				trace.push("UNSTARTED:should-not-run");
			},
		});

		// When: owner1 retires (queueing B), native save C arrives, and owner2 waits on predecessorReady for D
		const drainPromise = coordinator.beginRetirement(app, owner1, [
			{
				snapshot: snapshotB,
				persistTask: async (snap) => {
					trace.push("B:start");
					await gateB.promise;
					disk.set(snap.file.path, snap.rawSerialized);
					trace.push("B:commit");
				},
			},
		]);
		expect(coordinator.getOwnerPhase(owner1)).toBe("retiring");

		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file,
			data: "stale-editor-text",
		}) as MarkdownView;

		const promiseC = coordinator.executeGuardedNativeSave({
			app,
			view,
			clear: true,
			rawSave: async function (this: MarkdownView) {
				trace.push("C:start");
				await gateC.promise;
				disk.set(file.path, (this as unknown as { data: string }).data);
				trace.push("C:commit");
			},
		});

		const owner2 = coordinator.registerOwner(app, "owner-2");
		const promiseD = (async () => {
			trace.push("D:wait-predecessor");
			await coordinator.predecessorReady(app, file);
			trace.push("D:first-read");
			const observedOnRead = disk.get(file.path) ?? "";
			const parsedOnRead = parseFileContent(observedOnRead);
			expect(parsedOnRead).not.toBeNull();
			return coordinator.enqueueFileWrite(app, {
				file,
				owner: owner2,
				kind: "normal",
				task: async () => {
					trace.push("D:start");
					disk.set(file.path, serializeFile(EDITED_DECOY, fixtureP1.payload));
					trace.push("D:commit");
				},
			});
		})();

		await Promise.resolve();
		expect(trace).toEqual(["A:start", "D:wait-predecessor"]);

		// Then: releasing gates completes A, B, C, D in exact sequence with D reading only after B settles
		gateA.resolve();
		const resA = await promiseA;
		expect(resA.status).toBe("committed");
		const resUnstarted = await promiseUnstarted;
		expect(resUnstarted.status).toBe("declined");
		expect(unstartedOwner1Invoked).toBe(false);

		await Promise.resolve();
		expect(trace).toEqual(["A:start", "D:wait-predecessor", "A:commit", "B:start"]);

		gateB.resolve();
		await drainPromise;
		expect(coordinator.getOwnerPhase(owner1)).toBe("retired");

		gateC.resolve();
		const resC = await promiseC;
		expect(resC.status).toBe("committed");
		const resD = await promiseD;
		expect(resD.status).toBe("committed");

		const commitOrder = trace.filter((t) => t.endsWith(":commit"));
		expect(commitOrder).toEqual(["A:commit", "B:commit", "C:commit", "D:commit"]);
		const bCommitIdx = trace.indexOf("B:commit");
		const dReadIdx = trace.indexOf("D:first-read");
		expect(bCommitIdx).toBeGreaterThan(trace.indexOf("A:commit"));
		expect(dReadIdx).toBeGreaterThan(bCommitIdx);

		const finalInspected = await inspectSavedFile(disk.get(file.path) ?? "", TEST_PASSWORD);
		expect(finalInspected.isProtected).toBe(true);
		expect(finalInspected.decoyBody).toBe(EDITED_DECOY);
		expect(finalInspected.realText).toBe(SECRET_P1);

		const unrelatedFile = makeMockFile("Unrelated.md");
		const heldFile = makeMockFile("Held.md");
		const heldGate = createDeferred<void>();
		const concurrentTrace: string[] = [];

		const heldWrite = coordinator.enqueueFileWrite(app, {
			file: heldFile,
			owner: owner2,
			kind: "normal",
			task: async () => {
				concurrentTrace.push("held:start");
				await heldGate.promise;
				concurrentTrace.push("held:commit");
			},
		});
		const unrelatedWrite = coordinator.enqueueFileWrite(app, {
			file: unrelatedFile,
			owner: owner2,
			kind: "normal",
			task: async () => {
				concurrentTrace.push("unrelated:start");
				concurrentTrace.push("unrelated:commit");
			},
		});
		await unrelatedWrite;
		expect(concurrentTrace).toEqual(["held:start", "unrelated:start", "unrelated:commit"]);
		heldGate.resolve();
		await heldWrite;
		expect(concurrentTrace).toEqual([
			"held:start",
			"unrelated:start",
			"unrelated:commit",
			"held:commit",
		]);

		const verifyStrictOrder = (events: readonly string[]): boolean => {
			const idxA = events.indexOf("A:commit");
			const idxB = events.indexOf("B:commit");
			const idxC = events.indexOf("C:commit");
			const idxD = events.indexOf("D:commit");
			const idxRead = events.indexOf("D:first-read");
			return (
				idxA >= 0 &&
				idxB > idxA &&
				idxC > idxB &&
				idxD > idxC &&
				idxRead > idxB
			);
		};
		expect(verifyStrictOrder(trace)).toBe(true);
		expect(
			verifyStrictOrder(["B:commit", "A:commit", "D:first-read", "C:commit", "D:commit"]),
		).toBe(false);

		await coordinator.beginRetirement(app, owner2);
		coordinator.clearSettledVaultState(app);

		ensureEvidenceDir();
		const orderingReport = [
			"=== Wave 2 Task 2: Lifecycle Coordinator Write-Order Trace ===",
			`Ordered event sequence: ${JSON.stringify(trace)}`,
			`Commit order: ${JSON.stringify(commitOrder)}`,
			`Unstarted owner1 write invoked: ${String(unstartedOwner1Invoked)} (status=${resUnstarted.status})`,
			`B:commit index (${bCommitIdx}) < D:first-read index (${dReadIdx}): ${String(bCommitIdx < dReadIdx)}`,
			`Unrelated file concurrency trace: ${JSON.stringify(concurrentTrace)}`,
			`Final decrypted realText matches SECRET_P1: ${String(finalInspected.realText === SECRET_P1)}`,
			`Reversed-order negative control rejected: ${String(!verifyStrictOrder(["B:commit", "A:commit", "D:first-read", "C:commit", "D:commit"]))}`,
		].join("\n");
		fs.writeFileSync(path.join(EVIDENCE_DIR, "task-2-ordering.txt"), `${orderingReport}\n`, "utf8");
	});

	it("handles rejected writes, failed retirement barriers, destruction dominance, cross-vault isolation, rename/recreate, and prototype wrapper ownership; writes task-2-failures.txt", async () => {
		// Given: a shared coordinator exercised across failure, duress, multi-vault, rename, and wrapper scenarios
		const coordinator = getSharedLifecycleCoordinator();
		const failureLog: string[] = [];

		// When: active write A rejects and retirement commit B also fails
		const app1 = { id: "vault-fail-1" };
		const { file: file1, snapshot: snap1 } = await makeProtectedFixture("FailNote.md");
		const owner1 = coordinator.registerOwner(app1, "owner-fail-1");

		const gateA = createDeferred<void>();
		const promiseA = coordinator.enqueueFileWrite(app1, {
			file: file1,
			owner: owner1,
			kind: "normal",
			task: async () => {
				failureLog.push("S1:A:start");
				await gateA.promise;
				failureLog.push("S1:A:reject");
				throw new Error("Simulated disk I/O error on A");
			},
		});

		await Promise.resolve();
		const drain1 = coordinator.beginRetirement(app1, owner1, [
			{
				snapshot: snap1,
				persistTask: async () => {
					failureLog.push("S1:B:start-after-rejected-A");
					throw new Error("Simulated retirement persist failure on B");
				},
			},
		]);

		gateA.resolve();
		// Then: the queue advances past rejected A, and the failed barrier blocks automatic successor attachment until cleared
		await expect(promiseA).rejects.toThrow("Simulated disk I/O error on A");
		await expect(drain1).rejects.toThrow("Simulated retirement persist failure on B");
		expect(coordinator.getOwnerPhase(owner1)).toBe("retired");

		await expect(coordinator.predecessorReady(app1, file1)).rejects.toThrow(
			"Simulated retirement persist failure on B",
		);
		failureLog.push("S1:successor-blocked-on-failed-barrier");

		coordinator.clearBarrierFailure(app1, file1);
		await expect(coordinator.predecessorReady(app1, file1)).resolves.toBeUndefined();
		failureLog.push("S1:barrier-explicitly-cleared");

		// When: destruction begins while activeA is in flight and retirementB is queued
		const app2 = { id: "vault-destruction" };
		const { file: file2, snapshot: snap2 } = await makeProtectedFixture("DuressTarget.md");
		const owner2 = coordinator.registerOwner(app2, "owner-duress");
		const activeHold = createDeferred<void>();

		const activeWrite = coordinator.enqueueFileWrite(app2, {
			file: file2,
			owner: owner2,
			kind: "normal",
			task: async () => {
				failureLog.push("S2:activeA:start");
				await activeHold.promise;
				failureLog.push("S2:activeA:commit");
			},
		});

		await Promise.resolve();
		let queuedRetirementInvoked = false;
		const retireDrain2 = coordinator.beginRetirement(app2, owner2, [
			{
				snapshot: snap2,
				persistTask: async () => {
					queuedRetirementInvoked = true;
					failureLog.push("S2:retirementB:SHOULD_NOT_RUN");
				},
			},
		]);

		const destruction = coordinator.beginDestruction(app2, [{ file: file2, path: file2.path }]);
		failureLog.push(`S2:destruction-begun:gen=${destruction.generation}`);

		const dummyView = Object.assign(Object.create(MarkdownView.prototype), {
			file: file2,
			data: "cover",
		}) as MarkdownView;
		const guardedDuringDuress = await coordinator.executeGuardedNativeSave({
			app: app2,
			view: dummyView,
			clear: false,
			rawSave: async () => {
				failureLog.push("S2:nativeSave:SHOULD_NOT_RUN");
			},
		});
		expect(guardedDuringDuress.status).toBe("declined");

		// Then: destruction waits for activeA, declines retirementB, and executes terminal rewrite
		activeHold.resolve();
		await activeWrite;
		await destruction.waitActiveWrites();
		await retireDrain2;
		expect(queuedRetirementInvoked).toBe(false);

		const terminalRewrite = await coordinator.enqueueFileWrite(app2, {
			file: file2,
			owner: null,
			kind: "destruction",
			destructionGeneration: destruction.generation,
			task: async () => {
				failureLog.push("S2:destruction:terminal-rewrite");
			},
			dispositionOnCommit: {
				kind: "destroyed",
				revision: 99,
			},
		});
		expect(terminalRewrite.status).toBe("committed");
		destruction.releaseQuarantine(file2, file2.path);

		const stealthRes = await coordinator.runDestructionPathWrite(
			app2,
			"StealthNote.md",
			async () => {
				failureLog.push("S2:destruction:stealth-remove");
			},
			destruction.generation,
		);
		expect(stealthRes.status).toBe("committed");

		// When: two different vaults write to files with identical relative paths
		const vaultA = { id: "vault-A" };
		const vaultB = { id: "vault-B" };
		const sharedPathFileA = makeMockFile("Shared/Note.md");
		const sharedPathFileB = makeMockFile("Shared/Note.md");
		const ownerVaultA = coordinator.registerOwner(vaultA, "owner-vA");
		const ownerVaultB = coordinator.registerOwner(vaultB, "owner-vB");

		const gateVaultA = createDeferred<void>();
		const writeVaultA = coordinator.enqueueFileWrite(vaultA, {
			file: sharedPathFileA,
			owner: ownerVaultA,
			kind: "normal",
			task: async () => {
				failureLog.push("S3:vaultA:start");
				await gateVaultA.promise;
				failureLog.push("S3:vaultA:commit");
			},
		});
		await Promise.resolve();

		// Then: vaultB's write completes immediately without blocking on vaultA
		const writeVaultB = await coordinator.enqueueFileWrite(vaultB, {
			file: sharedPathFileB,
			owner: ownerVaultB,
			kind: "normal",
			task: async () => {
				failureLog.push("S3:vaultB:start-and-commit-while-vaultA-held");
			},
		});
		expect(writeVaultB.status).toBe("committed");
		gateVaultA.resolve();
		await writeVaultA;

		// When: a file is renamed in place while a write is held, and a new file is recreated at the old path
		const fileRename = makeMockFile("OriginalName.md");
		const gateRename = createDeferred<void>();
		const renameWrite1 = coordinator.enqueueFileWrite(vaultA, {
			file: fileRename,
			owner: ownerVaultA,
			kind: "normal",
			task: async () => {
				failureLog.push(`S4:renameWrite1:start:${fileRename.path}`);
				await gateRename.promise;
				failureLog.push(`S4:renameWrite1:commit:${fileRename.path}`);
			},
		});
		await Promise.resolve();

		(fileRename as unknown as { path: string }).path = "RenamedName.md";
		coordinator.notifyFileRenamed(vaultA, fileRename, "OriginalName.md", "RenamedName.md");

		const renameWrite2 = coordinator.enqueueFileWrite(vaultA, {
			file: fileRename,
			owner: ownerVaultA,
			kind: "normal",
			task: async () => {
				failureLog.push(`S4:renameWrite2:commit:${fileRename.path}`);
			},
		});

		const recreatedAtOldPath = makeMockFile("OriginalName.md");
		// Then: the recreated file at the old path does not collide with the renamed TFile's queue
		const recreatedWrite = await coordinator.enqueueFileWrite(vaultA, {
			file: recreatedAtOldPath,
			owner: ownerVaultA,
			kind: "normal",
			task: async () => {
				failureLog.push("S4:recreatedAtOldPath:commit-while-renamed-held");
			},
		});
		expect(recreatedWrite.status).toBe("committed");

		gateRename.resolve();
		await renameWrite1;
		await renameWrite2;

		// When: Owner1 and Owner2 acquire prototype leases and an outer wrapper wraps proto.save
		const proto = MarkdownView.prototype as unknown as {
			setViewData: (this: MarkdownView, data: string, clear: boolean) => void;
			getViewData: (this: MarkdownView) => string;
			save: (this: MarkdownView, clear?: boolean) => Promise<void>;
		};
		const baseCalls: string[] = [];
		const baseSet = function (this: MarkdownView, data: string, clear: boolean): void {
			baseCalls.push(`base:set:${data}:${String(clear)}`);
		};
		const baseGet = function (this: MarkdownView): string {
			baseCalls.push("base:get");
			return "base-data";
		};
		const baseSave = async function (this: MarkdownView): Promise<void> {
			baseCalls.push("base:save");
		};
		proto.setViewData = baseSet;
		proto.getViewData = baseGet;
		proto.save = baseSave;

		const owner1Handlers: PrototypeWrapperHandlers = {
			setViewData: function (data, clear) {
				baseCalls.push(`o1:set:${data}:${String(clear)}`);
			},
			getViewData: function () {
				baseCalls.push("o1:get");
				return "o1-data";
			},
			save: async function () {
				baseCalls.push("o1:save");
			},
		};
		const owner2Handlers: PrototypeWrapperHandlers = {
			setViewData: function (data, clear) {
				baseCalls.push(`o2:set:${data}:${String(clear)}`);
			},
			getViewData: function () {
				baseCalls.push("o2:get");
				return "o2-data";
			},
			save: async function () {
				baseCalls.push("o2:save");
			},
		};

		const lease1 = coordinator.acquirePrototypeLease(ownerVaultA, owner1Handlers, proto);
		const lease2 = coordinator.acquirePrototypeLease(ownerVaultB, owner2Handlers, proto);

		const testView = Object.create(MarkdownView.prototype) as MarkdownView;
		expect(proto.getViewData.call(testView)).toBe("o2-data");

		// Then: Owner1's delayed cleanup preserves Owner2, and outer wrappers are not overwritten on release
		lease1.releaseOwnerHandlers();
		expect(proto.getViewData.call(testView)).toBe("o2-data");
		failureLog.push("S5:owner1-delayed-cleanup-preserved-owner2");

		const innerSaveBeforeOuter = proto.save;
		const outerWrapperCalls: string[] = [];
		const outerSaveWrapper = async function (this: MarkdownView, clear?: boolean): Promise<void> {
			outerWrapperCalls.push("outer:save");
			await innerSaveBeforeOuter.call(this, clear);
		};
		proto.save = outerSaveWrapper;
		expect(lease2.isTopMostOnPrototype()).toBe(false);

		await coordinator.beginRetirement(vaultA, ownerVaultA);
		await coordinator.beginRetirement(vaultB, ownerVaultB);
		coordinator.clearSettledVaultState(app1);
		coordinator.clearSettledVaultState(app2);
		coordinator.clearSettledVaultState(vaultA);
		coordinator.clearSettledVaultState(vaultB);
		lease2.releaseOwnerHandlers();

		expect(proto.setViewData).toBe(baseSet);
		expect(proto.getViewData).toBe(baseGet);
		expect(proto.save).toBe(outerSaveWrapper);

		await proto.save.call(testView);
		expect(outerWrapperCalls).toEqual(["outer:save"]);
		expect(baseCalls).toContain("base:save");
		failureLog.push("S5:outer-wrapper-preserved-and-delegated-to-base");

		proto.save = innerSaveBeforeOuter;
		coordinator.tryRestorePrototypeAndSymbol();
		expect(proto.save).toBe(baseSave);
		expect(peekSharedLifecycleCoordinator(proto)).toBeNull();
		failureLog.push("S5:prototype-and-symbol-released-when-drained");

		ensureEvidenceDir();
		const failureReport = [
			"=== Wave 2 Task 2: Lifecycle Coordinator Failure & Edge-Case Trace ===",
			...failureLog.map((entry, idx) => `${idx + 1}. ${entry}`),
			`Queued retirement B invoked during destruction: ${String(queuedRetirementInvoked)}`,
			`Guarded native save during destruction status: ${guardedDuringDuress.status}`,
			`Outer wrapper calls after inner retirement: ${JSON.stringify(outerWrapperCalls)}`,
			`Symbol released after complete drain: ${String(peekSharedLifecycleCoordinator(proto) === null)}`,
		].join("\n");
		fs.writeFileSync(path.join(EVIDENCE_DIR, "task-2-failures.txt"), `${failureReport}\n`, "utf8");
	});

	it("reconciles already-submitted unprotect across retirement and guards synchronous setViewData during drain (Clauses 6 & 7)", async () => {
		// Given: an unsubmitted unprotect command and an already-submitted unprotect write in flight
		const app = { id: "vault-unprotect-boundary" };
		const coordinator = getSharedLifecycleCoordinator();
		const { file, snapshot } = await makeProtectedFixture("UnprotectRace.md");
		const owner = coordinator.registerOwner(app, "owner-unprotect");

		const unsubmittedCmdId = coordinator.beginCommand(app, owner, file, "unprotect");
		expect(unsubmittedCmdId).not.toBeNull();

		const submittedCmdId = coordinator.beginCommand(app, owner, file, "unprotect");
		expect(submittedCmdId).not.toBeNull();
		const unprotectGate = createDeferred<void>();

		const unprotectWrite = coordinator.enqueueFileWrite(app, {
			file,
			owner,
			kind: "normal",
			commandId: submittedCmdId!,
			task: async () => {
				await unprotectGate.promise;
			},
			dispositionOnCommit: {
				kind: "unprotected",
				revision: 10,
				plaintextContent: `${SECRET_P0}\n`,
			},
		});

		await Promise.resolve();
		expect(coordinator.getCommandRecord(app, file, submittedCmdId!)?.submitted).toBe(true);
		expect(coordinator.getCommandRecord(app, file, unsubmittedCmdId!)?.submitted).toBe(false);

		// When: retirement starts while unprotectWrite is in flight and synchronous setViewData is invoked
		let retirementOverwriteRan = false;
		const drain = coordinator.beginRetirement(app, owner, [
			{
				snapshot,
				persistTask: async () => {
					retirementOverwriteRan = true;
				},
			},
		]);

		expect(coordinator.getCommandRecord(app, file, unsubmittedCmdId!)).toBeNull();

		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file,
			data: "",
		}) as MarkdownView;
		const rendered: string[] = [];
		let afterBarrierCalled = false;

		const handledDuringDrain = coordinator.handleGuardedSetViewData({
			app,
			view,
			file,
			incomingData: "stale-disk-content",
			clear: true,
			rawSetViewData: function (data) {
				rendered.push(data);
			},
			onAfterBarrier: () => {
				afterBarrierCalled = true;
			},
		});
		expect(handledDuringDrain).toBe(true);
		expect(rendered).toEqual([snapshot.rawSerialized]);
		expect(afterBarrierCalled).toBe(false);

		// Then: when the submitted unprotect commits, the retirement rewrite is skipped and the disposition is unprotected
		unprotectGate.resolve();
		const unprotectResult = await unprotectWrite;
		expect(unprotectResult.status).toBe("committed");
		await drain;

		expect(retirementOverwriteRan).toBe(false);
		expect(coordinator.getCommittedDisposition(app, file)?.kind).toBe("unprotected");
		expect(afterBarrierCalled).toBe(true);

		const renderedAfterUnprotect: string[] = [];
		expect(
			coordinator.handleGuardedSetViewData({
				app,
				view,
				file,
				incomingData: "any",
				clear: true,
				rawSetViewData: function (data) {
					renderedAfterUnprotect.push(data);
				},
			}),
		).toBe(true);
		expect(renderedAfterUnprotect).toEqual([`${SECRET_P0}\n`]);

		coordinator.finishCommand(app, file, submittedCmdId!);
		coordinator.clearSettledVaultState(app);
	});

	it("enforces double retirement idempotence, save-blocked views, switched-view native save skipping, and stale revision rejection", async () => {
		// Given: a coordinator tracking revisions, save-blocked views, and queued native saves
		const app = { id: "vault-edge-guards" };
		const coordinator = new ViewLifecycleCoordinator();
		const { file: fileA, snapshot: snapA } = await makeProtectedFixture("FileA.md");
		const { file: fileB } = await makeProtectedFixture("FileB.md");
		const owner = coordinator.registerOwner(app, "owner-edge");

		// When: revisions are allocated and an older revision attempts to overwrite a newer committed revision
		const r1 = coordinator.nextFileRevision(app, fileA);
		const r2 = coordinator.nextFileRevision(app, fileA);
		expect(r2).toBeGreaterThan(r1);

		expect(
			coordinator.publishCommittedDisposition(app, fileA, {
				kind: "protected",
				revision: r2,
				decoyBody: DEFAULT_DECOY,
				payload: snapA.payload,
				rawSerialized: snapA.rawSerialized,
			}),
		).toBe(true);

		// Then: the stale revision is rejected, save-blocked views refuse native save, switched views skip side effects, and double retirement is idempotent
		expect(
			coordinator.publishCommittedDisposition(app, fileA, {
				kind: "protected",
				revision: r1,
				decoyBody: EDITED_DECOY,
				payload: snapA.payload,
				rawSerialized: snapA.rawSerialized,
			}),
		).toBe(false);
		expect(coordinator.getCommittedDisposition(app, fileA)?.revision).toBe(r2);

		const blockedView = Object.assign(Object.create(MarkdownView.prototype), {
			file: fileA,
			data: "unsafe-plaintext",
		}) as MarkdownView;

		coordinator.markViewSaveBlocked(app, blockedView);
		expect(coordinator.isViewSaveBlocked(app, blockedView)).toBe(true);
		await expect(
			coordinator.executeGuardedNativeSave({
				app,
				view: blockedView,
				clear: false,
				rawSave: async () => undefined,
			}),
		).rejects.toThrow("refusing native save on a view whose sanitization failed");

		coordinator.clearViewSaveBlocked(app, blockedView);
		expect(coordinator.isViewSaveBlocked(app, blockedView)).toBe(false);

		const gateHold = createDeferred<void>();
		const holdWrite = coordinator.enqueueFileWrite(app, {
			file: fileA,
			owner,
			kind: "normal",
			task: async () => {
				await gateHold.promise;
			},
		});
		await Promise.resolve();

		const switchingView = Object.assign(Object.create(MarkdownView.prototype), {
			file: fileA,
			data: "initial",
		}) as MarkdownView;
		let rawSaveCalledOnSwitchedView = false;
		const switchedSavePromise = coordinator.executeGuardedNativeSave({
			app,
			view: switchingView,
			clear: true,
			rawSave: async () => {
				rawSaveCalledOnSwitchedView = true;
			},
		});

		(switchingView as unknown as { file: TFile }).file = fileB;
		gateHold.resolve();
		await holdWrite;
		const switchedRes = await switchedSavePromise;
		expect(switchedRes.status).toBe("committed");
		expect(rawSaveCalledOnSwitchedView).toBe(false);

		let persistCount = 0;
		const drain1 = coordinator.beginRetirement(app, owner, [
			{
				snapshot: { ...snapA, revision: r2 + 1 },
				persistTask: async () => {
					persistCount += 1;
				},
			},
		]);
		const drain2 = coordinator.beginRetirement(app, owner, [
			{
				snapshot: { ...snapA, revision: r2 + 2 },
				persistTask: async () => {
					persistCount += 1;
				},
			},
		]);
		expect(drain2).toBe(drain1);
		await drain1;
		expect(persistCount).toBe(1);
		expect(coordinator.getOwnerPhase(owner)).toBe("retired");

		let retiredTaskRan = false;
		const retiredRes = await coordinator.enqueueFileWrite(app, {
			file: fileA,
			owner,
			kind: "normal",
			task: async () => {
				retiredTaskRan = true;
			},
		});
		expect(retiredRes.status).toBe("declined");
		expect(retiredTaskRan).toBe(false);
	});
});
