import { MarkdownView, type App, type TFile } from "obsidian";
import * as obsidianModule from "obsidian";
import {
	createFile,
	parseFileContent,
	reencryptRealText,
	serializeFile,
	unlockPayload,
	type ParsedFile,
	type PayloadV1,
} from "../../src/crypto/payload";
import { LockEngine } from "../../src/lock/LockEngine";
import { ProtectedRegistry } from "../../src/registry";
import { DEFAULT_SETTINGS, type VeneerSettings } from "../../src/settings";
import { VIEW_LIFECYCLE_SYMBOL } from "../../src/view/lifecycle";
import { installViewPatches, type ViewPatchController } from "../../src/view/patch";
import { SessionManager, type SessionHooks, type ViewSession } from "../../src/view/session";

export const DEFAULT_DECOY = "# Weekend Grocery List\n\n- milk\n- eggs\n- bread";
export const EDITED_DECOY = "# Weekend Grocery List\n\n- milk\n- eggs\n- bread\n- coffee beans";
export const SECRET_P0 = "ULTRA_SECRET_PAYLOAD_P0_SENTINEL_7391";
export const SECRET_P1 = "ULTRA_SECRET_PAYLOAD_P1_COMPLETED_REENCRYPT_8492";
export const SECRET_P2_TAIL = "ULTRA_SECRET_PAYLOAD_P2_UNENCRYPTED_DIRTY_TAIL_9503";
export const SECRET_REAL_TITLE = "Top Secret Acquisition Target Alpha";
export const TEST_PASSWORD = "correct horse battery staple";
export const NEXT_TEST_PASSWORD = "rotated battery horse staple";

/**
 * Native save styles exercised by the unload regression harness:
 * - `"recompute"`: native `MarkdownView.prototype.save` recomputes `this.data = this.getViewData()`
 *   before persisting `this.data` to disk.
 * - `"backing-data"`: native `MarkdownView.prototype.save` persists the existing `this.data`
 *   backing field directly without calling `this.getViewData()`.
 */
export type NativeSaveMode = "recompute" | "backing-data";

/**
 * Host callback execution order during plugin unload:
 * - `"onunload-first"`: `plugin.onunload()` runs before callbacks registered via `plugin.register(fn)`.
 * - `"cleanup-first"`: callbacks registered via `plugin.register(fn)` run before `plugin.onunload()`.
 */
export type UnloadCallbackOrder = "onunload-first" | "cleanup-first";

export interface Deferred<T = void> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
	readonly reject: (reason?: unknown) => void;
	readonly isSettled: () => boolean;
}

/**
 * Creates a manually controlled promise gate for deterministic async race testing.
 */
export function createDeferred<T = void>(): Deferred<T> {
	let resolveFn!: (value: T | PromiseLike<T>) => void;
	let rejectFn!: (reason?: unknown) => void;
	let settled = false;
	const promise = new Promise<T>((res, rej) => {
		resolveFn = (value) => {
			settled = true;
			res(value);
		};
		rejectFn = (reason) => {
			settled = true;
			rej(reason);
		};
	});
	return {
		promise,
		resolve: resolveFn,
		reject: rejectFn,
		isSettled: () => settled,
	};
}

export interface ObjectUrlStub {
	readonly created: string[];
	readonly revoked: Set<string>;
	readonly active: () => string[];
	readonly restore: () => void;
}

/**
 * Stubs `URL.createObjectURL` and `URL.revokeObjectURL` so preview URL creation
 * and revocation can be deterministically asserted.
 */
export function stubObjectUrls(shouldThrowOnRevoke?: (url: string) => Error | null): ObjectUrlStub {
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	let counter = 0;
	const created: string[] = [];
	const revoked = new Set<string>();

	URL.createObjectURL = (_blob: Blob | MediaSource): string => {
		counter += 1;
		const url = `blob:veneer-unload-test/${counter}`;
		created.push(url);
		return url;
	};
	URL.revokeObjectURL = (url: string): void => {
		const err = shouldThrowOnRevoke?.(url) ?? null;
		revoked.add(url);
		if (err !== null) {
			throw err;
		}
	};

	return {
		created,
		revoked,
		active: () => created.filter((u) => !revoked.has(u)),
		restore: () => {
			URL.createObjectURL = originalCreate;
			URL.revokeObjectURL = originalRevoke;
		},
	};
}

