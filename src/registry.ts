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

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<void> {
		const raw = (await this.plugin.loadData()) as { entries?: Record<string, RegistryEntry> } | null;
		if (raw && typeof raw === "object" && raw.entries) {
			this.data = { entries: raw.entries };
		}
	}

	async save(): Promise<void> {
		const raw = (await this.plugin.loadData()) as Record<string, unknown> | null;
		await this.plugin.saveData({ ...(raw ?? {}), entries: this.data.entries });
	}

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

	async add(path: string, entry: RegistryEntry): Promise<void> {
		this.data.entries[path] = entry;
		await this.save();
	}

	async remove(path: string): Promise<void> {
		delete this.data.entries[path];
		await this.save();
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const entry = this.data.entries[oldPath];
		if (!entry) return;
		delete this.data.entries[oldPath];
		this.data.entries[newPath] = entry;
		await this.save();
	}

	list(): { path: string; entry: RegistryEntry }[] {
		return Object.entries(this.data.entries).map(([path, entry]) => ({ path, entry }));
	}

	async clear(): Promise<void> {
		this.data = { entries: {} };
		await this.save();
	}
}
