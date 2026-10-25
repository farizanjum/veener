import Module from "module";
import { MarkdownView, type Plugin, type Workspace } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_THROTTLE_MS, LockEngine } from "../src/lock/LockEngine";
import * as powerModule from "../src/lock/power";
import { setContentProtection, wirePowerMonitor } from "../src/lock/power";
import { ProtectedRegistry } from "../src/registry";
import { DEFAULT_SETTINGS, type VeneerSettings } from "../src/settings";
import { executeShred } from "../src/shred/duress";
import type { SessionManager, ViewSession } from "../src/view/session";

type ElectronMockMode =
	| "working"
	| "absent-module"
	| "absent-remote"
	| "scoped-remote-only"
	| "empty-legacy-remote-with-scoped-fallback"
	| "split-capabilities"
	| "off-only-listener"
	| "no-remove-listener";

interface MockPowerMonitor {
	readonly listeners: Map<string, Set<() => void>>;
	readonly on: ReturnType<typeof vi.fn>;
	readonly removeListener: ReturnType<typeof vi.fn>;
	readonly off: ReturnType<typeof vi.fn>;
	readonly emit: (event: string) => void;
}

interface MockDefaultSession {
	readonly clearCache: ReturnType<typeof vi.fn<() => Promise<void>>>;
	readonly clearStorageData: ReturnType<
		typeof vi.fn<(options?: { storages?: string[] }) => Promise<void>>
	>;
}

interface MockBrowserWindow {
	readonly setContentProtection: ReturnType<typeof vi.fn<(protect: boolean) => void>>;
}

interface MockElectronBridge {
	readonly powerMonitor: MockPowerMonitor;
	readonly defaultSession: MockDefaultSession;
	readonly browserWindow: MockBrowserWindow;
	readonly getCurrentWindow: ReturnType<typeof vi.fn<() => MockBrowserWindow | null>>;
	readonly storageSentinels: Map<string, string>;
	readonly restore: () => void;
}