/**
 * Constructs a `TFile` test double that inherits from `TFile.prototype` when the
 * test environment provides a mocked `TFile` class, so `file instanceof TFile` checks pass.
 */
export function makeMockFile(filePath: string, parentPath = ""): TFile {
	const name = filePath.split("/").pop() ?? filePath;
	const dotIndex = name.lastIndexOf(".");
	const basename = dotIndex > 0 ? name.slice(0, dotIndex) : name;
	const extension = dotIndex > 0 ? name.slice(dotIndex + 1) : "md";
	const maybeTFileCtor = (obsidianModule as unknown as { TFile?: { prototype?: object } }).TFile;
	const proto = maybeTFileCtor?.prototype ?? Object.prototype;
	return Object.assign(Object.create(proto), {
		path: filePath,
		name,
		basename,
		extension,
		parent: { path: parentPath },
		stat: { mtime: 1_000, size: 256 },
	}) as TFile;
}

export interface RecordedWrite {
	readonly seq: number;
	readonly source: "vault.modify" | "native-save";
	readonly path: string;
	readonly content: string;
	readonly clear: boolean | undefined;
	readonly mode: NativeSaveMode | undefined;
}

export interface RecordedNativeSet {
	readonly seq: number;
	readonly view: MarkdownView;
	readonly path: string;
	readonly data: string;
	readonly clear: boolean | undefined;
}

export interface MockPane {
	readonly view: MarkdownView;
	file: TFile | null;
	readonly getEditorText: () => string;
	readonly setEditorText: (next: string) => void;
	readonly typeInEditor: (next: string) => void;
	readonly getBackingData: () => string;
	readonly setBackingData: (next: string) => void;
	readonly undoHistory: string[];
	readonly inlineTitleEl: { textContent: string };
	readonly headerTitleEl: { textContent: string };
	readonly tabHeaderTitleEl: { textContent: string };
	readonly getDisplayedTitles: () => { inline: string; header: string; tab: string };
	readonly getRequestSaveCount: () => number;
	readonly getCmDispatchCount: () => number;
	readonly switchFile: (nextFile: TFile | null) => void;
	readonly setNativeSaveMode: (mode: NativeSaveMode) => void;
	readonly getNativeSaveMode: () => NativeSaveMode;
}

export interface InspectedSavedFile {
	readonly isProtected: boolean;
	readonly decoyBody: string | null;
	readonly realText: string | null;
	readonly realTitle: string | null;
	readonly payload: PayloadV1 | null;
}

/**
 * Parses `rawContent` and, when a `draft_cache` payload is present, decrypts it
 * with `password` and zeroes the temporary DEK before returning the result.
 */
export async function inspectSavedFile(
	rawContent: string,
	password = TEST_PASSWORD,
): Promise<InspectedSavedFile> {
	const parsed = parseFileContent(rawContent);
	if (parsed === null) {
		return {
			isProtected: false,
			decoyBody: null,
			realText: null,
			realTitle: null,
			payload: null,
		};
	}
	const unlocked = await unlockPayload(parsed.payload, password);
	unlocked.dek.fill(0);
	return {
		isProtected: true,
		decoyBody: parsed.decoyBody,
		realText: unlocked.realText,
		realTitle: unlocked.realTitle,
		payload: parsed.payload,
	};
}

