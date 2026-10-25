import crypto from "crypto";
import fs from "fs";
import Module from "module";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class HostClass {
		open(): void {}
		close(): void {}
	}
	class FileSystemAdapter {
		getBasePath(): string {
			return "";
		}
	}
	return {
		Plugin: HostClass,
		Modal: HostClass,
		MarkdownView: HostClass,
		PluginSettingTab: HostClass,
		Setting: HostClass,
		TFile: HostClass,
		Notice: HostClass,
		FileSystemAdapter,
		addIcon: () => undefined,
		normalizePath: (p: string) =>
			String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
	};
});

import { MarkdownView, type TFile } from "obsidian";
import {
	createFile,
	parseFileContent,
	serializeFile,
	unlockPayload,
	type PayloadV1,
} from "../src/crypto/payload";
import { ProtectWizard } from "../src/decoy/wizard";
import VeneerPlugin from "../src/main";
import { PasswordModal } from "../src/ui/modals";
import {
	getSharedLifecycleCoordinator,
	peekSharedLifecycleCoordinator,
	VIEW_LIFECYCLE_SYMBOL,
} from "../src/view/lifecycle";
import { installViewPatches } from "../src/view/patch";
import {
	REENCRYPT_DEBOUNCE_MS,
	SessionManager,
	type ViewSession,
} from "../src/view/session";
import {
	createDeferred,
	createPluginUnloadHarness,
	DEFAULT_DECOY,
	EDITED_DECOY,
	makeMockFile,
	NEXT_TEST_PASSWORD,
	TEST_PASSWORD,
	type NativeSaveMode,
	type PluginUnloadHarness,
	type PluginUnloadHarnessOptions,
	type UnloadCallbackOrder,
} from "./helpers/unloadHarness";

const SENTINEL_REAL_TEXT = "ZEBRAFISH-QX-4471-UNIQUE-REAL-TEXT";
const SENTINEL_REAL_TEXT_P0 = `${SENTINEL_REAL_TEXT}-P0`;
const SENTINEL_REAL_TEXT_P1 = `${SENTINEL_REAL_TEXT}-P1-COMPLETED`;
const SENTINEL_REAL_TEXT_P2_TAIL = `${SENTINEL_REAL_TEXT}-P2-UNENCRYPTED-TAIL`;
const SENTINEL_REAL_TITLE = "ZEBRAFISH-SECRET-TITLE-9931";
const ORDINARY_NOTE_CONTENT = "# Ordinary Project Notes\n\n- Review Q4 budget\n- Update roadmap\n";

const EVIDENCE_DIR = path.resolve(process.cwd(), ".omo", "evidence", "issue-13");

interface FileBackedVerificationRecord {
	readonly scenario: string;
	readonly filePath: string;
	readonly sha256: string;
	readonly byteLength: number;
	readonly containsPlaintextSentinel: boolean;
	readonly containsTitleSentinel: boolean;
	readonly containsUnencryptedTail: boolean;
	readonly parsedAsProtected: boolean;
	readonly decryptedMatchesExpectedSnapshot: boolean;
	readonly decryptedTitleMatchesExpected: boolean;
	readonly decoyMatchesExpected: boolean;
	readonly ordinaryNoteByteIdentical?: boolean;
	readonly storageSentinelsSurvived?: boolean;
	readonly lifecycleOrder?: readonly string[];
}

interface FailureInjectionRecord {
	readonly scenario: string;
	readonly injectedFailure: string;
	readonly filePath: string;
	readonly sha256BeforeFailure: string;
	readonly sha256AfterFailure: string;
	readonly lastGoodFilePreserved: boolean;
	readonly parsedAsProtected: boolean;
	readonly decryptedMatchesLastGood: boolean;
	readonly falseSuccessReported: boolean;
	readonly containsPlaintextSentinel: boolean;
}

const fileBackedOutcomes: FileBackedVerificationRecord[] = [];
const failureOutcomes: FailureInjectionRecord[] = [];

/** Computes the hex-encoded SHA-256 digest of `content`. */
function sha256Hex(content: string | Buffer): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

/** Checks whether `raw` contains any plaintext body, real title, or dirty tail sentinel strings. */
function containsAnySentinel(raw: string): {
	readonly hasPlaintext: boolean;
	readonly hasTitle: boolean;
	readonly hasTail: boolean;
} {
	return {
		hasPlaintext:
			raw.includes(SENTINEL_REAL_TEXT) ||
			raw.includes(SENTINEL_REAL_TEXT_P0) ||
			raw.includes(SENTINEL_REAL_TEXT_P1),
		hasTitle: raw.includes(SENTINEL_REAL_TITLE),
		hasTail: raw.includes(SENTINEL_REAL_TEXT_P2_TAIL),
	};
}

interface FileBackedHarness {
	readonly tempDir: string;
	readonly harness: PluginUnloadHarness;
	readonly resolveDiskPath: (vaultRelPath: string) => string;
	readonly readRealDiskFile: (vaultRelPath: string) => string;
	readonly writeRealDiskFile: (vaultRelPath: string, content: string) => void;
	readonly existsOnRealDisk: (vaultRelPath: string) => boolean;
	readonly seedRealProtectedNote: (options?: {
		readonly path?: string;
		readonly decoyBody?: string;
		readonly realText?: string;
		readonly password?: string;
		readonly realTitle?: string;
		readonly saveMode?: NativeSaveMode;
	}) => Promise<{
		readonly file: TFile;
		readonly pane: ReturnType<PluginUnloadHarness["createPane"]>;
		readonly session: ViewSession;
		readonly initialContent: string;
		readonly initialPayload: PayloadV1;
	}>;
	readonly cleanup: () => void;
}