/** Installs a configurable `electron` and `@electron/remote` CJS module mock and returns spies and storage sentinels. */
function installElectronMock(options?: {
	readonly mode?: ElectronMockMode;
	readonly throwOnContentProtection?: boolean;
	readonly throwOnGetCurrentWindow?: boolean;
	readonly throwOnPowerMonitorOn?: boolean;
	readonly throwOnPowerMonitorRemove?: boolean;
	readonly nullWindow?: boolean;
}): MockElectronBridge {
	const mode = options?.mode ?? "working";
	const storageSentinels = new Map<string, string>([
		["obsidian:workspace-layout", "preserved-workspace-state"],
		["community-plugin:dataview-cache", "preserved-plugin-index"],
		["indexeddb:app://obsidian.md", "preserved-origin-idb"],
	]);

	const listeners = new Map<string, Set<() => void>>();
	const on = vi.fn((event: string, listener: () => void) => {
		if (options?.throwOnPowerMonitorOn) {
			throw new Error("powerMonitor.on failed");
		}
		let bucket = listeners.get(event);
		if (!bucket) {
			bucket = new Set();
			listeners.set(event, bucket);
		}
		bucket.add(listener);
	});
	const removeListener = vi.fn((event: string, listener: () => void) => {
		if (options?.throwOnPowerMonitorRemove) {
			throw new Error("powerMonitor.removeListener failed");
		}
		listeners.get(event)?.delete(listener);
	});
	const off = vi.fn((event: string, listener: () => void) => {
		if (options?.throwOnPowerMonitorRemove) {
			throw new Error("powerMonitor.off failed");
		}
		listeners.get(event)?.delete(listener);
	});
	const powerMonitor: MockPowerMonitor = {
		listeners,
		on,
		removeListener,
		off,
		emit: (event: string) => {
			for (const listener of listeners.get(event) ?? []) {
				listener();
			}
		},
	};

	const clearCache = vi.fn(async () => {
		storageSentinels.delete("obsidian:workspace-layout");
	});
	const clearStorageData = vi.fn(async (_opts?: { storages?: string[] }) => {
		storageSentinels.clear();
	});
	const defaultSession: MockDefaultSession = {
		clearCache,
		clearStorageData,
	};

	const setProtectionSpy = vi.fn((_protect: boolean) => {
		if (options?.throwOnContentProtection) {
			throw new Error("window destroyed");
		}
	});
	const browserWindow: MockBrowserWindow = {
		setContentProtection: setProtectionSpy,
	};
	const getCurrentWindow = vi.fn(() => {
		if (options?.throwOnGetCurrentWindow) {
			throw new Error("getCurrentWindow failed");
		}
		return options?.nullWindow ? null : browserWindow;
	});

	const monitorObj =
		mode === "no-remove-listener"
			? { on: powerMonitor.on }
			: mode === "off-only-listener"
				? { on: powerMonitor.on, off: powerMonitor.off }
				: { on: powerMonitor.on, removeListener: powerMonitor.removeListener };

	const moduleCtor = Module as unknown as {
		_load: (request: string, parent: unknown, isMain: boolean) => unknown;
	};
	const originalLoad = moduleCtor._load;

	moduleCtor._load = function (request: string, parent: unknown, isMain: boolean): unknown {
		if (request === "electron") {
			if (mode === "absent-module") {
				throw new Error("Cannot find module 'electron'");
			}
			if (mode === "absent-remote" || mode === "scoped-remote-only") {
				return {};
			}
			if (mode === "empty-legacy-remote-with-scoped-fallback") {
				return { remote: {} };
			}
			if (mode === "split-capabilities") {
				return {
					remote: {
						powerMonitor: monitorObj,
					},
				};
			}
			return {
				remote: {
					powerMonitor: monitorObj,
					getCurrentWindow,
					session: {
						defaultSession,
					},
				},
			};
		}
		if (request === "@electron/remote") {
			if (mode === "scoped-remote-only") {
				return {
					powerMonitor: monitorObj,
					getCurrentWindow,
					session: {
						defaultSession,
					},
				};
			}
			if (mode === "empty-legacy-remote-with-scoped-fallback") {
				return {
					powerMonitor: monitorObj,
					getCurrentWindow,
				};
			}
			if (mode === "split-capabilities") {
				return {
					getCurrentWindow,
				};
			}
			throw new Error("Cannot find module '@electron/remote'");
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	return {
		powerMonitor,
		defaultSession,
		browserWindow,
		getCurrentWindow,
		storageSentinels,
		restore: () => {
			moduleCtor._load = originalLoad;
		},
	};
}

describe("Electron power/content-protection bridge and absence of host-wide storage clearing (Issue #13)", () => {
	let activeBridge: MockElectronBridge | null = null;

	afterEach(() => {
		activeBridge?.restore();
		activeBridge = null;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("exposes no clearWebStorage helper on the power module surface", () => {
		expect("clearWebStorage" in powerModule).toBe(false);
		expect(Object.keys(powerModule).sort()).toEqual([
			"setContentProtection",
			"wirePowerMonitor",
		]);
	});

	it("never invokes defaultSession.clearCache or clearStorageData during shred even when a working Electron bridge is present", async () => {
		const bridge = installElectronMock({ mode: "working" });
		activeBridge = bridge;

		// Positive control: prove the mocked Electron bridge is actually reachable by power.ts
		expect(setContentProtection(true)).toBe(true);
		expect(bridge.browserWindow.setContentProtection).toHaveBeenCalledTimes(1);
		expect(bridge.browserWindow.setContentProtection).toHaveBeenCalledWith(true);

		const powerEvents: number[] = [];
		const detachPower = wirePowerMonitor(() => powerEvents.push(1));
		bridge.powerMonitor.emit("lock-screen");
		expect(powerEvents).toHaveLength(1);
		detachPower();

		// Full executeShred run with both portable and stealth targets
		const calls: string[] = [];
		const report = await executeShred(
			[
				{ path: "note-a.md", mode: "portable" },
				{ path: "note-b.enc", mode: "stealth" },
			],
			{
				zeroSessions: () => {
					calls.push("zero");
				},
				rewritePortable: async (path) => {
					calls.push(`rewrite:${path}`);
				},
				deleteStealth: async (path) => {
					calls.push(`delete:${path}`);
				},
				clearRegistry: async () => {
					calls.push("registry");
				},
			},
		);

		expect(report.processed).toBe(2);
		expect(report.failures).toEqual([]);
		expect(report.steps).toEqual([
			"zero-memory",
			"rewrite:note-a.md",
			"delete:note-b.enc",
			"clear-registry",
		]);
		expect(calls).toEqual(["zero", "rewrite:note-a.md", "delete:note-b.enc", "registry"]);

		// Destructive host-wide Electron session APIs are never touched
		expect(bridge.defaultSession.clearCache).not.toHaveBeenCalled();
		expect(bridge.defaultSession.clearStorageData).not.toHaveBeenCalled();
		expect(bridge.storageSentinels.get("obsidian:workspace-layout")).toBe(
			"preserved-workspace-state",
		);
		expect(bridge.storageSentinels.get("community-plugin:dataview-cache")).toBe(
			"preserved-plugin-index",
		);
		expect(bridge.storageSentinels.get("indexeddb:app://obsidian.md")).toBe(
			"preserved-origin-idb",
		);
	});

	it("preserves storage sentinels and leaves defaultSession untouched when a shred target fails", async () => {
		const bridge = installElectronMock({ mode: "working" });
		activeBridge = bridge;

		// Positive control: prove the mocked Electron bridge is live
		expect(setContentProtection(false)).toBe(true);
		expect(bridge.browserWindow.setContentProtection).toHaveBeenCalledWith(false);

		const calls: string[] = [];
		const report = await executeShred(
			[
				{ path: "failing.md", mode: "portable" },
				{ path: "surviving.md", mode: "portable" },
				{ path: "stealth.enc", mode: "stealth" },
			],
			{
				zeroSessions: () => {
					calls.push("zero");
				},
				rewritePortable: async (path) => {
					if (path === "failing.md") {
						throw new Error("EACCES: permission denied");
					}
					calls.push(`rewrite:${path}`);
				},
				deleteStealth: async (path) => {
					calls.push(`delete:${path}`);
				},
				clearRegistry: async () => {
					calls.push("registry");
				},
			},
		);

		expect(report.processed).toBe(2);
		expect(report.failures).toEqual([
			{ path: "failing.md", error: "Error: EACCES: permission denied" },
		]);
		expect(report.steps).toEqual([
			"zero-memory",
			"failed:failing.md",
			"rewrite:surviving.md",
			"delete:stealth.enc",
			"clear-registry",
		]);
		expect(calls).toEqual([
			"zero",
			"rewrite:surviving.md",
			"delete:stealth.enc",
			"registry",
		]);
		expect(bridge.defaultSession.clearCache).not.toHaveBeenCalled();
		expect(bridge.defaultSession.clearStorageData).not.toHaveBeenCalled();
		expect(bridge.storageSentinels.size).toBe(3);
	});

	it("registers and removes all four powerMonitor event listeners when Electron remote is present", () => {
		const bridge = installElectronMock({ mode: "working" });
		activeBridge = bridge;

		let count = 0;
		const cleanup = wirePowerMonitor(() => {
			count += 1;
		});

		expect(bridge.powerMonitor.on).toHaveBeenCalledTimes(4);
		for (const event of ["suspend", "resume", "lock-screen", "unlock-screen"]) {
			expect(bridge.powerMonitor.listeners.get(event)?.size).toBe(1);
			bridge.powerMonitor.emit(event);
		}
		expect(count).toBe(4);

		cleanup();
		expect(bridge.powerMonitor.removeListener).toHaveBeenCalledTimes(4);
		for (const event of ["suspend", "resume", "lock-screen", "unlock-screen"]) {
			expect(bridge.powerMonitor.listeners.get(event)?.size).toBe(0);
			bridge.powerMonitor.emit(event);
		}
		expect(count).toBe(4);
	});

	it("degrades gracefully when Electron is absent, remote is missing, or window calls throw", () => {
		const absentModule = installElectronMock({ mode: "absent-module" });
		activeBridge = absentModule;
		const noopCleanup1 = wirePowerMonitor(() => undefined);
		expect(() => noopCleanup1()).not.toThrow();
		expect(setContentProtection(true)).toBe(false);
		absentModule.restore();

		const absentRemote = installElectronMock({ mode: "absent-remote" });
		activeBridge = absentRemote;
		const noopCleanup2 = wirePowerMonitor(() => undefined);
		expect(() => noopCleanup2()).not.toThrow();
		expect(setContentProtection(true)).toBe(false);
		absentRemote.restore();

		const nullWinBridge = installElectronMock({ mode: "no-remove-listener", nullWindow: true });
		activeBridge = nullWinBridge;
		const cleanupNoRemove = wirePowerMonitor(() => undefined);
		expect(() => cleanupNoRemove()).not.toThrow();
		expect(setContentProtection(true)).toBe(false);
		nullWinBridge.restore();

		const throwingWinBridge = installElectronMock({
			mode: "working",
			throwOnContentProtection: true,
		});
		activeBridge = throwingWinBridge;
		expect(setContentProtection(true)).toBe(false);
	});

	it("resolves @electron/remote when require('electron').remote is undefined (scoped-remote-only)", () => {
		const bridge = installElectronMock({ mode: "scoped-remote-only" });
		activeBridge = bridge;

		const received: string[] = [];
		const cleanup = wirePowerMonitor(() => {
			received.push("power");
		});

		expect(bridge.powerMonitor.on).toHaveBeenCalledTimes(4);
		for (const event of ["suspend", "resume", "lock-screen", "unlock-screen"]) {
			expect(bridge.powerMonitor.listeners.get(event)?.size).toBe(1);
			bridge.powerMonitor.emit(event);
		}
		expect(received).toHaveLength(4);

		expect(setContentProtection(true)).toBe(true);
		expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(true);
		expect(setContentProtection(false)).toBe(true);
		expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(false);

		cleanup();
		expect(bridge.powerMonitor.removeListener).toHaveBeenCalledTimes(4);
		for (const event of ["suspend", "resume", "lock-screen", "unlock-screen"]) {
			expect(bridge.powerMonitor.listeners.get(event)?.size).toBe(0);
			bridge.powerMonitor.emit(event);
		}
		expect(received).toHaveLength(4);
	});

	it("falls back per capability across empty or partial electron.remote and @electron/remote", () => {
		const emptyLegacyBridge = installElectronMock({
			mode: "empty-legacy-remote-with-scoped-fallback",
		});
		activeBridge = emptyLegacyBridge;

		let emptyLegacyEvents = 0;
		const cleanupEmptyLegacy = wirePowerMonitor(() => {
			emptyLegacyEvents += 1;
		});
		emptyLegacyBridge.powerMonitor.emit("lock-screen");
		expect(emptyLegacyEvents).toBe(1);
		expect(setContentProtection(true)).toBe(true);
		expect(emptyLegacyBridge.browserWindow.setContentProtection).toHaveBeenCalledWith(true);
		cleanupEmptyLegacy();
		expect(emptyLegacyBridge.powerMonitor.removeListener).toHaveBeenCalledTimes(4);
		emptyLegacyBridge.restore();

		const splitBridge = installElectronMock({ mode: "split-capabilities" });
		activeBridge = splitBridge;

		let splitEvents = 0;
		const cleanupSplit = wirePowerMonitor(() => {
			splitEvents += 1;
		});
		splitBridge.powerMonitor.emit("suspend");
		expect(splitEvents).toBe(1);
		expect(setContentProtection(true)).toBe(true);
		expect(splitBridge.browserWindow.setContentProtection).toHaveBeenCalledWith(true);
		cleanupSplit();
		expect(splitBridge.powerMonitor.removeListener).toHaveBeenCalledTimes(4);
	});

	it("handles throwing electron.remote getters and falls back to @electron/remote and BrowserWindow.getAllWindows", () => {
		const moduleCtor = Module as unknown as {
			_load: (request: string, parent: unknown, isMain: boolean) => unknown;
		};
		const originalLoad = moduleCtor._load;
		const setProtectionSpy = vi.fn();
		const onSpy = vi.fn();
		const removeSpy = vi.fn();

		let useGetAllWindowsOnly = false;
		moduleCtor._load = function (request: string, parent: unknown, isMain: boolean): unknown {
			if (request === "electron") {
				const electronExport: Record<string, unknown> = {};
				Object.defineProperty(electronExport, "remote", {
					get() {
						throw new Error("electron.remote is disabled");
					},
				});
				return electronExport;
			}
			if (request === "@electron/remote") {
				if (useGetAllWindowsOnly) {
					const BrowserWindow = Object.assign(function BrowserWindow() {}, {
						getAllWindows: () => [{ setContentProtection: setProtectionSpy }],
					});
					return {
						powerMonitor: { on: onSpy, removeListener: removeSpy },
						BrowserWindow,
					};
				}
				return {
					powerMonitor: { on: onSpy, removeListener: removeSpy },
					getCurrentWindow: () => ({ setContentProtection: setProtectionSpy }),
				};
			}
			return originalLoad.call(this, request, parent, isMain);
		};

		try {
			const cleanup = wirePowerMonitor(() => undefined);
			expect(onSpy).toHaveBeenCalledTimes(4);
			expect(setContentProtection(true)).toBe(true);
			expect(setProtectionSpy).toHaveBeenCalledWith(true);
			cleanup();
			expect(removeSpy).toHaveBeenCalledTimes(4);

			setProtectionSpy.mockClear();
			useGetAllWindowsOnly = true;
			expect(setContentProtection(true)).toBe(true);
			expect(setProtectionSpy).toHaveBeenCalledWith(true);
		} finally {
			moduleCtor._load = originalLoad;
		}
	});

	it("falls back at call time to @electron/remote when legacy.getCurrentWindow() returns null or throws", () => {
		const moduleCtor = Module as unknown as {
			_load: (request: string, parent: unknown, isMain: boolean) => unknown;
		};
		const originalLoad = moduleCtor._load;
		const scopedProtectionSpy = vi.fn();
		let legacyBehavior: "null" | "throw" = "null";
		const legacyGetWin = vi.fn(() => {
			if (legacyBehavior === "throw") {
				throw new Error("legacy getCurrentWindow failed");
			}
			return null;
		});
		const scopedGetWin = vi.fn(() => ({ setContentProtection: scopedProtectionSpy }));

		moduleCtor._load = function (request: string, parent: unknown, isMain: boolean): unknown {
			if (request === "electron") {
				return {
					remote: {
						powerMonitor: {},
						getCurrentWindow: legacyGetWin,
					},
				};
			}
			if (request === "@electron/remote") {
				return {
					getCurrentWindow: scopedGetWin,
				};
			}
			return originalLoad.call(this, request, parent, isMain);
		};

		try {
			expect(setContentProtection(true)).toBe(true);
			expect(legacyGetWin).toHaveBeenCalledTimes(1);
			expect(scopedGetWin).toHaveBeenCalledTimes(1);
			expect(scopedProtectionSpy).toHaveBeenLastCalledWith(true);

			legacyBehavior = "throw";
			expect(setContentProtection(false)).toBe(true);
			expect(legacyGetWin).toHaveBeenCalledTimes(2);
			expect(scopedGetWin).toHaveBeenCalledTimes(2);
			expect(scopedProtectionSpy).toHaveBeenLastCalledWith(false);
		} finally {
			moduleCtor._load = originalLoad;
		}
	});

	it("supports idempotent cleanup, .off() listener removal, and runtime exception isolation", () => {
		const workingBridge = installElectronMock({ mode: "working" });
		activeBridge = workingBridge;
		const idempotentCleanup = wirePowerMonitor(() => undefined);
		idempotentCleanup();
		idempotentCleanup();
		expect(workingBridge.powerMonitor.removeListener).toHaveBeenCalledTimes(4);
		workingBridge.restore();

		const offOnlyBridge = installElectronMock({ mode: "off-only-listener" });
		activeBridge = offOnlyBridge;
		let offEventCount = 0;
		const offCleanup = wirePowerMonitor(() => {
			offEventCount += 1;
		});
		offOnlyBridge.powerMonitor.emit("lock-screen");
		expect(offEventCount).toBe(1);
		offCleanup();
		expect(offOnlyBridge.powerMonitor.off).toHaveBeenCalledTimes(4);
		for (const event of ["suspend", "resume", "lock-screen", "unlock-screen"]) {
			expect(offOnlyBridge.powerMonitor.listeners.get(event)?.size).toBe(0);
		}
		offOnlyBridge.restore();

		const throwingGetWinBridge = installElectronMock({
			mode: "scoped-remote-only",
			throwOnGetCurrentWindow: true,
		});
		activeBridge = throwingGetWinBridge;
		expect(() => setContentProtection(true)).not.toThrow();
		expect(setContentProtection(true)).toBe(false);
		throwingGetWinBridge.restore();

		const throwingOnBridge = installElectronMock({
			mode: "scoped-remote-only",
			throwOnPowerMonitorOn: true,
		});
		activeBridge = throwingOnBridge;
		let cleanupFromThrowingOn: (() => void) | null = null;
		expect(() => {
			cleanupFromThrowingOn = wirePowerMonitor(() => undefined);
		}).not.toThrow();
		expect(() => cleanupFromThrowingOn?.()).not.toThrow();
		throwingOnBridge.restore();

		const throwingRemoveBridge = installElectronMock({
			mode: "scoped-remote-only",
			throwOnPowerMonitorRemove: true,
		});
		activeBridge = throwingRemoveBridge;
		const cleanupThrowingRemove = wirePowerMonitor(() => undefined);
		expect(() => cleanupThrowingRemove()).not.toThrow();
	});

	it("masks unlocked sessions on document visibilitychange -> hidden and synchronizes content protection across unlock, single-note lock, and settings toggle", async () => {
		const bridge = installElectronMock({ mode: "scoped-remote-only" });
		activeBridge = bridge;

		const origDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
		let visibilityState: DocumentVisibilityState = "visible";
		const mockDoc = {
			get visibilityState(): DocumentVisibilityState {
				return visibilityState;
			},
		};
		Object.defineProperty(globalThis, "document", {
			value: mockDoc,
			configurable: true,
		});

		const domListeners = new Map<string, Array<() => void>>();
		const mockPlugin = {
			registerDomEvent: (target: unknown, event: string, cb: () => void) => {
				const key = `${target === globalThis.document ? "document" : "window"}:${event}`;
				const list = domListeners.get(key) ?? [];
				list.push(cb);
				domListeners.set(key, list);
			},
			registerEvent: () => undefined,
			register: () => undefined,
		} as unknown as Plugin;

		const mockWorkspace = {
			on: () => ({ id: "workspace-event" }),
		} as unknown as Workspace;

		let sessionState: "locked" | "unlocked" = "unlocked";
		const lockAllSpy = vi.fn(async (_reason?: string) => {
			sessionState = "locked";
		});
		const mockSessions = {
			isDisposed: () => false,
			all: () => [{ state: sessionState }],
			lockAll: lockAllSpy,
		} as unknown as SessionManager;

		const settings: VeneerSettings = {
			...DEFAULT_SETTINGS,
			contentProtection: true,
			clearClipboardOnLock: false,
		};

		const lockEngine = new LockEngine(
			mockPlugin,
			mockWorkspace,
			mockSessions,
			() => settings,
		);

		try {
			lockEngine.start();
			lockEngine.onSessionUnlocked();
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(true);

			const visibilityHandlers = domListeners.get("document:visibilitychange") ?? [];
			expect(visibilityHandlers).toHaveLength(1);

			visibilityState = "visible";
			visibilityHandlers[0]?.();
			expect(lockAllSpy).not.toHaveBeenCalled();

			settings.contentProtection = false;
			lockEngine.applyContentProtection();
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(false);

			settings.contentProtection = true;
			lockEngine.applyContentProtection();
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(true);

			sessionState = "locked";
			lockEngine.applyContentProtection();
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(false);

			sessionState = "unlocked";
			lockEngine.onSessionUnlocked();
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(true);

			visibilityState = "hidden";
			visibilityHandlers[0]?.();
			await Promise.resolve();
			await Promise.resolve();

			expect(lockAllSpy).toHaveBeenCalledTimes(1);
			expect(lockAllSpy).toHaveBeenCalledWith("visibility-hidden");
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(false);
		} finally {
			lockEngine.stop();
			if (origDocument) {
				Object.defineProperty(globalThis, "document", origDocument);
			} else {
				Reflect.deleteProperty(globalThis, "document");
			}
		}
	});

	it("gates idle timers on unlocked sessions, throttles rapid activity to 1,000 ms, and honors trailing sub-second activity (Issue #9)", async () => {
		vi.useFakeTimers();
		const bridge = installElectronMock({ mode: "scoped-remote-only" });
		activeBridge = bridge;

		const origDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
		Object.defineProperty(globalThis, "document", {
			value: { visibilityState: "visible" as DocumentVisibilityState },
			configurable: true,
		});

		const domListeners = new Map<string, Array<() => void>>();
		const mockPlugin = {
			registerDomEvent: (target: unknown, event: string, cb: () => void) => {
				const key = `${target === globalThis.document ? "document" : "window"}:${event}`;
				const list = domListeners.get(key) ?? [];
				list.push(cb);
				domListeners.set(key, list);
			},
			registerEvent: () => undefined,
			register: () => undefined,
		} as unknown as Plugin;

		const mockWorkspace = {
			on: () => ({ id: "workspace-event" }),
		} as unknown as Workspace;

		const mockSession: { state: "locked" | "unlocked" } = { state: "locked" };
		const lockAllSpy = vi.fn(async (_reason?: string) => {
			mockSession.state = "locked";
		});
		const mockSessions = {
			isDisposed: () => false,
			all: () => [mockSession],
			lockAll: lockAllSpy,
		} as unknown as SessionManager;

		const settings: VeneerSettings = {
			...DEFAULT_SETTINGS,
			idleTimeoutSec: 15,
			contentProtection: true,
			clearClipboardOnLock: false,
		};

		const lockEngine = new LockEngine(
			mockPlugin,
			mockWorkspace,
			mockSessions,
			() => settings,
		);

		try {
			lockEngine.start();
			expect(vi.getTimerCount()).toBe(0);

			for (const eventName of ["window:wheel", "window:keydown", "window:mousedown", "window:touchstart"]) {
				const handlers = domListeners.get(eventName) ?? [];
				expect(handlers).toHaveLength(1);
				handlers[0]?.();
				expect(vi.getTimerCount()).toBe(0);
			}

			mockSession.state = "unlocked";
			lockEngine.onSessionUnlocked();
			expect(vi.getTimerCount()).toBe(1);

			const setTimeoutSpy = vi.spyOn(window, "setTimeout");
			setTimeoutSpy.mockClear();

			const wheelHandler = domListeners.get("window:wheel")?.[0];
			expect(wheelHandler).toBeDefined();

			for (let i = 0; i < 20; i += 1) {
				vi.advanceTimersByTime(10);
				wheelHandler?.();
			}
			expect(setTimeoutSpy).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(1);

			vi.advanceTimersByTime(300);
			wheelHandler?.();
			expect(setTimeoutSpy).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(14_500);
			expect(lockAllSpy).not.toHaveBeenCalled();
			expect(mockSession.state).toBe("unlocked");
			expect(vi.getTimerCount()).toBe(1);

			await vi.advanceTimersByTimeAsync(500);
			expect(lockAllSpy).toHaveBeenCalledTimes(1);
			expect(lockAllSpy).toHaveBeenCalledWith("idle-timeout");
			expect(mockSession.state).toBe("locked");
			expect(vi.getTimerCount()).toBe(0);

			mockSession.state = "unlocked";
			lockEngine.onSessionUnlocked();
			expect(vi.getTimerCount()).toBe(1);

			setTimeoutSpy.mockClear();
			vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS);
			wheelHandler?.();
			expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(1);

			mockSession.state = "locked";
			lockEngine.onSessionLocked();
			expect(vi.getTimerCount()).toBe(0);
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(false);
		} finally {
			lockEngine.stop();
			vi.useRealTimers();
			if (origDocument) {
				Object.defineProperty(globalThis, "document", origDocument);
			} else {
				Reflect.deleteProperty(globalThis, "document");
			}
		}
	});

	it("selectively masks only inactive or detached sessions on active-leaf-change and layout-change (Issue #9)", async () => {
		vi.useFakeTimers();
		const bridge = installElectronMock({ mode: "scoped-remote-only" });
		activeBridge = bridge;

		const origDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
		Object.defineProperty(globalThis, "document", {
			value: { visibilityState: "visible" as DocumentVisibilityState },
			configurable: true,
		});

		const workspaceListeners = new Map<string, Array<() => void>>();
		const mockPlugin = {
			registerDomEvent: () => undefined,
			registerEvent: () => undefined,
			register: () => undefined,
		} as unknown as Plugin;

		const viewA = new MarkdownView(null as never);
		const viewB = new MarkdownView(null as never);
		let activeView: MarkdownView | null = viewA;
		let attachedViews: MarkdownView[] = [viewA, viewB];

		const mockWorkspace = {
			on: (event: string, cb: () => void) => {
				const list = workspaceListeners.get(event) ?? [];
				list.push(cb);
				workspaceListeners.set(event, list);
				return { id: event };
			},
			getActiveViewOfType: vi.fn((_ctor: unknown) => activeView),
			iterateAllLeaves: vi.fn((cb: (leaf: { view: unknown }) => void) => {
				for (const view of attachedViews) {
					cb({ view });
				}
			}),
		} as unknown as Workspace;

		const sessionA = {
			view: viewA,
			file: { path: "note-a.md" },
			state: "unlocked" as "locked" | "unlocked",
		} as unknown as ViewSession;
		const sessionB = {
			view: viewB,
			file: { path: "note-b.md" },
			state: "locked" as "locked" | "unlocked",
		} as unknown as ViewSession;

		const lockSpy = vi.fn(async (session: ViewSession, _reason: string) => {
			session.state = "locked";
		});
		const lockAllSpy = vi.fn(async (_reason?: string) => {
			sessionA.state = "locked";
			sessionB.state = "locked";
		});
		const mockSessions = {
			isDisposed: () => false,
			all: () => [sessionA, sessionB],
			lock: lockSpy,
			lockAll: lockAllSpy,
		} as unknown as SessionManager;

		const settings: VeneerSettings = {
			...DEFAULT_SETTINGS,
			idleTimeoutSec: 60,
			contentProtection: true,
			clearClipboardOnLock: false,
		};

		const lockEngine = new LockEngine(
			mockPlugin,
			mockWorkspace,
			mockSessions,
			() => settings,
		);

		try {
			lockEngine.start();
			lockEngine.onSessionUnlocked();
			expect(vi.getTimerCount()).toBe(1);
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(true);

			const leafChangeHandler = workspaceListeners.get("active-leaf-change")?.[0];
			const layoutChangeHandler = workspaceListeners.get("layout-change")?.[0];
			expect(leafChangeHandler).toBeDefined();
			expect(layoutChangeHandler).toBeDefined();

			leafChangeHandler?.();
			layoutChangeHandler?.();
			await Promise.resolve();
			await Promise.resolve();
			expect(lockSpy).not.toHaveBeenCalled();
			expect(lockAllSpy).not.toHaveBeenCalled();
			expect(sessionA.state).toBe("unlocked");
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(true);

			sessionB.state = "unlocked";
			activeView = viewB;
			leafChangeHandler?.();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(lockSpy).toHaveBeenCalledTimes(1);
			expect(lockSpy).toHaveBeenCalledWith(sessionA, "leaf-change");
			expect(sessionA.state).toBe("locked");
			expect(sessionB.state).toBe("unlocked");
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(true);
			expect(vi.getTimerCount()).toBe(1);

			lockSpy.mockClear();
			activeView = null;
			attachedViews = [];
			layoutChangeHandler?.();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(lockSpy).toHaveBeenCalledTimes(1);
			expect(lockSpy).toHaveBeenCalledWith(sessionB, "layout-change");
			expect(sessionB.state).toBe("locked");
			expect(bridge.browserWindow.setContentProtection).toHaveBeenLastCalledWith(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			lockEngine.stop();
			vi.useRealTimers();
			if (origDocument) {
				Object.defineProperty(globalThis, "document", origDocument);
			} else {
				Reflect.deleteProperty(globalThis, "document");
			}
		}
	});

	it("skips loadData and saveData in ProtectedRegistry.remove when deleting an untracked file (Issue #9)", async () => {
		let persisted: Record<string, unknown> = {};
		const loadData = vi.fn(async () => persisted);
		const saveData = vi.fn(async (next: Record<string, unknown>) => {
			persisted = next;
		});
		const mockPlugin = {
			loadData,
			saveData,
		} as unknown as Plugin;

		const registry = new ProtectedRegistry(mockPlugin);
		await registry.add("tracked.md", { noteId: "n1", addedAt: 1, mode: "portable" });
		expect(registry.has("tracked.md")).toBe(true);

		loadData.mockClear();
		saveData.mockClear();

		await registry.remove("untracked-file.md");
		expect(loadData).toHaveBeenCalledTimes(0);
		expect(saveData).toHaveBeenCalledTimes(0);
		expect(registry.has("tracked.md")).toBe(true);

		await registry.remove("tracked.md");
		expect(saveData).toHaveBeenCalledTimes(1);
		expect(registry.has("tracked.md")).toBe(false);
	});
});