export interface ViewUnloadHarnessOptions {
	readonly defaultNativeSaveMode?: NativeSaveMode;
	readonly hooks?: Partial<SessionHooks>;
	readonly triggerPrefix?: () => string;
	readonly unlockBlockReason?: () => string | null;
	readonly onModifyStart?: (path: string, content: string, seq: number) => void;
	readonly modifyGateForPath?: (path: string, seq: number) => Promise<void> | null;
	readonly shouldFailModify?: (path: string, seq: number) => Error | null;
	readonly onNativeSaveStart?: (info: {
		readonly view: MarkdownView;
		readonly path: string;
		readonly mode: NativeSaveMode;
		readonly clear: boolean | undefined;
		readonly seq: number;
	}) => void;
	readonly nativeSaveGateForPath?: (path: string, seq: number) => Promise<void> | null;
	readonly shouldFailNativeSave?: (path: string, seq: number) => Error | null;
	readonly shouldFailNativeSetter?: (
		view: MarkdownView,
		data: string,
		clear: boolean | undefined,
	) => Error | null;
	readonly readBinaryGate?: Promise<void>;
	readonly rawImageBytes?: Uint8Array;
}

export interface SeededProtectedNote {
	readonly file: TFile;
	readonly pane: MockPane;
	readonly session: ViewSession;
	readonly createdPayload: PayloadV1;
	readonly initialFileContent: string;
	readonly parsed: ParsedFile;
}

export interface ViewUnloadHarness {
	readonly app: App;
	readonly sessions: SessionManager;
	readonly disk: Map<string, string>;
	readonly writes: RecordedWrite[];
	readonly nativeSetCalls: RecordedNativeSet[];
	readonly writeTrace: string[];
	readonly deletedImages: string[];
	readonly panes: MockPane[];
	readonly patchCleanups: Array<() => void>;
	readonly patchController: ViewPatchController;
	readonly rawNativeSetViewData: (this: MarkdownView, data: string, clear?: boolean) => void;
	readonly rawNativeGetViewData: (this: MarkdownView) => string;
	readonly rawNativeSave: (this: MarkdownView, clear?: boolean) => Promise<void>;
	readonly createPane: (
		file?: TFile,
		initialContent?: string,
		saveMode?: NativeSaveMode,
	) => MockPane;
	readonly seedProtectedNote: (options?: {
		readonly path?: string;
		readonly decoyBody?: string;
		readonly realText?: string;
		readonly password?: string;
		readonly realTitle?: string;
		readonly saveMode?: NativeSaveMode;
		readonly existingFile?: TFile;
	}) => Promise<SeededProtectedNote>;
	readonly stageCompletedPendingPayload: (
		session: ViewSession,
		nextRealText: string,
		nextRealTitle?: string | null,
	) => Promise<PayloadV1>;
	readonly unloadPatches: () => void;
	readonly restorePrototype: () => void;
}

interface InternalPaneState {
	editorText: string;
	backingData: string;
	file: TFile | null;
	saveMode: NativeSaveMode;
	readonly undoHistory: string[];
	readonly inlineTitleEl: { textContent: string };
	readonly headerTitleEl: { textContent: string };
	readonly tabHeaderTitleEl: { textContent: string };
	requestSaveCount: number;
	cmDispatchCount: number;
}

/**
 * Builds an isolated view-patch + `SessionManager` test harness with realistic
 * native `MarkdownView.prototype` methods (`setViewData`, `getViewData`, `save`),
 * two selectable native save modes (`"recompute"` and `"backing-data"`),
 * undo history tracking, title DOM elements, and deterministic I/O gates.
 */
