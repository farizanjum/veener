/**
 * Electron power/display wiring, all guarded (§7, §9.4). Obsidian's Electron
 * may not expose `remote`; every call degrades to a no-op instead of failing.
 */

interface PowerMonitorLike {
	on(event: string, listener: () => void): void;
	removeListener?(event: string, listener: () => void): void;
}

interface BrowserWindowLike {
	setContentProtection(protect: boolean): void;
}

interface RemoteLike {
	powerMonitor?: PowerMonitorLike;
	getCurrentWindow?(): BrowserWindowLike;
	session?: {
		defaultSession?: {
			clearCache(): Promise<void>;
			clearStorageData(options?: { storages?: string[] }): Promise<void>;
		};
	};
}

interface ElectronLike {
	remote?: RemoteLike;
}

function electronRemote(): RemoteLike | null {
	try {
		const electron = require("electron") as ElectronLike;
		return electron.remote ?? null;
	} catch {
		return null;
	}
}

const POWER_EVENTS = ["suspend", "resume", "lock-screen", "unlock-screen"] as const;

export function wirePowerMonitor(onPowerEvent: () => void): () => void {
	const monitor = electronRemote()?.powerMonitor;
	if (!monitor) return () => undefined;
	for (const event of POWER_EVENTS) monitor.on(event, onPowerEvent);
	return () => {
		for (const event of POWER_EVENTS) monitor.removeListener?.(event, onPowerEvent);
	};
}

export function setContentProtection(protect: boolean): boolean {
	const win = electronRemote()?.getCurrentWindow?.();
	if (!win) return false;
	try {
		win.setContentProtection(protect);
		return true;
	} catch {
		return false;
	}
}

export async function clearWebStorage(): Promise<void> {
	const session = electronRemote()?.session?.defaultSession;
	if (!session) return;
	try {
		await session.clearCache();
		await session.clearStorageData({
			storages: ["localstorage", "indexdb", "websql", "serviceworkers", "cachestorage"],
		});
	} catch (error) {
		console.warn("Veneer: web storage clear skipped", error);
	}
}
