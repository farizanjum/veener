/**
 * Electron power/display wiring, all guarded (§7, §9.4). Resolves both legacy
 * `require("electron").remote` and modern `require("@electron/remote")` bridges,
 * degrading cleanly to a no-op when neither is exposed by the host runtime.
 */

/** Minimal subset of Electron's `powerMonitor` event emitter used by Veneer. */
interface PowerMonitorLike {
	on(event: string, listener: () => void): void;
	removeListener?(event: string, listener: () => void): void;
	off?(event: string, listener: () => void): void;
}

/** Minimal subset of Electron's `BrowserWindow` used for OS screen-capture protection. */
interface BrowserWindowLike {
	setContentProtection(protect: boolean): void;
}

/** Minimal subset of Electron's `BrowserWindow` constructor fallback. */
interface BrowserWindowCtorLike {
	getFocusedWindow?(): BrowserWindowLike | null;
	getAllWindows?(): BrowserWindowLike[];
}

/** Minimal subset of the Electron remote bridge (`electron.remote` or `@electron/remote`). */
interface RemoteLike {
	powerMonitor?: PowerMonitorLike | undefined;
	getCurrentWindow?: (() => BrowserWindowLike | null) | undefined;
	BrowserWindow?: BrowserWindowCtorLike | undefined;
}

/** Minimal subset of the `electron` module namespace. */
interface ElectronLike {
	remote?: RemoteLike;
	powerMonitor?: PowerMonitorLike;
}

/** Safely loads a CommonJS module by identifier without throwing when unavailable. */
function tryRequire(moduleId: string): unknown {
	try {
		return require(moduleId);
	} catch {
		return null;
	}
}

/** Safely evaluates a property getter without throwing if the host defines a throwing getter. */
function tryGet<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

/** Returns true when `value` is an object exposing an `on` listener registration method. */
function isPowerMonitor(value: unknown): value is PowerMonitorLike {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as PowerMonitorLike).on === "function",
	);
}

/** Resolves a `BrowserWindowLike` instance from `bridge` via `getCurrentWindow` or `BrowserWindow`. */
function resolveWindowFromBridge(bridge: RemoteLike | null): BrowserWindowLike | null {
	if (!bridge) return null;
	const getWin = tryGet(() => bridge.getCurrentWindow);
	if (typeof getWin === "function") {
		const win = tryGet(() => getWin.call(bridge));
		if (win) return win;
	}
	const bw = tryGet(() => bridge.BrowserWindow);
	if (bw && typeof bw === "object") {
		const getFocused = tryGet(() => bw.getFocusedWindow);
		if (typeof getFocused === "function") {
			const focused = tryGet(() => getFocused.call(bw));
			if (focused) return focused;
		}
		const getAll = tryGet(() => bw.getAllWindows);
		if (typeof getAll === "function") {
			const first = tryGet(() => getAll.call(bw)?.[0] ?? null);
			if (first) return first;
		}
	}
	return null;
}

/** Returns true when `bridge` exposes any window lookup function (`getCurrentWindow` or `BrowserWindow`). */
function hasWindowResolver(bridge: RemoteLike | null): boolean {
	if (!bridge) return false;
	if (typeof tryGet(() => bridge.getCurrentWindow) === "function") return true;
	const bw = tryGet(() => bridge.BrowserWindow);
	return Boolean(
		bw &&
			typeof bw === "object" &&
			(typeof tryGet(() => bw.getFocusedWindow) === "function" ||
				typeof tryGet(() => bw.getAllWindows) === "function"),
	);
}

/** Resolves `powerMonitor` and `getCurrentWindow` across `electron.remote` and `@electron/remote`. */
function electronRemote(): RemoteLike | null {
	const electronMod = tryRequire("electron") as ElectronLike | null;
	const rawLegacy =
		electronMod && typeof electronMod === "object"
			? tryGet(() => electronMod.remote)
			: undefined;
	const legacy = rawLegacy && typeof rawLegacy === "object" ? rawLegacy : null;
	const scopedMod = tryRequire("@electron/remote") as RemoteLike | null;
	const scoped = scopedMod && typeof scopedMod === "object" ? scopedMod : null;

	const legacyMonitor = legacy ? tryGet(() => legacy.powerMonitor) : undefined;
	const scopedMonitor = scoped ? tryGet(() => scoped.powerMonitor) : undefined;
	const directMonitor =
		electronMod && typeof electronMod === "object"
			? tryGet(() => electronMod.powerMonitor)
			: undefined;
	const powerMonitor = isPowerMonitor(legacyMonitor)
		? legacyMonitor
		: isPowerMonitor(scopedMonitor)
			? scopedMonitor
			: isPowerMonitor(directMonitor)
				? directMonitor
				: undefined;

	const getCurrentWindow =
		hasWindowResolver(legacy) || hasWindowResolver(scoped)
			? (): BrowserWindowLike | null =>
					resolveWindowFromBridge(legacy) ?? resolveWindowFromBridge(scoped)
			: undefined;

	if (!powerMonitor && !getCurrentWindow) {
		return null;
	}
	return { powerMonitor, getCurrentWindow };
}

const POWER_EVENTS = ["suspend", "resume", "lock-screen", "unlock-screen"] as const;

/**
 * Subscribes `onPowerEvent` to OS suspend, resume, lock-screen, and unlock-screen
 * events when Electron's `powerMonitor` is reachable, returning an idempotent cleanup callback.
 */
export function wirePowerMonitor(onPowerEvent: () => void): () => void {
	const monitor = electronRemote()?.powerMonitor;
	if (!monitor || typeof monitor.on !== "function") return () => undefined;
	const registeredEvents: (typeof POWER_EVENTS)[number][] = [];
	for (const event of POWER_EVENTS) {
		try {
			monitor.on(event, onPowerEvent);
			registeredEvents.push(event);
		} catch {
			// Ignore unsupported power event registration failures
		}
	}
	let cleanedUp = false;
	return () => {
		if (cleanedUp) return;
		cleanedUp = true;
		for (const event of registeredEvents) {
			try {
				if (typeof monitor.removeListener === "function") {
					monitor.removeListener(event, onPowerEvent);
				} else if (typeof monitor.off === "function") {
					monitor.off(event, onPowerEvent);
				}
			} catch {
				// Ignore listener removal errors during shutdown
			}
		}
	};
}

/**
 * Enables or disables OS-level window content protection (hiding the Obsidian window
 * from screenshots, screen sharing, and Windows Recall) on the current Electron window.
 */
export function setContentProtection(protect: boolean): boolean {
	try {
		const win = electronRemote()?.getCurrentWindow?.();
		if (!win || typeof win.setContentProtection !== "function") return false;
		win.setContentProtection(protect);
		return true;
	} catch {
		return false;
	}
}