export function createViewUnloadHarness(options?: ViewUnloadHarnessOptions): ViewUnloadHarness {
	const defaultMode: NativeSaveMode = options?.defaultNativeSaveMode ?? "recompute";
	const disk = new Map<string, string>();
	const writes: RecordedWrite[] = [];
	const nativeSetCalls: RecordedNativeSet[] = [];
	const writeTrace: string[] = [];
	const deletedImages: string[] = [];
	const panes: MockPane[] = [];
	const paneStateByView = new WeakMap<MarkdownView, InternalPaneState>();
	const filesByPath = new Map<string, TFile>();
	const rawImageBytes = options?.rawImageBytes ?? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	let seqCounter = 0;
	let activeView: MarkdownView | null = null;

	const proto = MarkdownView.prototype as unknown as {
		setViewData: (this: MarkdownView, data: string, clear: boolean) => void;
		getViewData: (this: MarkdownView) => string;
		save: (this: MarkdownView, clear?: boolean) => Promise<void>;
	};
	const savedProto = {
		setViewData: proto.setViewData,
		getViewData: proto.getViewData,
		save: proto.save,
	};

	const rawNativeSetViewData = function (
		this: MarkdownView,
		data: string,
		clear?: boolean,
	): void {
		const seq = ++seqCounter;
		const state = paneStateByView.get(this);
		const path = state?.file?.path ?? (this as unknown as { file?: TFile | null }).file?.path ?? "";
		nativeSetCalls.push({
			seq,
			view: this,
			path,
			data,
			clear,
		});
		const failure = options?.shouldFailNativeSetter?.(this, data, clear) ?? null;
		if (failure !== null) {
			throw failure;
		}
		if (state) {
			if (clear === true) {
				state.undoHistory.length = 0;
			} else if (state.editorText !== data) {
				state.undoHistory.push(state.editorText);
			}
			state.editorText = data;
			state.backingData = data;
		}
		(this as unknown as { data: string }).data = data;
	};

	const rawNativeGetViewData = function (this: MarkdownView): string {
		const state = paneStateByView.get(this);
		if (state) {
			return state.editorText;
		}
		const editor = (this as unknown as { editor?: { getValue: () => string } }).editor;
		return editor ? editor.getValue() : ((this as unknown as { data?: string }).data ?? "");
	};

	const rawNativeSave = async function (this: MarkdownView, clear?: boolean): Promise<void> {
		const seq = ++seqCounter;
		const state = paneStateByView.get(this);
		const currentFile =
			state?.file ?? (this as unknown as { file?: TFile | null }).file ?? null;
		const path = currentFile?.path ?? "";
		const mode = state?.saveMode ?? defaultMode;
		writeTrace.push(`native-save:start:${path}:${mode}`);
		options?.onNativeSaveStart?.({
			view: this,
			path,
			mode,
			clear,
			seq,
		});
		const gate = options?.nativeSaveGateForPath?.(path, seq) ?? null;
		if (gate !== null) {
			await gate;
		}
		const failure = options?.shouldFailNativeSave?.(path, seq) ?? null;
		if (failure !== null) {
			writeTrace.push(`native-save:error:${path}:${mode}`);
			throw failure;
		}
		let contentToPersist: string;
		if (mode === "recompute") {
			const recomputed = this.getViewData();
			(this as unknown as { data: string }).data = recomputed;
			if (state) {
				state.backingData = recomputed;
			}
			contentToPersist = recomputed;
		} else {
			contentToPersist = (this as unknown as { data?: string }).data ?? state?.backingData ?? "";
		}
		if (clear === true && state) {
			state.undoHistory.length = 0;
		}
		if (path.length > 0) {
			disk.set(path, contentToPersist);
		}
		writes.push({
			seq,
			source: "native-save",
			path,
			content: contentToPersist,
			clear,
			mode,
		});
		writeTrace.push(`native-save:commit:${path}:${mode}`);
	};

	proto.setViewData = rawNativeSetViewData;
	proto.getViewData = rawNativeGetViewData;
	proto.save = rawNativeSave;

	const fakeImageFile = makeMockFile("Pasted chart.png");

	const app: App = Object.assign(Object.create(null), {
		workspace: {
			getActiveFile: () =>
				activeView
					? ((activeView as unknown as { file?: TFile | null }).file ?? null)
					: (panes[0]?.file ?? null),
			getActiveViewOfType: () => activeView ?? panes[0]?.view ?? null,
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				for (const pane of panes) {
					cb({ view: pane.view });
				}
			},
			on: () => ({ id: "workspace-event" }),
		},
		fileManager: {
			renameFile: async (file: TFile, newPath: string) => {
				const oldPath = file.path;
				const existing = disk.get(oldPath);
				if (existing !== undefined) {
					disk.delete(oldPath);
					disk.set(newPath, existing);
				}
				filesByPath.delete(oldPath);
				const name = newPath.split("/").pop() ?? newPath;
				const dotIndex = name.lastIndexOf(".");
				(file as unknown as { path: string; name: string; basename: string }).path = newPath;
				(file as unknown as { path: string; name: string; basename: string }).name = name;
				(file as unknown as { path: string; name: string; basename: string }).basename =
					dotIndex > 0 ? name.slice(0, dotIndex) : name;
				filesByPath.set(newPath, file);
			},
		},
		metadataCache: {
			getFirstLinkpathDest: (link: string) =>
				link === "Pasted chart.png" ? fakeImageFile : (filesByPath.get(link) ?? null),
		},
		vault: {
			getAbstractFileByPath: (targetPath: string) => filesByPath.get(targetPath) ?? null,
			read: async (file: { readonly path: string }) => disk.get(file.path) ?? "",
			cachedRead: async (file: { readonly path: string }) => disk.get(file.path) ?? "",
			readBinary: async () => {
				if (options?.readBinaryGate) {
					await options.readBinaryGate;
				}
				return rawImageBytes.buffer.slice(0);
			},
			delete: async (file: { readonly path: string }) => {
				deletedImages.push(file.path);
				disk.delete(file.path);
			},
			modify: async (file: { readonly path: string }, content: string) => {
				const seq = ++seqCounter;
				writeTrace.push(`vault.modify:start:${file.path}`);
				options?.onModifyStart?.(file.path, content, seq);
				const gate = options?.modifyGateForPath?.(file.path, seq) ?? null;
				if (gate !== null) {
					await gate;
				}
				const failure = options?.shouldFailModify?.(file.path, seq) ?? null;
				if (failure !== null) {
					writeTrace.push(`vault.modify:error:${file.path}`);
					throw failure;
				}
				disk.set(file.path, content);
				writes.push({
					seq,
					source: "vault.modify",
					path: file.path,
					content,
					clear: undefined,
					mode: undefined,
				});
				writeTrace.push(`vault.modify:commit:${file.path}`);
			},
			adapter: {
				remove: async (targetPath: string) => {
					disk.delete(targetPath);
				},
			},
			on: () => ({ id: "vault-event" }),
		},
	}) as unknown as App;

	const hooks: SessionHooks = {
		onUnlocked: options?.hooks?.onUnlocked ?? (() => undefined),
		onLocked: options?.hooks?.onLocked ?? (() => undefined),
		onUnlockBlocked: options?.hooks?.onUnlockBlocked ?? (() => undefined),
		...(options?.hooks?.onLockFailed ? { onLockFailed: options.hooks.onLockFailed } : {}),
	};

	const sessions = new SessionManager(
		app,
		hooks,
		options?.triggerPrefix ?? (() => ";;"),
		options?.unlockBlockReason ?? (() => null),
	);

	const patchCleanups: Array<() => void> = [];
	const patchController: ViewPatchController = installViewPatches(sessions, (cleanup) => {
		patchCleanups.push(cleanup);
	});

	const createPane = (
		file: TFile = makeMockFile("Weekend Grocery List.md"),
		initialContent = DEFAULT_DECOY,
		saveMode: NativeSaveMode = defaultMode,
	): MockPane => {
		filesByPath.set(file.path, file);
		const inlineTitleEl = { textContent: file.basename };
		const headerTitleEl = { textContent: file.basename };
		const tabHeaderTitleEl = { textContent: file.basename };
		const state: InternalPaneState = {
			editorText: initialContent,
			backingData: initialContent,
			file,
			saveMode,
			undoHistory: [],
			inlineTitleEl,
			headerTitleEl,
			tabHeaderTitleEl,
			requestSaveCount: 0,
			cmDispatchCount: 0,
		};

		const view = Object.create(MarkdownView.prototype) as MarkdownView;
		paneStateByView.set(view, state);

		Object.defineProperty(view, "file", {
			get: () => state.file,
			set: (next: TFile | null) => {
				state.file = next;
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(view, "data", {
			get: () => state.backingData,
			set: (next: string) => {
				state.backingData = next;
			},
			configurable: true,
			enumerable: true,
		});

		const editor = {
			getValue: () => state.editorText,
			setValue: (next: string) => {
				state.editorText = next;
			},
			cm: {
				state: {},
				dispatch: () => {
					state.cmDispatchCount += 1;
				},
			},
		};

		const containerEl = {
			querySelector: (selector: string) => {
				if (selector === ".inline-title") return state.inlineTitleEl;
				if (selector === ".view-header-title") return state.headerTitleEl;
				return null;
			},
		};

		const leaf = {
			view,
			tabHeaderInnerTitleEl: state.tabHeaderTitleEl,
		};

		Object.assign(view, {
			editor,
			containerEl,
			leaf,
			requestSave: () => {
				state.requestSaveCount += 1;
			},
		});

		const pane: MockPane = {
			view,
			get file() {
				return state.file;
			},
			set file(next: TFile | null) {
				state.file = next;
			},
			getEditorText: () => state.editorText,
			setEditorText: (next: string) => {
				state.editorText = next;
			},
			typeInEditor: (next: string) => {
				if (state.editorText !== next) {
					state.undoHistory.push(state.editorText);
				}
				state.editorText = next;
			},
			getBackingData: () => state.backingData,
			setBackingData: (next: string) => {
				state.backingData = next;
			},
			undoHistory: state.undoHistory,
			inlineTitleEl: state.inlineTitleEl,
			headerTitleEl: state.headerTitleEl,
			tabHeaderTitleEl: state.tabHeaderTitleEl,
			getDisplayedTitles: () => ({
				inline: state.inlineTitleEl.textContent,
				header: state.headerTitleEl.textContent,
				tab: state.tabHeaderTitleEl.textContent,
			}),
			getRequestSaveCount: () => state.requestSaveCount,
			getCmDispatchCount: () => state.cmDispatchCount,
			switchFile: (nextFile: TFile | null) => {
				if (nextFile) {
					filesByPath.set(nextFile.path, nextFile);
					state.inlineTitleEl.textContent = nextFile.basename;
					state.headerTitleEl.textContent = nextFile.basename;
					state.tabHeaderTitleEl.textContent = nextFile.basename;
				}
				state.file = nextFile;
			},
			setNativeSaveMode: (mode: NativeSaveMode) => {
				state.saveMode = mode;
			},
			getNativeSaveMode: () => state.saveMode,
		};

		panes.push(pane);
		if (activeView === null) {
			activeView = view;
		}
		return pane;
	};

	const seedProtectedNote: ViewUnloadHarness["seedProtectedNote"] = async (seedOptions) => {
		const path = seedOptions?.path ?? "Weekend Grocery List.md";
		const decoyBody = seedOptions?.decoyBody ?? DEFAULT_DECOY;
		const realText = seedOptions?.realText ?? SECRET_P0;
		const password = seedOptions?.password ?? TEST_PASSWORD;
		const realTitle = seedOptions?.realTitle ?? SECRET_REAL_TITLE;
		const saveMode = seedOptions?.saveMode ?? defaultMode;
		const file = seedOptions?.existingFile ?? makeMockFile(path);
		filesByPath.set(file.path, file);

		const created = await createFile(
			realText,
			password,
			decoyBody,
			undefined,
			undefined,
			realTitle,
		);
		const parsed = parseFileContent(created.fileContent);
		if (parsed === null) {
			throw new Error("Failed to parse freshly created protected note fixture");
		}
		disk.set(file.path, created.fileContent);

		const pane = createPane(file, decoyBody, saveMode);
		pane.view.setViewData(created.fileContent, true);
		const session = sessions.get(pane.view);
		if (session === null) {
			throw new Error("Expected patched setViewData to attach a ViewSession");
		}

		return {
			file,
			pane,
			session,
			createdPayload: created.payload,
			initialFileContent: created.fileContent,
			parsed,
		};
	};

	const stageCompletedPendingPayload: ViewUnloadHarness["stageCompletedPendingPayload"] = async (
		session,
		nextRealText,
		nextRealTitle,
	) => {
		if (!session.dek) {
			throw new Error("Cannot reencrypt pending payload on a locked session without a DEK");
		}
		const pane = panes.find((p) => p.view === session.view);
		if (pane) {
			pane.typeInEditor(nextRealText);
			if (nextRealTitle !== undefined && nextRealTitle !== null) {
				pane.inlineTitleEl.textContent = nextRealTitle;
			}
		}
		const updatedPayload = await reencryptRealText(
			session.originalPayload,
			session.dek,
			nextRealText,
			session.originalPayload.images,
			nextRealTitle !== undefined ? nextRealTitle : session.realTitle,
		);
		session.pendingPayload = updatedPayload;
		if (nextRealTitle !== undefined) {
			session.realTitle = nextRealTitle;
		}
		return updatedPayload;
	};

	/**
	 * Adapter supporting both `nativeSetViewData.call(view, fullRaw, true)` and
	 * `nativeSetViewData(view, fullRaw, true)` invocation conventions.
	 */
	const nativeSetterAdapter = function (
		this: unknown,
		firstArg: MarkdownView | string,
		secondArg?: string | boolean,
		thirdArg?: boolean,
	): void {
		if (typeof firstArg === "string") {
			rawNativeSetViewData.call(this as MarkdownView, firstArg, Boolean(secondArg));
			return;
		}
		const data = typeof secondArg === "string" ? secondArg : "";
		rawNativeSetViewData.call(firstArg, data, Boolean(thirdArg));
	};

	const unloadPatches = (): void => {
		for (const cleanup of patchCleanups) {
			cleanup();
		}
		const maybeSessionShutdown = (
			sessions as unknown as {
				shutdownAndHandoff?: (setter: typeof nativeSetterAdapter) => unknown;
			}
		).shutdownAndHandoff;
		if (typeof maybeSessionShutdown === "function") {
			maybeSessionShutdown.call(sessions, nativeSetterAdapter);
		}
	};

	const restorePrototype = (): void => {
		proto.setViewData = savedProto.setViewData;
		proto.getViewData = savedProto.getViewData;
		proto.save = savedProto.save;
		sessions.getCoordinator().resetAllState();
		const holder = MarkdownView.prototype as unknown as Record<symbol, unknown>;
		delete holder[VIEW_LIFECYCLE_SYMBOL];
	};

	return {
		app,
		sessions,
		disk,
		writes,
		nativeSetCalls,
		writeTrace,
		deletedImages,
		panes,
		patchCleanups,
		patchController,
		rawNativeSetViewData,
		rawNativeGetViewData,
		rawNativeSave,
		createPane,
		seedProtectedNote,
		stageCompletedPendingPayload,
		unloadPatches,
		restorePrototype,
	};
}

export interface PluginLikeInstance {
	app: App;
	settings: VeneerSettings;
	registry: ProtectedRegistry;
	sessions: SessionManager;
	lockEngine: LockEngine;
	register: (cb: () => void) => void;
	onunload: () => void;
}

export interface PluginUnloadHarnessOptions extends ViewUnloadHarnessOptions {
	readonly generatorUnloadGate?: Promise<void>;
	readonly generatorUnloadError?: Error;
	readonly omitLockEngine?: boolean;
	readonly omitGenerator?: boolean;
	readonly omitStatusWidgets?: boolean;
}

export interface PluginUnloadHarness extends ViewUnloadHarness {
	readonly plugin: PluginLikeInstance;
	readonly registeredCleanups: Array<() => void>;
	readonly lockEngineStopCalls: () => number;
	readonly generatorUnloadCalls: () => number;
	readonly dotsResetCalls: () => number;
	readonly wordCounterHideCalls: () => number;
	readonly unloadPlugin: (order?: UnloadCallbackOrder) => void;
}

/**
 * Wraps `createViewUnloadHarness` around a real `VeneerPlugin` prototype instance
 * so `plugin.onunload()` and `plugin.register(cleanup)` can be exercised in both
 * host callback orders (`"onunload-first"` and `"cleanup-first"`), as well as
 * under partial-startup conditions.
 */
export function createPluginUnloadHarness<TPlugin extends PluginLikeInstance>(
	PluginCtor: { readonly prototype: TPlugin },
	options?: PluginUnloadHarnessOptions,
): PluginUnloadHarness {
	const base = createViewUnloadHarness(options);
	const registeredCleanups: Array<() => void> = [];
	for (const cleanup of base.patchCleanups) {
		registeredCleanups.push(cleanup);
	}

	let lockEngineStops = 0;
	let generatorUnloads = 0;
	let dotsResets = 0;
	let wordCounterHides = 0;

	const plugin = Object.create(PluginCtor.prototype) as TPlugin;
	plugin.app = base.app;
	plugin.settings = { ...DEFAULT_SETTINGS };
	plugin.sessions = base.sessions;
	plugin.register = (cb: () => void): void => {
		registeredCleanups.push(cb);
	};

	const pluginWithData = plugin as unknown as {
		loadData: () => Promise<unknown>;
		saveData: (data: unknown) => Promise<void>;
		dots?: { reset: () => void; setDots: (len: number) => void };
		wordCounter?: { hide: () => void; update: (text: string, state: string) => void };
		generator?: {
			generate: () => Promise<{ text: string; source: "template" }>;
			unload: () => Promise<void>;
		};
		patchController?: unknown;
		viewPatchController?: unknown;
	};
	pluginWithData.loadData = async () => null;
	pluginWithData.saveData = async () => undefined;
	plugin.registry = new ProtectedRegistry(plugin as unknown as never);

	if (base.patchController !== undefined) {
		pluginWithData.patchController = base.patchController;
		pluginWithData.viewPatchController = base.patchController;
	}

	if (!options?.omitStatusWidgets) {
		pluginWithData.dots = {
			reset: () => {
				dotsResets += 1;
			},
			setDots: () => undefined,
		};
		pluginWithData.wordCounter = {
			hide: () => {
				wordCounterHides += 1;
			},
			update: () => undefined,
		};
	}

	if (!options?.omitLockEngine) {
		const realLockEngine = new LockEngine(
			plugin as unknown as never,
			base.app.workspace,
			base.sessions,
			() => plugin.settings,
		);
		const origStop = realLockEngine.stop.bind(realLockEngine);
		realLockEngine.stop = (): void => {
			lockEngineStops += 1;
			origStop();
		};
		plugin.lockEngine = realLockEngine;
	}

	if (!options?.omitGenerator) {
		pluginWithData.generator = {
			generate: async () => ({
				text: `${DEFAULT_DECOY}\n`,
				source: "template",
			}),
			unload: async () => {
				generatorUnloads += 1;
				if (options?.generatorUnloadGate) {
					await options.generatorUnloadGate;
				}
				if (options?.generatorUnloadError) {
					throw options.generatorUnloadError;
				}
			},
		};
	}

	const unloadPlugin = (order: UnloadCallbackOrder = "onunload-first"): void => {
		if (order === "onunload-first") {
			plugin.onunload();
			for (const cleanup of registeredCleanups) {
				cleanup();
			}
			return;
		}
		for (const cleanup of registeredCleanups) {
			cleanup();
		}
		plugin.onunload();
	};

	return {
		...base,
		plugin,
		registeredCleanups,
		lockEngineStopCalls: () => lockEngineStops,
		generatorUnloadCalls: () => generatorUnloads,
		dotsResetCalls: () => dotsResets,
		wordCounterHideCalls: () => wordCounterHides,
		unloadPlugin,
		serializeFile,
	} as PluginUnloadHarness;
}
