import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, MarkdownView, TFile } from "obsidian";
import { createFile, parseFileContent, unlockPayload } from "../src/crypto/payload";
import { SessionManager } from "../src/view/session";
import { ProtectedRegistry } from "../src/registry";
import { DEFAULT_SETTINGS } from "../src/settings";

vi.mock("obsidian", () => {
	class HostClass {}
	return {
		Plugin: HostClass, Modal: HostClass, MarkdownView: HostClass,
		PluginSettingTab: HostClass, Setting: HostClass, TFile: HostClass,
		Notice: HostClass, addIcon: () => undefined,
	};
});

import VeneerPlugin from "../src/main";
import { PasswordModal } from "../src/ui/modals";

const PASSWORD = "correct horse battery staple";
const NEXT_PASSWORD = "new correct horse battery staple";
const REAL = "Private note before command";
const COVER = "Groceries\n- bread";

async function createHarness(failReread = false) {
	const created = await createFile(REAL, PASSWORD, COVER);
	const parsed = parseFileContent(created.fileContent);
	if (parsed === null) throw new Error("Invalid protected fixture");
	let disk = created.fileContent;
	let text = COVER;
	let reads = 0;
	const attempts: string[] = [];
	const file: TFile = Object.assign(Object.create(null), {
		path: "Cover.md", name: "Cover.md", basename: "Cover", extension: "md", parent: { path: "" },
	});
	const view: MarkdownView = Object.assign(Object.create(null), {
		file, editor: { getValue: () => text },
		setViewData: (next: string) => { text = next; },
	});
	const app: App = Object.assign(Object.create(null), {
		workspace: { getActiveFile: () => file },
		fileManager: { renameFile: async () => undefined },
		vault: {
			getAbstractFileByPath: () => null,
			read: async () => {
				const snapshot = disk;
				reads += 1;
				if (reads === 2) {
					if (failReread) throw new Error("reread failed");
					const outcome = await sessions.unlock(session, PASSWORD);
					attempts.push(outcome);
					if (outcome === "ok") {
						text = "New edit made during the command";
						await sessions.lock(session, "reread-race");
					}
				}
				return snapshot;
			},
			modify: async (_file: TFile, next: string) => { disk = next; },
		},
	});
	const sessions = new SessionManager(app, {
		onUnlocked: () => undefined, onLocked: () => undefined, onUnlockBlocked: () => undefined,
	}, () => ";;", () => null);
	const session = sessions.attachFromLoad(view, file, parsed);
	const plugin: VeneerPlugin = Object.create(VeneerPlugin.prototype);
	plugin.app = app;
	plugin.settings = { ...DEFAULT_SETTINGS };
	plugin.sessions = sessions;
	plugin.loadData = async () => null;
	plugin.saveData = async () => undefined;
	plugin.registry = new ProtectedRegistry(plugin);
	plugin["generator"] = Object.assign(Object.create(null), {
		generate: async () => ({ text: "# Cover\n\nUpdated groceries", source: "template" }),
	});
	vi.spyOn(PasswordModal.prototype, "ask").mockResolvedValue(PASSWORD);
	return { plugin, file, sessions, session, attempts, content: () => disk };
}

afterEach(() => vi.restoreAllMocks());

describe("command reservations cover the payload reread", () => {
	it.each(["password", "unprotect", "refresh"] as const)("blocks concurrent unlock during %s and releases after success", async (command) => {
		// Given: a locked note and a concurrent unlock/edit/mask attempt during its second read.
		const h = await createHarness();
		// When: the command rereads under its path reservation.
		if (command === "password") {
			vi.spyOn(PasswordModal.prototype, "ask").mockResolvedValueOnce(PASSWORD).mockResolvedValueOnce(NEXT_PASSWORD);
			await h.plugin["changePasswordViaModal"]();
		} else if (command === "unprotect") {
			await h.plugin["unprotectViaModal"]();
		} else {
			await h.plugin["refreshDecoy"](h.file);
		}
		// Then: no concurrent unlocked edit is admitted into the command's snapshot window.
		expect(h.attempts).toEqual(["blocked"]);
		expect(h.sessions.isPathReserved(h.file.path)).toBe(false);
		if (command === "unprotect") {
			expect(h.content()).toBe(`${REAL}\n`);
		} else {
			const saved = parseFileContent(h.content());
			if (saved === null) throw new Error("Command lost protected payload");
			const unlocked = await unlockPayload(saved.payload, command === "password" ? NEXT_PASSWORD : PASSWORD);
			expect(unlocked.realText).toBe(REAL);
			unlocked.dek.fill(0);
		}
	});

	it.each(["password", "unprotect", "refresh"] as const)("releases %s reservation when the reread fails", async (command) => {
		// Given: the second vault read fails after the reservation is acquired.
		const h = await createHarness(true);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		// When: the command hits the read failure.
		if (command === "password") await h.plugin["changePasswordViaModal"]();
		else if (command === "unprotect") await h.plugin["unprotectViaModal"]();
		else await h.plugin["refreshDecoy"](h.file);
		// Then: unlock is usable again and the original protected content was not overwritten.
		expect(h.sessions.isPathReserved(h.file.path)).toBe(false);
		expect(await h.sessions.unlock(h.session, PASSWORD)).toBe("ok");
	});
});