/** Creates a `PluginUnloadHarness` backed by real files inside `tempDir` on the OS filesystem. */
function createFileBackedPluginHarness(
	tempDir: string,
	options?: PluginUnloadHarnessOptions,
): FileBackedHarness {
	const resolveDiskPath = (vaultRelPath: string): string => {
		const normalized = vaultRelPath.replace(/^[/\\]+/, "");
		const fullPath = path.resolve(tempDir, normalized);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		return fullPath;
	};

	const readRealDiskFile = (vaultRelPath: string): string => {
		const fullPath = resolveDiskPath(vaultRelPath);
		return fs.readFileSync(fullPath, "utf8");
	};

	const writeRealDiskFile = (vaultRelPath: string, content: string): void => {
		const fullPath = resolveDiskPath(vaultRelPath);
		fs.writeFileSync(fullPath, content, "utf8");
	};

	const existsOnRealDisk = (vaultRelPath: string): boolean => {
		const fullPath = resolveDiskPath(vaultRelPath);
		return fs.existsSync(fullPath);
	};

	let modifySeq = 0;

	const harness = createPluginUnloadHarness(VeneerPlugin, {
		...options,
		onNativeSaveStart: (info) => {
			options?.onNativeSaveStart?.(info);
		},
	});

	// Wire vault and rawNativeSave to read and write REAL files in `tempDir`
	const origVault = harness.app.vault as unknown as {
		read: (file: { readonly path: string }) => Promise<string>;
		cachedRead: (file: { readonly path: string }) => Promise<string>;
		readBinary: (file: { readonly path: string }) => Promise<ArrayBuffer>;
		modify: (file: { readonly path: string }, content: string) => Promise<void>;
		delete: (file: { readonly path: string }) => Promise<void>;
		adapter: { remove: (targetPath: string) => Promise<void> };
	};

	origVault.read = async (file: { readonly path: string }): Promise<string> => {
		if (existsOnRealDisk(file.path)) {
			const content = readRealDiskFile(file.path);
			harness.disk.set(file.path, content);
			return content;
		}
		return harness.disk.get(file.path) ?? "";
	};

	origVault.cachedRead = async (file: { readonly path: string }): Promise<string> => {
		return origVault.read(file);
	};

	origVault.readBinary = async (file: { readonly path: string }): Promise<ArrayBuffer> => {
		if (options?.readBinaryGate) {
			await options.readBinaryGate;
		}
		if (existsOnRealDisk(file.path)) {
			const buf = fs.readFileSync(resolveDiskPath(file.path));
			const copy = new Uint8Array(buf.byteLength);
			copy.set(buf);
			return copy.buffer;
		}
		const fallback = options?.rawImageBytes ?? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const fallbackCopy = new Uint8Array(fallback.byteLength);
		fallbackCopy.set(fallback);
		return fallbackCopy.buffer;
	};

	origVault.delete = async (file: { readonly path: string }): Promise<void> => {
		harness.deletedImages.push(file.path);
		harness.disk.delete(file.path);
		if (existsOnRealDisk(file.path)) {
			fs.unlinkSync(resolveDiskPath(file.path));
		}
	};

	origVault.adapter.remove = async (targetPath: string): Promise<void> => {
		harness.disk.delete(targetPath);
		if (existsOnRealDisk(targetPath)) {
			fs.unlinkSync(resolveDiskPath(targetPath));
		}
	};

	origVault.modify = async (file: { readonly path: string }, content: string): Promise<void> => {
		const seq = ++modifySeq;
		harness.writeTrace.push(`vault.modify:start:${file.path}`);
		options?.onModifyStart?.(file.path, content, seq);
		const gate = options?.modifyGateForPath?.(file.path, seq) ?? null;
		if (gate !== null) {
			await gate;
		}
		const failure = options?.shouldFailModify?.(file.path, seq) ?? null;
		if (failure !== null) {
			harness.writeTrace.push(`vault.modify:error:${file.path}`);
			throw failure;
		}
		writeRealDiskFile(file.path, content);
		harness.disk.set(file.path, content);
		harness.writes.push({
			seq,
			source: "vault.modify",
			path: file.path,
			content,
			clear: undefined,
			mode: undefined,
		});
		harness.writeTrace.push(`vault.modify:commit:${file.path}`);
	};

	const origFileManager = harness.app.fileManager as unknown as {
		renameFile: (file: TFile, newPath: string) => Promise<void>;
	};
	const baseRename = origFileManager.renameFile.bind(origFileManager);
	origFileManager.renameFile = async (file: TFile, newPath: string): Promise<void> => {
		const oldPath = file.path;
		if (existsOnRealDisk(oldPath)) {
			const content = readRealDiskFile(oldPath);
			writeRealDiskFile(newPath, content);
			fs.unlinkSync(resolveDiskPath(oldPath));
		}
		await baseRename(file, newPath);
	};

	// Intercept baseOriginals.save so native saves also write directly to real disk files in tempDir
	const baseSave = harness.patchController.lease.baseOriginals.save;
	(
		harness.patchController.lease.baseOriginals as {
			save: (this: MarkdownView, clear?: boolean) => Promise<void>;
		}
	).save = async function (this: MarkdownView, clear?: boolean): Promise<void> {
		await baseSave.call(this, clear);
		const f = (this as unknown as { file?: TFile | null }).file;
		if (f && harness.disk.has(f.path)) {
			writeRealDiskFile(f.path, harness.disk.get(f.path)!);
		}
	};

	const seedRealProtectedNote: FileBackedHarness["seedRealProtectedNote"] = async (seedOpts) => {
		const relPath = seedOpts?.path ?? "ProtectedNote.md";
		const decoyBody = seedOpts?.decoyBody ?? DEFAULT_DECOY;
		const realText = seedOpts?.realText ?? SENTINEL_REAL_TEXT_P0;
		const password = seedOpts?.password ?? TEST_PASSWORD;
		const realTitle = seedOpts?.realTitle ?? SENTINEL_REAL_TITLE;
		const saveMode = seedOpts?.saveMode ?? options?.defaultNativeSaveMode ?? "recompute";

		const created = await createFile(
			realText,
			password,
			decoyBody,
			undefined,
			undefined,
			realTitle,
		);
		writeRealDiskFile(relPath, created.fileContent);
		harness.disk.set(relPath, created.fileContent);

		const file = makeMockFile(relPath);
		const pane = harness.createPane(file, decoyBody, saveMode);
		pane.view.setViewData(created.fileContent, true);
		const session = harness.sessions.get(pane.view);
		if (!session) {
			throw new Error("Expected patched setViewData to attach a ViewSession");
		}
		return {
			file,
			pane,
			session,
			initialContent: created.fileContent,
			initialPayload: created.payload,
		};
	};

	return {
		tempDir,
		harness,
		resolveDiskPath,
		readRealDiskFile,
		writeRealDiskFile,
		existsOnRealDisk,
		seedRealProtectedNote,
		cleanup: () => {
			harness.restorePrototype();
			const holder = MarkdownView.prototype as unknown as Record<symbol, unknown>;
			delete holder[VIEW_LIFECYCLE_SYMBOL];
			fs.rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

describe("File-backed unload persistence, race schedules, and failure injection (Issue #13 Task 8)", () => {
	let activeEnv: FileBackedHarness | null = null;

	beforeEach(() => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-issue13-fb-"));
		activeEnv = createFileBackedPluginHarness(tempDir);
	});

	afterEach(() => {
		activeEnv?.cleanup();
		activeEnv = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	afterAll(() => {
		fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, "task-8-file-backed.json"),
			JSON.stringify(
				{
					suite: "test/unload-file-backed.test.ts",
					totalScenarios: fileBackedOutcomes.length,
					allPassed: fileBackedOutcomes.every(
						(o) =>
							!o.containsPlaintextSentinel &&
							!o.containsTitleSentinel &&
							!o.containsUnencryptedTail &&
							o.decryptedMatchesExpectedSnapshot,
					),
					scenarios: fileBackedOutcomes,
				},
				null,
				2,
			) + "\n",
			"utf8",
		);
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, "task-8-failures.json"),
			JSON.stringify(
				{
					suite: "test/unload-file-backed.test.ts (failure injection)",
					totalFailureScenarios: failureOutcomes.length,
					allPreservedLastGoodFile: failureOutcomes.every(
						(o) =>
							o.lastGoodFilePreserved &&
							o.decryptedMatchesLastGood &&
							!o.falseSuccessReported &&
							!o.containsPlaintextSentinel,
					),
					failures: failureOutcomes,
				},
				null,
				2,
			) + "\n",
			"utf8",
		);
	});

	it.each([
		["onunload-first", "recompute"],
		["cleanup-first", "recompute"],
		["onunload-first", "backing-data"],
		["cleanup-first", "backing-data"],
	] as const satisfies readonly [UnloadCallbackOrder, NativeSaveMode][])(
		"persists completed P1 snapshot to real temp file on unload + native save (%s, %s), preserves locked cover edits, omits unencrypted P2 tail, and keeps ordinary note byte-identical",
		async (order, saveMode) => {
			const env = activeEnv!;
			const ordinaryRelPath = "OrdinaryNote.md";
			env.writeRealDiskFile(ordinaryRelPath, ORDINARY_NOTE_CONTENT);
			const ordinaryFile = makeMockFile(ordinaryRelPath);
			const ordinaryPane = env.harness.createPane(
				ordinaryFile,
				ORDINARY_NOTE_CONTENT,
				saveMode,
			);
			const ordinaryBeforeBytes = fs.readFileSync(env.resolveDiskPath(ordinaryRelPath));

			const { file, pane, session } = await env.seedRealProtectedNote({
				path: `Note-${order}-${saveMode}.md`,
				realText: SENTINEL_REAL_TEXT_P0,
				realTitle: SENTINEL_REAL_TITLE,
				saveMode,
			});

			const { file: lockedFile, pane: lockedPane } = await env.seedRealProtectedNote({
				path: `LockedEdited-${order}-${saveMode}.md`,
				realText: SENTINEL_REAL_TEXT_P0,
				realTitle: SENTINEL_REAL_TITLE,
				saveMode,
			});
			lockedPane.typeInEditor(EDITED_DECOY);

			expect(await env.harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");
			await env.harness.stageCompletedPendingPayload(
				session,
				SENTINEL_REAL_TEXT_P1,
				SENTINEL_REAL_TITLE,
			);
			pane.typeInEditor(SENTINEL_REAL_TEXT_P2_TAIL);

			// Unload plugin and trigger native save on unlocked, locked-edited, and ordinary panes
			env.harness.unloadPlugin(order);
			await pane.view.save();
			await lockedPane.view.save();
			await ordinaryPane.view.save();

			const rawSaved = env.readRealDiskFile(file.path);
			const sentinelCheck = containsAnySentinel(rawSaved);
			expect(sentinelCheck.hasPlaintext).toBe(false);
			expect(sentinelCheck.hasTitle).toBe(false);
			expect(sentinelCheck.hasTail).toBe(false);

			const parsed = parseFileContent(rawSaved);
			expect(parsed).not.toBeNull();
			const unlocked = await unlockPayload(parsed!.payload, TEST_PASSWORD);
			unlocked.dek.fill(0);

			expect(unlocked.realText).toBe(SENTINEL_REAL_TEXT_P1);
			expect(unlocked.realTitle).toBe(SENTINEL_REAL_TITLE);
			expect(parsed!.decoyBody).toBe(DEFAULT_DECOY);

			const rawLockedSaved = env.readRealDiskFile(lockedFile.path);
			const lockedSentinelCheck = containsAnySentinel(rawLockedSaved);
			expect(lockedSentinelCheck.hasPlaintext).toBe(false);
			expect(lockedSentinelCheck.hasTitle).toBe(false);
			const parsedLocked = parseFileContent(rawLockedSaved);
			expect(parsedLocked).not.toBeNull();
			expect(parsedLocked!.decoyBody).toBe(EDITED_DECOY);
			const unlockedFromLocked = await unlockPayload(parsedLocked!.payload, TEST_PASSWORD);
			unlockedFromLocked.dek.fill(0);
			expect(unlockedFromLocked.realText).toBe(SENTINEL_REAL_TEXT_P0);
			expect(unlockedFromLocked.realTitle).toBe(SENTINEL_REAL_TITLE);

			const ordinaryAfterBytes = fs.readFileSync(env.resolveDiskPath(ordinaryRelPath));
			const ordinaryIdentical = Buffer.compare(ordinaryBeforeBytes, ordinaryAfterBytes) === 0;
			expect(ordinaryIdentical).toBe(true);

			fileBackedOutcomes.push({
				scenario: `unlocked-and-locked-handoff:${order}:${saveMode}`,
				filePath: file.path,
				sha256: sha256Hex(rawSaved),
				byteLength: Buffer.byteLength(rawSaved, "utf8"),
				containsPlaintextSentinel:
					sentinelCheck.hasPlaintext || lockedSentinelCheck.hasPlaintext,
				containsTitleSentinel: sentinelCheck.hasTitle || lockedSentinelCheck.hasTitle,
				containsUnencryptedTail: sentinelCheck.hasTail,
				parsedAsProtected: parsed !== null && parsedLocked !== null,
				decryptedMatchesExpectedSnapshot:
					unlocked.realText === SENTINEL_REAL_TEXT_P1 &&
					unlockedFromLocked.realText === SENTINEL_REAL_TEXT_P0,
				decryptedTitleMatchesExpected:
					unlocked.realTitle === SENTINEL_REAL_TITLE &&
					unlockedFromLocked.realTitle === SENTINEL_REAL_TITLE,
				decoyMatchesExpected:
					parsed!.decoyBody === DEFAULT_DECOY && parsedLocked!.decoyBody === EDITED_DECOY,
				ordinaryNoteByteIdentical: ordinaryIdentical,
			});
		},
	);

	it("runs all race schedules against real temp files: submitted write A -> retirement B -> native C -> successor D, queued-unstarted save, held reservation, held KDF, held image read, held encryption, command boundaries (password, refresh, unprotect, protect), and duress with storage sentinel survival", async () => {
		// 1. Submitted write A -> retirement B -> native save C -> successor D
		{
			const gateA = createDeferred<void>();
			const enteredA = createDeferred<void>();
			const trace: string[] = [];
			let holdFirst = true;

			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-race-abcd-"));
			const env = createFileBackedPluginHarness(tempDir, {
				onModifyStart: (targetPath) => {
					if (targetPath === "RaceABCD.md" && holdFirst) {
						trace.push("A:start");
						enteredA.resolve();
					}
				},
				modifyGateForPath: (targetPath) => {
					if (targetPath === "RaceABCD.md" && holdFirst) {
						holdFirst = false;
						return gateA.promise.then(() => {
							trace.push("A:commit");
						});
					}
					return null;
				},
				onNativeSaveStart: ({ path: targetPath }) => {
					if (targetPath === "RaceABCD.md") {
						trace.push("C:native-start");
					}
				},
			});

			try {
				const { file, pane, session } = await env.seedRealProtectedNote({
					path: "RaceABCD.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				expect(await env.harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");
				const payloadP1 = await env.harness.stageCompletedPendingPayload(
					session,
					SENTINEL_REAL_TEXT_P1,
					SENTINEL_REAL_TITLE,
				);
				pane.typeInEditor(SENTINEL_REAL_TEXT_P2_TAIL);

				// Queue submitted write A and also a second queued-but-unstarted normal write A2
				const initialDiskRaw = env.readRealDiskFile(file.path);
				const writeAPromise = env.harness.sessions.enqueueCoordinatedWrite(
					file,
					async () => {
						await env.harness.app.vault.modify(file, initialDiskRaw);
					},
					{ session },
				);
				await enteredA.promise;

				let unstartedInvoked = false;
				const queuedUnstartedPromise = env.harness.sessions.enqueueCoordinatedWrite(
					file,
					async () => {
						unstartedInvoked = true;
						await env.harness.app.vault.modify(file, "UNSTARTED_SHOULD_NOT_RUN");
					},
					{ session },
				);

				// Retirement B while A is in-flight and A2 is queued-unstarted
				env.harness.unloadPlugin("onunload-first");
				trace.push("B:retired-sync");

				// Native save C queued behind A
				const nativeSaveCPromise = pane.view.save(true).then(() => {
					trace.push("C:native-commit");
				});

				// Successor D waits for predecessorReady before reading and writing
				const coordinator = getSharedLifecycleCoordinator();
				const sessionsD = new SessionManager(
					env.harness.app,
					{
						onUnlocked: () => undefined,
						onLocked: () => undefined,
						onUnlockBlocked: () => undefined,
					},
					() => ";;",
					() => null,
					coordinator,
				);
				const cleanupsD: Array<() => void> = [];
				const controllerD = installViewPatches(sessionsD, (fn) => cleanupsD.push(fn));

				const successorDPromise = (async () => {
					trace.push("D:wait-predecessor");
					await coordinator.predecessorReady(env.harness.app, file);
					trace.push("D:read");
					const rawFromDisk = await env.harness.app.vault.cachedRead(file);
					expect(parseFileContent(rawFromDisk)).not.toBeNull();
					await sessionsD.enqueueCoordinatedWrite(file, async () => {
						trace.push("D:write-start");
						await env.harness.app.vault.modify(
							file,
							serializeFile(EDITED_DECOY, payloadP1),
						);
						trace.push("D:write-commit");
					});
				})();

				gateA.resolve();
				await writeAPromise;
				const unstartedDone = await queuedUnstartedPromise;
				expect(unstartedDone).toEqual({ status: "declined" });
				expect(unstartedInvoked).toBe(false);

				await nativeSaveCPromise;
				await successorDPromise;

				controllerD.retireAndHandoff();
				await controllerD.drainPromise();
				for (const fn of cleanupsD) fn();

				const finalRaw = env.readRealDiskFile(file.path);
				const sentinelCheck = containsAnySentinel(finalRaw);
				expect(sentinelCheck.hasPlaintext).toBe(false);
				expect(sentinelCheck.hasTitle).toBe(false);
				expect(sentinelCheck.hasTail).toBe(false);

				const parsed = parseFileContent(finalRaw);
				expect(parsed).not.toBeNull();
				const unlocked = await unlockPayload(parsed!.payload, TEST_PASSWORD);
				unlocked.dek.fill(0);
				expect(unlocked.realText).toBe(SENTINEL_REAL_TEXT_P1);
				expect(parsed!.decoyBody).toBe(EDITED_DECOY);

				const idxA = trace.indexOf("A:commit");
				const idxC = trace.indexOf("C:native-commit");
				const idxDRead = trace.indexOf("D:read");
				const idxDWrite = trace.indexOf("D:write-commit");
				expect(idxA).toBeGreaterThanOrEqual(0);
				expect(idxC).toBeGreaterThan(idxA);
				expect(idxDRead).toBeGreaterThan(idxC);
				expect(idxDWrite).toBeGreaterThan(idxDRead);

				fileBackedOutcomes.push({
					scenario: "race:submitted-A->retire-B->native-C->successor-D+queued-unstarted",
					filePath: file.path,
					sha256: sha256Hex(finalRaw),
					byteLength: Buffer.byteLength(finalRaw, "utf8"),
					containsPlaintextSentinel: sentinelCheck.hasPlaintext,
					containsTitleSentinel: sentinelCheck.hasTitle,
					containsUnencryptedTail: sentinelCheck.hasTail,
					parsedAsProtected: true,
					decryptedMatchesExpectedSnapshot: unlocked.realText === SENTINEL_REAL_TEXT_P1,
					decryptedTitleMatchesExpected: unlocked.realTitle === SENTINEL_REAL_TITLE,
					decoyMatchesExpected: parsed!.decoyBody === EDITED_DECOY,
					lifecycleOrder: trace,
				});
			} finally {
				env.cleanup();
			}
		}

		// 2. Held reservation + deferred native save + held KDF + held image read + held encryption
		{
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const kdfGate = createDeferred<void>();
			const kdfEntered = createDeferred<void>();
			const imageGate = createDeferred<void>();
			const encryptGate = createDeferred<void>();
			const encryptEntered = createDeferred<void>();
			const origEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
			const origDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);

			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-race-holds-"));
			const env = createFileBackedPluginHarness(tempDir, {
				readBinaryGate: imageGate.promise,
			});

			try {
				const { file, pane, session } = await env.seedRealProtectedNote({
					path: "HeldOperations.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				const { file: encryptFile, pane: encryptPane, session: encryptSession } =
					await env.seedRealProtectedNote({
						path: "HeldEncryptNote.md",
						realText: SENTINEL_REAL_TEXT_P0,
					});

				// 2a: Held path reservation + deferred save before unload
				const releaseReservation = env.harness.sessions.reservePath(file.path);
				await pane.view.save();
				env.writeRealDiskFile("Pasted chart.png", "fake-png-binary");

				// Unlock first so we can exercise held image read and held encryption
				releaseReservation();
				expect(await env.harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");
				expect(await env.harness.sessions.unlock(encryptSession, TEST_PASSWORD)).toBe("ok");
				await env.harness.stageCompletedPendingPayload(
					session,
					SENTINEL_REAL_TEXT_P1,
					SENTINEL_REAL_TITLE,
				);
				await env.harness.stageCompletedPendingPayload(
					encryptSession,
					SENTINEL_REAL_TEXT_P1,
					SENTINEL_REAL_TITLE,
				);

				pane.typeInEditor(`${SENTINEL_REAL_TEXT_P2_TAIL}\n![[Pasted chart.png]]`);
				env.harness.sessions.scheduleReencrypt(session);
				await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
				expect(session.reencryptPromise).not.toBeNull();

				let holdNextEncrypt = true;
				const encryptSpy = vi
					.spyOn(crypto.subtle, "encrypt")
					.mockImplementation(async (algorithm, key, data): Promise<ArrayBuffer> => {
						if (holdNextEncrypt) {
							holdNextEncrypt = false;
							encryptEntered.resolve();
							await encryptGate.promise;
						}
						return origEncrypt(algorithm, key, data);
					});

				encryptPane.typeInEditor(SENTINEL_REAL_TEXT_P2_TAIL);
				env.harness.sessions.scheduleReencrypt(encryptSession);
				await vi.advanceTimersByTimeAsync(REENCRYPT_DEBOUNCE_MS);
				await encryptEntered.promise;
				expect(encryptSession.reencryptPromise).not.toBeNull();

				const { session: kdfSession } = await env.seedRealProtectedNote({
					path: "HeldKdfNote.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				let holdKdfOnce = true;
				let lateDerivedDekBuffer: ArrayBuffer | null = null;
				const kdfSpy = vi
					.spyOn(crypto.subtle, "decrypt")
					.mockImplementation(async (algorithm, key, data): Promise<ArrayBuffer> => {
						if (holdKdfOnce) {
							holdKdfOnce = false;
							const buf = await origDecrypt(algorithm, key, data);
							lateDerivedDekBuffer = buf;
							kdfEntered.resolve();
							await kdfGate.promise;
							return buf;
						}
						return origDecrypt(algorithm, key, data);
					});

				const kdfUnlockPromise = env.harness.sessions.unlock(kdfSession, TEST_PASSWORD);
				await kdfEntered.promise;
				const capturedLateDek = new Uint8Array(lateDerivedDekBuffer!);
				expect(capturedLateDek.some((b) => b !== 0)).toBe(true);

				env.harness.unloadPlugin("cleanup-first");

				imageGate.resolve();
				encryptGate.resolve();
				kdfGate.resolve();

				if (session.reencryptPromise) {
					await session.reencryptPromise;
				}
				if (encryptSession.reencryptPromise) {
					await encryptSession.reencryptPromise;
				}
				const kdfResult = await kdfUnlockPromise;
				expect(kdfResult).toBe("blocked");
				expect(kdfSession.state).toBe("locked");
				expect(kdfSession.dek).toBeNull();
				expect(Array.from(capturedLateDek).every((b) => b === 0)).toBe(true);

				encryptSpy.mockRestore();
				kdfSpy.mockRestore();

				await pane.view.save();
				await encryptPane.view.save();
				const rawEncryptSaved = env.readRealDiskFile(encryptFile.path);
				expect(containsAnySentinel(rawEncryptSaved).hasPlaintext).toBe(false);
				const rawSaved = env.readRealDiskFile(file.path);
				const sentinelCheck = containsAnySentinel(rawSaved);
				expect(sentinelCheck.hasPlaintext).toBe(false);
				expect(sentinelCheck.hasTitle).toBe(false);
				expect(sentinelCheck.hasTail).toBe(false);
				expect(env.existsOnRealDisk("Pasted chart.png")).toBe(true);

				const parsed = parseFileContent(rawSaved);
				expect(parsed).not.toBeNull();
				const unlocked = await unlockPayload(parsed!.payload, TEST_PASSWORD);
				unlocked.dek.fill(0);
				expect(unlocked.realText).toBe(SENTINEL_REAL_TEXT_P1);

				fileBackedOutcomes.push({
					scenario: "race:held-reservation+held-kdf+held-image-read+held-encryption",
					filePath: file.path,
					sha256: sha256Hex(rawSaved),
					byteLength: Buffer.byteLength(rawSaved, "utf8"),
					containsPlaintextSentinel: sentinelCheck.hasPlaintext,
					containsTitleSentinel: sentinelCheck.hasTitle,
					containsUnencryptedTail: sentinelCheck.hasTail,
					parsedAsProtected: true,
					decryptedMatchesExpectedSnapshot: unlocked.realText === SENTINEL_REAL_TEXT_P1,
					decryptedTitleMatchesExpected: unlocked.realTitle === SENTINEL_REAL_TITLE,
					decoyMatchesExpected: parsed!.decoyBody === DEFAULT_DECOY,
				});
			} finally {
				vi.useRealTimers();
				env.cleanup();
			}
		}

		// 3. Command writes (password, refresh, unprotect, protect) across pre-submit, submitted, and post-commit boundaries + duress dominance and storage sentinel survival
		{
			const pwGate = createDeferred<void>();
			const pwStarted = createDeferred<void>();
			const refreshGate = createDeferred<void>();
			const refreshStarted = createDeferred<void>();
			const unprotectGate = createDeferred<void>();
			const unprotectStarted = createDeferred<void>();
			const protectGate = createDeferred<void>();
			const protectStarted = createDeferred<void>();

			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-race-cmd-duress-"));
			const env = createFileBackedPluginHarness(tempDir, {
				onModifyStart: (targetPath) => {
					if (targetPath === "CmdPassword.md") pwStarted.resolve();
					if (targetPath === "CmdRefresh.md") refreshStarted.resolve();
					if (targetPath === "CmdUnprotectSubmitted.md") unprotectStarted.resolve();
					if (targetPath === "CmdProtectPlain.md") protectStarted.resolve();
				},
				modifyGateForPath: (targetPath) => {
					if (targetPath === "CmdPassword.md") return pwGate.promise;
					if (targetPath === "CmdRefresh.md") return refreshGate.promise;
					if (targetPath === "CmdUnprotectSubmitted.md") return unprotectGate.promise;
					if (targetPath === "CmdProtectPlain.md") return protectGate.promise;
					return null;
				},
			});

			// Install Electron mock with storage sentinels to verify storage sentinel survival across duress
			const storageSentinels = new Map<string, string>([
				["obsidian:workspace-layout", "preserved-workspace-state"],
				["community-plugin:dataview-cache", "preserved-plugin-index"],
				["indexeddb:app://obsidian.md", "preserved-origin-idb"],
			]);
			const clearCacheSpy = vi.fn(async () => {
				storageSentinels.clear();
			});
			const clearStorageDataSpy = vi.fn(async () => {
				storageSentinels.clear();
			});
			const moduleCtor = Module as unknown as {
				_load: (request: string, parent: unknown, isMain: boolean) => unknown;
			};
			const origModuleLoad = moduleCtor._load;
			moduleCtor._load = function (
				request: string,
				parent: unknown,
				isMain: boolean,
			): unknown {
				if (request === "electron") {
					return {
						remote: {
							session: {
								defaultSession: {
									clearCache: clearCacheSpy,
									clearStorageData: clearStorageDataSpy,
								},
							},
						},
					};
				}
				return origModuleLoad.call(this, request, parent, isMain);
			};

			try {
				const { file: pwFile, pane: pwPane } = await env.seedRealProtectedNote({
					path: "CmdPassword.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				const { file: refreshFile } = await env.seedRealProtectedNote({
					path: "CmdRefresh.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				const { file: unprotectPreFile } = await env.seedRealProtectedNote({
					path: "CmdUnprotectPre.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				const { file: unprotectSubFile, pane: unprotectSubPane } =
					await env.seedRealProtectedNote({
						path: "CmdUnprotectSubmitted.md",
						realText: SENTINEL_REAL_TEXT_P0,
					});
				const { file: shredFile, session: shredSession } = await env.seedRealProtectedNote({
					path: "DuressTarget.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				await env.harness.plugin.registry.add(unprotectPreFile.path, {
					noteId: "unprotect-pre-id",
					addedAt: 1,
					mode: "portable",
				});
				await env.harness.plugin.registry.add(unprotectSubFile.path, {
					noteId: "unprotect-sub-id",
					addedAt: 1,
					mode: "portable",
				});
				await env.harness.plugin.registry.add(shredFile.path, {
					noteId: shredSession.originalPayload.note_id,
					addedAt: 1,
					mode: "portable",
				});

				// 3a: Submitted refreshDecoy commits across completion (post-commit retitle check)
				const refreshPromise = (
					env.harness.plugin as unknown as {
						refreshDecoy: (f: TFile) => Promise<void>;
					}
				).refreshDecoy(refreshFile);
				await refreshStarted.promise;
				refreshGate.resolve();
				await refreshPromise;

				// 3b: Plain note protectFile submitted before unload, plus password rotation and unprotect submitted before unload, plus pre-submit unprotect paused at modal
				const plainToProtect = makeMockFile("CmdProtectPlain.md");
				const plainWithImg = `${SENTINEL_REAL_TEXT_P0}\n![[Pasted chart.png]]`;
				env.writeRealDiskFile(plainToProtect.path, plainWithImg);
				env.harness.disk.set(plainToProtect.path, plainWithImg);
				env.writeRealDiskFile("Pasted chart.png", "raw-image-bytes");
				env.harness.disk.set("Pasted chart.png", "raw-image-bytes");
				env.harness.createPane(plainToProtect, plainWithImg);

				let capturedOnProtect:
					| ((res: { decoy: string; password: string }) => Promise<void>)
					| null = null;
				vi.spyOn(ProtectWizard.prototype, "open").mockImplementation(function (
					this: ProtectWizard,
				) {
					const deps = (
						this as unknown as {
							deps: {
								onProtect: (res: {
									decoy: string;
									password: string;
								}) => Promise<void>;
							};
						}
					).deps;
					capturedOnProtect = deps.onProtect;
				});

				await (
					env.harness.plugin as unknown as {
						protectFile: (f: TFile) => Promise<void>;
					}
				).protectFile(plainToProtect);
				const protectSubmitPromise = capturedOnProtect!({
					decoy: `# Cover Title\n\n${DEFAULT_DECOY}`,
					password: TEST_PASSWORD,
				});
				await protectStarted.promise;

				// Start password rotation and submitted unprotect so both reach their modify gates
				const getActiveFileSpy = vi.spyOn(env.harness.app.workspace, "getActiveFile");
				getActiveFileSpy.mockReturnValueOnce(pwFile);
				const askSpy = vi
					.spyOn(PasswordModal.prototype, "ask")
					.mockResolvedValueOnce(TEST_PASSWORD)
					.mockResolvedValueOnce(NEXT_TEST_PASSWORD)
					.mockResolvedValueOnce(TEST_PASSWORD);

				const pwPromise = (
					env.harness.plugin as unknown as {
						changePasswordViaModal: () => Promise<void>;
					}
				).changePasswordViaModal();
				await pwStarted.promise;

				getActiveFileSpy.mockReturnValueOnce(unprotectSubFile);
				const unprotectSubPromise = (
					env.harness.plugin as unknown as {
						unprotectViaModal: () => Promise<void>;
					}
				).unprotectViaModal();
				await unprotectStarted.promise;

				// Also start a pre-submit unprotect that pauses at the modal (before submitting I/O)
				askSpy.mockImplementationOnce(
					() =>
						new Promise<string | null>((resolve) => {
							// Will be closed on unload
							setTimeout(() => resolve(null), 50);
						}),
				);
				getActiveFileSpy.mockReturnValueOnce(unprotectPreFile);
				const unprotectPrePromise = (
					env.harness.plugin as unknown as {
						unprotectViaModal: () => Promise<void>;
					}
				).unprotectViaModal();
				await Promise.resolve();
				await Promise.resolve();

				// Unload while protect, password rotation, and unprotectSub are submitted in-flight, and unprotectPre is pre-submit
				env.harness.unloadPlugin("onunload-first");
				protectGate.resolve();
				pwGate.resolve();
				unprotectGate.resolve();

				await protectSubmitPromise;
				await pwPromise;
				await unprotectSubPromise;
				await unprotectPrePromise;
				await env.harness.patchController.drainPromise();

				await pwPane.view.save();
				await unprotectSubPane.view.save();

				// Verify protectFile registered the note, left source image intact on disk, and skipped post-commit retitle
				expect(
					env.harness.plugin.registry.list().some((e) => e.path === "CmdProtectPlain.md"),
				).toBe(true);
				expect(env.existsOnRealDisk("Pasted chart.png")).toBe(true);
				expect(plainToProtect.path).toBe("CmdProtectPlain.md");

				// Verify password rotation committed and decrypts under NEXT_TEST_PASSWORD
				const pwDiskRaw = env.readRealDiskFile(pwFile.path);
				const pwSentinels = containsAnySentinel(pwDiskRaw);
				expect(pwSentinels.hasPlaintext).toBe(false);
				const pwParsed = parseFileContent(pwDiskRaw);
				expect(pwParsed).not.toBeNull();
				const pwUnlocked = await unlockPayload(pwParsed!.payload, NEXT_TEST_PASSWORD);
				pwUnlocked.dek.fill(0);
				expect(pwUnlocked.realText).toBe(SENTINEL_REAL_TEXT_P0);

				// Verify submitted unprotect ended as plaintext and removed registry entry, while pre-submit unprotect stayed protected
				const unprotectSubRaw = env.readRealDiskFile(unprotectSubFile.path);
				expect(parseFileContent(unprotectSubRaw)).toBeNull();
				expect(unprotectSubRaw).toBe(`${SENTINEL_REAL_TEXT_P0}\n`);
				expect(
					env.harness.plugin.registry
						.list()
						.some((e) => e.path === unprotectSubFile.path),
				).toBe(false);

				const unprotectPreRaw = env.readRealDiskFile(unprotectPreFile.path);
				expect(parseFileContent(unprotectPreRaw)).not.toBeNull();
				expect(
					env.harness.plugin.registry
						.list()
						.some((e) => e.path === unprotectPreFile.path),
				).toBe(true);

				// Execute duress shred and verify DuressTarget.md is cover-only while Electron storage sentinels survive
				await (
					env.harness.plugin as unknown as { runShred: () => Promise<void> }
				).runShred();
				const shreddedRaw = env.readRealDiskFile(shredFile.path);
				expect(parseFileContent(shreddedRaw)).toBeNull();
				expect(shreddedRaw).toBe(`${DEFAULT_DECOY}\n`);
				expect(containsAnySentinel(shreddedRaw).hasPlaintext).toBe(false);
				expect(clearCacheSpy).not.toHaveBeenCalled();
				expect(clearStorageDataSpy).not.toHaveBeenCalled();
				expect(storageSentinels.size).toBe(3);

				fileBackedOutcomes.push({
					scenario:
						"race:command-boundaries(password,refresh,unprotect,protect)+duress-dominance+storage-sentinel-survival",
					filePath: pwFile.path,
					sha256: sha256Hex(pwDiskRaw),
					byteLength: Buffer.byteLength(pwDiskRaw, "utf8"),
					containsPlaintextSentinel: pwSentinels.hasPlaintext,
					containsTitleSentinel: pwSentinels.hasTitle,
					containsUnencryptedTail: pwSentinels.hasTail,
					parsedAsProtected: true,
					decryptedMatchesExpectedSnapshot:
						pwUnlocked.realText === SENTINEL_REAL_TEXT_P0,
					decryptedTitleMatchesExpected: pwUnlocked.realTitle === SENTINEL_REAL_TITLE,
					decoyMatchesExpected: pwParsed!.decoyBody === DEFAULT_DECOY,
					storageSentinelsSurvived: storageSentinels.size === 3,
				});
			} finally {
				moduleCtor._load = origModuleLoad;
				env.cleanup();
			}
		}
	}, 25000);

	it("isolates injected failures (disk-full on modify, throwing native setter, rejected clipboard read, rejected generator unload) while preserving the last good on-disk file", async () => {
		// Failure 1: Disk-full on vault.modify during lock before unload -> last good file P0 preserved on disk, lock reports failure, no false newer save
		{
			let failModify = false;
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-fail-diskfull-"));
			let lockFailedReported = false;
			const env = createFileBackedPluginHarness(tempDir, {
				hooks: {
					onLockFailed: () => {
						lockFailedReported = true;
					},
				},
				shouldFailModify: (targetPath) =>
					targetPath === "DiskFullNote.md" && failModify
						? new Error("ENOSPC: no space left on device")
						: null,
			});

			try {
				const { file, pane, session } = await env.seedRealProtectedNote({
					path: "DiskFullNote.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				const shaBefore = sha256Hex(env.readRealDiskFile(file.path));

				expect(await env.harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");
				pane.typeInEditor(SENTINEL_REAL_TEXT_P1);

				failModify = true;
				await expect(env.harness.sessions.lock(session, "manual")).rejects.toThrow(
					"ENOSPC: no space left on device",
				);
				expect(lockFailedReported).toBe(true);

				// Unload after failed lock
				env.harness.unloadPlugin("onunload-first");
				const rawAfter = env.readRealDiskFile(file.path);
				const shaAfter = sha256Hex(rawAfter);
				expect(shaAfter).toBe(shaBefore);

				const sentinelCheck = containsAnySentinel(rawAfter);
				expect(sentinelCheck.hasPlaintext).toBe(false);
				const parsed = parseFileContent(rawAfter);
				expect(parsed).not.toBeNull();
				const unlocked = await unlockPayload(parsed!.payload, TEST_PASSWORD);
				unlocked.dek.fill(0);
				expect(unlocked.realText).toBe(SENTINEL_REAL_TEXT_P0);

				failureOutcomes.push({
					scenario: "disk-full-on-modify",
					injectedFailure: "ENOSPC: no space left on device",
					filePath: file.path,
					sha256BeforeFailure: shaBefore,
					sha256AfterFailure: shaAfter,
					lastGoodFilePreserved: shaBefore === shaAfter,
					parsedAsProtected: parsed !== null,
					decryptedMatchesLastGood: unlocked.realText === SENTINEL_REAL_TEXT_P0,
					falseSuccessReported: !lockFailedReported,
					containsPlaintextSentinel: sentinelCheck.hasPlaintext,
				});
			} finally {
				env.cleanup();
			}
		}

		// Failure 2: Throwing native setter during unload -> falls back to editor.setValue + view.data; if fallback also fails, view is save-blocked and last good disk file is preserved
		{
			let throwInNativeSetter = false;
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-fail-setter-"));
			const env = createFileBackedPluginHarness(tempDir, {
				shouldFailNativeSetter: () =>
					throwInNativeSetter ? new Error("Simulated native setViewData failure") : null,
			});

			try {
				const { file, pane, session } = await env.seedRealProtectedNote({
					path: "ThrowingSetter.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				const shaBefore = sha256Hex(env.readRealDiskFile(file.path));

				expect(await env.harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");
				pane.typeInEditor(SENTINEL_REAL_TEXT_P2_TAIL);

				// Also break editor.setValue so the view becomes unrecoverable and save-blocked
				(pane.view.editor as unknown as { setValue: () => void }).setValue = () => {
					throw new Error("Simulated editor.setValue failure");
				};
				throwInNativeSetter = true;

				env.harness.unloadPlugin("onunload-first");

				let saveRejected = false;
				try {
					await pane.view.save();
				} catch {
					saveRejected = true;
				}
				expect(saveRejected).toBe(true);

				const rawAfter = env.readRealDiskFile(file.path);
				const shaAfter = sha256Hex(rawAfter);
				expect(shaAfter).toBe(shaBefore);
				const sentinelCheck = containsAnySentinel(rawAfter);
				expect(sentinelCheck.hasPlaintext).toBe(false);

				const parsed = parseFileContent(rawAfter);
				expect(parsed).not.toBeNull();
				const unlocked = await unlockPayload(parsed!.payload, TEST_PASSWORD);
				unlocked.dek.fill(0);
				expect(unlocked.realText).toBe(SENTINEL_REAL_TEXT_P0);

				failureOutcomes.push({
					scenario: "throwing-native-setter-and-editor-fallback",
					injectedFailure: "Simulated native setViewData + editor.setValue failure",
					filePath: file.path,
					sha256BeforeFailure: shaBefore,
					sha256AfterFailure: shaAfter,
					lastGoodFilePreserved: shaBefore === shaAfter,
					parsedAsProtected: parsed !== null,
					decryptedMatchesLastGood: unlocked.realText === SENTINEL_REAL_TEXT_P0,
					falseSuccessReported: !saveRejected,
					containsPlaintextSentinel: sentinelCheck.hasPlaintext,
				});
			} finally {
				env.cleanup();
			}
		}

		// Failure 3: Rejected clipboard read + rejected generator unload during unload -> teardown still sanitizes and native save preserves P1
		{
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-fail-clip-gen-"));
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const origClipboard = Object.getOwnPropertyDescriptor(globalThis, "navigator");
			Object.defineProperty(globalThis, "navigator", {
				value: {
					clipboard: {
						readText: async () => {
							throw new Error("Simulated clipboard read rejection");
						},
						writeText: async () => {
							throw new Error("Simulated clipboard write rejection");
						},
					},
				},
				configurable: true,
			});

			const env = createFileBackedPluginHarness(tempDir, {
				generatorUnloadError: new Error("Simulated generator unload rejection"),
			});

			try {
				const { file, pane, session } = await env.seedRealProtectedNote({
					path: "ClipGenFailure.md",
					realText: SENTINEL_REAL_TEXT_P0,
				});
				expect(await env.harness.sessions.unlock(session, TEST_PASSWORD)).toBe("ok");
				await env.harness.stageCompletedPendingPayload(
					session,
					SENTINEL_REAL_TEXT_P1,
					SENTINEL_REAL_TITLE,
				);

				// Persist P1 to disk as the last good completed file before unload
				const p1Serialized = serializeFile(DEFAULT_DECOY, session.pendingPayload!);
				env.writeRealDiskFile(file.path, p1Serialized);
				env.harness.disk.set(file.path, p1Serialized);
				const shaBefore = sha256Hex(env.readRealDiskFile(file.path));

				env.harness.plugin.settings.clearClipboardOnLock = true;
				env.harness.plugin.lockEngine.clipboard.markTainted(SENTINEL_REAL_TEXT_P1);

				expect(() => env.harness.unloadPlugin("onunload-first")).not.toThrow();
				await pane.view.save();

				const rawAfter = env.readRealDiskFile(file.path);
				const shaAfter = sha256Hex(rawAfter);
				expect(shaAfter).toBe(shaBefore);

				const sentinelCheck = containsAnySentinel(rawAfter);
				expect(sentinelCheck.hasPlaintext).toBe(false);
				const parsed = parseFileContent(rawAfter);
				expect(parsed).not.toBeNull();
				const unlocked = await unlockPayload(parsed!.payload, TEST_PASSWORD);
				unlocked.dek.fill(0);
				expect(unlocked.realText).toBe(SENTINEL_REAL_TEXT_P1);

				failureOutcomes.push({
					scenario: "rejected-clipboard-read-and-rejected-generator-unload",
					injectedFailure:
						"Simulated clipboard read rejection + generator unload rejection",
					filePath: file.path,
					sha256BeforeFailure: shaBefore,
					sha256AfterFailure: shaAfter,
					lastGoodFilePreserved: shaBefore === shaAfter,
					parsedAsProtected: parsed !== null,
					decryptedMatchesLastGood: unlocked.realText === SENTINEL_REAL_TEXT_P1,
					falseSuccessReported: false,
					containsPlaintextSentinel: sentinelCheck.hasPlaintext,
				});
			} finally {
				if (origClipboard) {
					Object.defineProperty(globalThis, "navigator", origClipboard);
				}
				warnSpy.mockRestore();
				env.cleanup();
			}
		}

		expect(peekSharedLifecycleCoordinator()).toBeNull();
	});
});
