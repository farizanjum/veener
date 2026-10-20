import Module from "module";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as powerModule from "../src/lock/power";
import { setContentProtection, wirePowerMonitor } from "../src/lock/power";
import { executeShred } from "../src/shred/duress";

interface MockPowerMonitor {
	readonly listeners: Map<string, Set<() => void>>;
	readonly on: ReturnType<typeof vi.fn>;
	readonly removeListener: ReturnType<typeof vi.fn>;
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

function installElectronMock(options?: {
	readonly mode?: "working" | "absent-module" | "absent-remote" | "no-remove-listener";
	readonly throwOnContentProtection?: boolean;
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
		let bucket = listeners.get(event);
		if (!bucket) {
			bucket = new Set();
			listeners.set(event, bucket);
		}
		bucket.add(listener);
	});
	const removeListener = vi.fn((event: string, listener: () => void) => {
		listeners.get(event)?.delete(listener);
	});
	const powerMonitor: MockPowerMonitor = {
		listeners,
		on,
		removeListener,
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
	const getCurrentWindow = vi.fn(() => (options?.nullWindow ? null : browserWindow));

	const moduleCtor = Module as unknown as {
		_load: (request: string, parent: unknown, isMain: boolean) => unknown;
	};
	const originalLoad = moduleCtor._load;

	moduleCtor._load = function (request: string, parent: unknown, isMain: boolean): unknown {
		if (request === "electron") {
			if (mode === "absent-module") {
				throw new Error("Cannot find module 'electron'");
			}
			if (mode === "absent-remote") {
				return {};
			}
			const monitorObj =
				mode === "no-remove-listener"
					? { on: powerMonitor.on }
					: { on: powerMonitor.on, removeListener: powerMonitor.removeListener };
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
});
