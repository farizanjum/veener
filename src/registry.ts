import type { Plugin } from "obsidian";

/**
 * Protected-note bookkeeping (secondary to the self-describing payload marker).
 * Used by the duress shred to enumerate targets and by settings to list notes.
 * Contains no content, only paths and note IDs.
 */

export interface RegistryEntry {
	noteId: string;
	addedAt: number;
	mode: "portable" | "stealth";
}

interface RegistryData {
	entries: Record<string, RegistryEntry>;
}

export class ProtectedRegistry {
	private data: RegistryData = { entries: {} };
	private saveChain: Promise<void> = Promise.resolve();

	/** Creates a `ProtectedRegistry` persisted via `plugin.loadData()` and `plugin.saveData()`. */
	constructor(private readonly plugin: Plugin) {}

	/** Loads persisted registry entries from plugin data storage. */
	async load(): Promise<void> {
		const raw = (await this.plugin.loadData()) as { entries?: Record<string, RegistryEntry> } | null;
		if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
			this.data = { entries: { ...raw.entries } };
		}
	}

	/** Persists current registry entries into plugin data storage while preserving other plugin keys. */
	async save(): Promise<void> {
		const run = async (): Promise<void> => {
			const snapshot = { ...this.data.entries };
			const raw = (await this.plugin.loadData()) as Record<string, unknown> | null;
			await this.plugin.saveData({ ...(raw ?? {}), entries: snapshot });
		};
		const next = this.saveChain.then(run, run);
		this.saveChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/** Returns a shallow copy of the path-to-entry mapping. */
	entriesRecord(): Record<string, RegistryEntry> {
		return { ...this.data.entries };
	}

	/** Returns true when `path` is currently tracked in the protected-note registry. */
	has(path: string): boolean {
		return Object.prototype.hasOwnProperty.call(this.data.entries, path);
	}

	/** Registers `path` in the protected-note registry if it is not already tracked. */
	async ensure(path: string, entry: RegistryEntry): Promise<void> {
		if (this.has(path)) return;
		await this.add(path, entry);
	}

	/** Adds or updates `path` in the protected-note registry and persists the change. */
	async add(path: string, entry: RegistryEntry): Promise<void> {
		this.data.entries[path] = entry;
		await this.save();
	}

	/** Removes `path` from the protected-note registry if present and persists the change. */
	async remove(path: string): Promise<void> {
		if (!this.has(path)) return;
		delete this.data.entries[path];
		await this.save();
	}

	/** Moves the registry entry from `oldPath` to `newPath` if `oldPath` is tracked, then persists the change. */
	async rename(oldPath: string, newPath: string): Promise<void> {
		if (!this.has(oldPath) || oldPath === newPath) return;
		const entry = this.data.entries[oldPath];
		if (!entry) return;
		delete this.data.entries[oldPath];
		this.data.entries[newPath] = entry;
		await this.save();
	}

	/** Lists all tracked protected notes as `{ path, entry }` pairs. */
	list(): { path: string; entry: RegistryEntry }[] {
		return Object.entries(this.data.entries).map(([path, entry]) => ({ path, entry }));
	}

	/** Clears all entries from the protected-note registry and persists the empty state. */
	async clear(): Promise<void> {
		this.data = { entries: {} };
		await this.save();
	}
}
