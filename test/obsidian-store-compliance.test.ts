import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, MarkdownView, TFile, type App, type Command } from "obsidian";
import VeneerPlugin from "../src/main";
import { ProtectedRegistry } from "../src/registry";
import { serializeFile, type PayloadV1 } from "../src/crypto/payload";
import type { SessionManager, ViewSession } from "../src/view/session";

const ROOT_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT_DIR, "src");

function collectTsFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTsFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			results.push(fullPath);
		}
	}
	return results.sort();
}

describe("Obsidian Community Plugin Store compliance", () => {
	describe("manifest.json, versions.json, package.json, and README.md metadata", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(ROOT_DIR, "manifest.json"), "utf8"),
		) as {
			id: string;
			name: string;
			version: string;
			minAppVersion: string;
			description: string;
			author: string;
			authorUrl: string;
			isDesktopOnly: boolean;
		};
		const versions = JSON.parse(
			fs.readFileSync(path.join(ROOT_DIR, "versions.json"), "utf8"),
		) as Record<string, string>;
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"),
		) as {
			version: string;
			license: string;
		};
		const readme = fs.readFileSync(path.join(ROOT_DIR, "README.md"), "utf8");

		it("enforces manifest.json identity, version, authorUrl, and desktop-only flag", () => {
			expect(manifest.id).toBe("veneer");
			expect(manifest.name).toBe("Veneer");
			expect(manifest.version).toBe("1.0.0");
			expect(manifest.authorUrl).toBe("https://github.com/farizanjum");
			expect(manifest.isDesktopOnly).toBe(true);
		});

		it("enforces manifest.description formatting, length, punctuation, and forbidden words", () => {
			expect(manifest.description).toMatch(/^[A-Za-z0-9\s.,!?'"-]+$/);
			expect(manifest.description.length).toBeLessThanOrEqual(250);
			expect(manifest.description.endsWith(".")).toBe(true);
			expect(manifest.description.toLowerCase()).not.toContain("obsidian");
			expect(manifest.description.toLowerCase()).not.toContain("plugin");
		});

		it("synchronizes versions.json and package.json with manifest.json", () => {
			expect(versions[manifest.version]).toBe(manifest.minAppVersion);
			expect(pkg.version).toBe(manifest.version);
			expect(pkg.license).toBe("MIT");
		});

		it("starts README.md with # Veneer and discloses huggingface.co, wllama.wasm, and llama-server", () => {
			expect(readme.trimStart().startsWith("# Veneer")).toBe(true);
			expect(readme).toContain("huggingface.co");
			expect(readme).toContain("wllama.wasm");
			expect(readme).toContain("llama-server");
		});
	});

	describe("static scanner rules across src/", () => {
		const tsFiles = collectTsFiles(SRC_DIR);

		it("contains zero console.log, console.info, or console.debug calls in src/", () => {
			const violations: string[] = [];
			for (const file of tsFiles) {
				const content = fs.readFileSync(file, "utf8");
				if (/\bconsole\.(?:log|info|debug)\b/.test(content)) {
					violations.push(path.relative(ROOT_DIR, file));
				}
			}
			expect(violations).toEqual([]);
		});

		it("contains zero innerHTML, outerHTML, or insertAdjacentHTML usages in src/", () => {
			const violations: string[] = [];
			for (const file of tsFiles) {
				const content = fs.readFileSync(file, "utf8");
				if (/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/.test(content)) {
					violations.push(path.relative(ROOT_DIR, file));
				}
			}
			expect(violations).toEqual([]);
		});

		it("contains zero .style., cssText, or style: inline attribute assignments in src/", () => {
			const violations: string[] = [];
			for (const file of tsFiles) {
				const content = fs.readFileSync(file, "utf8");
				if (/\.style\.|\bcssText\b|\bstyle\s*:/.test(content)) {
					violations.push(path.relative(ROOT_DIR, file));
				}
			}
			expect(violations).toEqual([]);
		});

		it("contains zero hardcoded plugins/deocy path strings in src/", () => {
			const violations: string[] = [];
			for (const file of tsFiles) {
				const content = fs.readFileSync(file, "utf8");
				if (content.includes("plugins/deocy")) {
					violations.push(path.relative(ROOT_DIR, file));
				}
			}
			expect(violations).toEqual([]);
		});

		it("contains zero createEl(h1..h6) calls in src/ui/settingsTab.ts", () => {
			const settingsTabContent = fs.readFileSync(
				path.join(SRC_DIR, "ui", "settingsTab.ts"),
				"utf8",
			);
			expect(settingsTabContent).not.toMatch(/\bcreateEl\(\s*["']h[1-6]["']/);
		});

		it("contains zero bare setTimeout or clearTimeout calls in main, LockEngine, downloadModal, session, and generator", () => {
			const targetFiles = [
				path.join(SRC_DIR, "main.ts"),
				path.join(SRC_DIR, "lock", "LockEngine.ts"),
				path.join(SRC_DIR, "ui", "downloadModal.ts"),
				path.join(SRC_DIR, "view", "session.ts"),
				path.join(SRC_DIR, "llm", "generator.ts"),
			];
			const violations: string[] = [];
			for (const file of targetFiles) {
				const content = fs.readFileSync(file, "utf8");
				if (/(?<!window\.)\b(?:setTimeout|clearTimeout)\s*\(/.test(content)) {
					violations.push(path.relative(ROOT_DIR, file));
				}
			}
			expect(violations).toEqual([]);
		});
	});

	describe("VeneerPlugin.pluginDirPaths() and registerCommands()", () => {
		it("resolves pluginDirPaths() from manifest.dir when present and falls back to configDir/plugins/manifest.id via FileSystemAdapter.getBasePath()", () => {
			class TestFsAdapter extends FileSystemAdapter {
				override getBasePath(): string {
					return "/vault/base";
				}
			}
			const adapter = new TestFsAdapter();

			const pluginWithManifestDir = Object.create(VeneerPlugin.prototype) as VeneerPlugin;
			Object.assign(pluginWithManifestDir, {
				app: {
					vault: {
						configDir: ".obsidian",
						adapter,
					},
				},
				manifest: {
					id: "veneer",
					dir: ".obsidian/plugins/veneer",
				},
			});
			expect(pluginWithManifestDir.pluginDirPaths()).toEqual({
				rel: ".obsidian/plugins/veneer",
				abs: path.join("/vault/base", ".obsidian", "plugins", "veneer"),
			});

			const pluginWithCustomDir = Object.create(VeneerPlugin.prototype) as VeneerPlugin;
			Object.assign(pluginWithCustomDir, {
				app: {
					vault: {
						configDir: ".obsidian",
						adapter,
					},
				},
				manifest: {
					id: "veneer",
					dir: ".obsidian/plugins/deocy",
				},
			});
			expect(pluginWithCustomDir.pluginDirPaths()).toEqual({
				rel: ".obsidian/plugins/deocy",
				abs: path.join("/vault/base", ".obsidian", "plugins", "deocy"),
			});

			const pluginWithFallbackDir = Object.create(VeneerPlugin.prototype) as VeneerPlugin;
			Object.assign(pluginWithFallbackDir, {
				app: {
					vault: {
						configDir: ".custom-obsidian",
						adapter,
					},
				},
				manifest: {
					id: "veneer",
				},
			});
			expect(pluginWithFallbackDir.pluginDirPaths()).toEqual({
				rel: ".custom-obsidian/plugins/veneer",
				abs: path.join("/vault/base", ".custom-obsidian", "plugins", "veneer"),
			});
		});

		it("registers panic-mask without default hotkeys and gates checkCallback commands on isLive(), active .md file / MarkdownView / session, and checking === false", () => {
			const commands = new Map<string, Command>();
			let live = true;
			let activeFile: TFile | null = null;
			let activeView: MarkdownView | null = null;
			const sessionMap = new Map<MarkdownView, ViewSession>();

			const protectFileSpy = vi.fn().mockResolvedValue(undefined);
			const refreshDecoySpy = vi.fn().mockResolvedValue(undefined);
			const unlockViaModalSpy = vi.fn().mockResolvedValue(undefined);
			const unprotectViaModalSpy = vi.fn().mockResolvedValue(undefined);
			const changePasswordViaModalSpy = vi.fn().mockResolvedValue(undefined);
			const lockSpy = vi.fn().mockResolvedValue(undefined);
			const panicSpy = vi.fn();

			const app = {
				workspace: {
					getActiveFile: () => activeFile,
					getActiveViewOfType: (ctor: unknown) =>
						ctor === MarkdownView ? activeView : null,
				},
			} as unknown as App;

			const sessions = {
				get: (v: MarkdownView) => sessionMap.get(v) ?? null,
				lock: lockSpy,
				isDisposed: () => false,
			} as unknown as SessionManager;

			const plugin = Object.create(VeneerPlugin.prototype) as VeneerPlugin;

			Object.assign(plugin, {
				app,
				sessions,
				lockEngine: { panic: panicSpy },
				isLive: () => live,
				addCommand: (cmd: Command) => {
					commands.set(cmd.id, cmd);
					return cmd;
				},
				protectFile: protectFileSpy,
				refreshDecoy: refreshDecoySpy,
				unlockViaModal: unlockViaModalSpy,
				unprotectViaModal: unprotectViaModalSpy,
				changePasswordViaModal: changePasswordViaModalSpy,
			});

			(plugin as unknown as { registerCommands: () => void }).registerCommands();

			const panicCmd = commands.get("panic-mask");
			expect(panicCmd).toBeDefined();
			expect(panicCmd?.hotkeys).toBeUndefined();
			panicCmd?.callback?.();
			expect(panicSpy).toHaveBeenCalledTimes(1);

			const mdFile = { path: "Note.md", extension: "md" } as TFile;
			const pngFile = { path: "Image.png", extension: "png" } as TFile;
			const mdView = Object.assign(Object.create(MarkdownView.prototype), {
				file: mdFile,
			}) as MarkdownView;
			const mockSession = { view: mdView, file: mdFile, state: "unlocked" } as ViewSession;

			const fileGatedIds = [
				{ id: "protect-note", spy: protectFileSpy, arg: mdFile },
				{ id: "refresh-decoy", spy: refreshDecoySpy, arg: mdFile },
				{ id: "unprotect-note", spy: unprotectViaModalSpy, arg: undefined },
				{ id: "change-password", spy: changePasswordViaModalSpy, arg: undefined },
			] as const;

			for (const { id, spy, arg } of fileGatedIds) {
				const cmd = commands.get(id);
				expect(cmd?.checkCallback).toBeTypeOf("function");

				activeFile = null;
				expect(cmd!.checkCallback!(true)).toBe(false);

				activeFile = pngFile;
				expect(cmd!.checkCallback!(true)).toBe(false);

				activeFile = mdFile;
				live = false;
				expect(cmd!.checkCallback!(true)).toBe(false);

				live = true;
				expect(cmd!.checkCallback!(true)).toBe(true);
				expect(spy).not.toHaveBeenCalled();

				expect(cmd!.checkCallback!(false)).toBe(true);
				expect(spy).toHaveBeenCalledTimes(1);
				if (arg !== undefined) {
					expect(spy).toHaveBeenCalledWith(arg);
				}
			}

			const unlockCmd = commands.get("unlock-note")!;
			expect(unlockCmd.checkCallback).toBeTypeOf("function");
			activeView = null;
			expect(unlockCmd.checkCallback!(true)).toBe(false);

			const nonMdView = Object.assign(Object.create(MarkdownView.prototype), {
				file: pngFile,
			}) as MarkdownView;
			activeView = nonMdView;
			expect(unlockCmd.checkCallback!(true)).toBe(false);

			activeView = mdView;
			live = false;
			expect(unlockCmd.checkCallback!(true)).toBe(false);

			live = true;
			expect(unlockCmd.checkCallback!(true)).toBe(true);
			expect(unlockViaModalSpy).not.toHaveBeenCalled();

			expect(unlockCmd.checkCallback!(false)).toBe(true);
			expect(unlockViaModalSpy).toHaveBeenCalledTimes(1);

			const maskCmd = commands.get("mask-note")!;
			expect(maskCmd.checkCallback).toBeTypeOf("function");
			sessionMap.clear();
			expect(maskCmd.checkCallback!(true)).toBe(false);

			sessionMap.set(mdView, mockSession);
			live = false;
			expect(maskCmd.checkCallback!(true)).toBe(false);

			live = true;
			expect(maskCmd.checkCallback!(true)).toBe(true);
			expect(lockSpy).not.toHaveBeenCalled();

			expect(maskCmd.checkCallback!(false)).toBe(true);
			expect(lockSpy).toHaveBeenCalledWith(mockSession, "manual");
		});

		it("migrates legacy .obsidian/plugins/deocy/data.json on startup and shreds both registry and vault-scanned protected notes", async () => {
			const legacyData = {
				triggerPrefix: "//custom",
				duressPinSalt: "deadbeef",
				duressPinHash: "cafebabe",
				entries: {
					"Migrated.md": {
						noteId: "note-migrated",
						addedAt: 1000,
						mode: "portable" as const,
					},
				},
			};

			const state: { savedData: Record<string, unknown> | null } = { savedData: null };
			const dummyPayload: PayloadV1 = {
				v: 1,
				note_id: "note-scanned",
				kdf: {
					algo: "argon2id",
					salt: "AA==",
					time: 3,
					mem: 65536,
					par: 1,
				},
				cipher: {
					algo: "aes-256-gcm",
					nonce: "AA==",
					ct: "AA==",
				},
				dek_wrap: "AA==",
				pad: 4096,
			};
			const protectedRaw = serializeFile("Decoy body text", dummyPayload);
			const filesByPath = new Map<string, { file: TFile; content: string }>();

			const makeTFile = (p: string): TFile => {
				const f = Object.create(TFile.prototype) as TFile;
				Object.assign(f, {
					path: p,
					name: p.split("/").pop() ?? p,
					basename: (p.split("/").pop() ?? p).replace(/\.md$/, ""),
					extension: "md",
				});
				return f;
			};

			const migratedFile = makeTFile("Migrated.md");
			const scannedFile = makeTFile("ScannedUnregistered.md");
			const normalFile = makeTFile("Normal.md");
			filesByPath.set("Migrated.md", { file: migratedFile, content: protectedRaw });
			filesByPath.set("ScannedUnregistered.md", { file: scannedFile, content: protectedRaw });
			filesByPath.set("Normal.md", { file: normalFile, content: "Plain note without payload" });

			const eventOrder: string[] = [];
			const appMock = {
				vault: {
					configDir: ".obsidian",
					adapter: {
						exists: vi.fn(async (p: string) => p === ".obsidian/plugins/deocy/data.json"),
						read: vi.fn(async (p: string) => {
							if (p === ".obsidian/plugins/deocy/data.json") {
								return JSON.stringify(legacyData);
							}
							throw new Error("ENOENT");
						}),
						remove: vi.fn(async () => undefined),
					},
					getMarkdownFiles: () => [migratedFile, scannedFile, normalFile],
					getAbstractFileByPath: (p: string) => filesByPath.get(p)?.file ?? null,
					cachedRead: vi.fn(async (f: TFile) => {
						eventOrder.push(`cachedRead:${f.path}`);
						return filesByPath.get(f.path)?.content ?? "";
					}),
					read: vi.fn(async (f: TFile) => filesByPath.get(f.path)?.content ?? ""),
					modify: vi.fn(async (f: TFile, nextContent: string) => {
						const entry = filesByPath.get(f.path);
						if (entry) entry.content = nextContent;
					}),
				},
			} as unknown as App;

			const plugin = Object.create(VeneerPlugin.prototype) as VeneerPlugin;
			Object.assign(plugin, {
				app: appMock,
				manifest: { id: "veneer", dir: ".obsidian/plugins/veneer" },
				loadData: vi.fn(async () => state.savedData),
				saveData: vi.fn(async (next: Record<string, unknown>) => {
					state.savedData = next;
				}),
			});

			await plugin.migrateLegacyPluginDataIfNeeded();
			expect(state.savedData).not.toBeNull();
			expect(state.savedData?.legacyDeocyMigrated).toBe(true);
			expect(state.savedData?.duressPinSalt).toBe("deadbeef");
			expect(state.savedData?.duressPinHash).toBe("cafebabe");
			expect(state.savedData?.triggerPrefix).toBe("//custom");

			plugin.registry = new ProtectedRegistry(plugin);
			await plugin.registry.load();
			await plugin.loadSettings();
			expect(plugin.registry.has("Migrated.md")).toBe(true);

			await plugin.clearDuressPin();
			await plugin.registry.remove("Migrated.md");
			expect(state.savedData?.legacyDeocyMigrated).toBe(true);
			expect(state.savedData?.duressPinHash).toBeNull();

			const reloadedPlugin = Object.create(VeneerPlugin.prototype) as VeneerPlugin;
			Object.assign(reloadedPlugin, {
				app: appMock,
				manifest: { id: "veneer", dir: ".obsidian/plugins/veneer" },
				loadData: vi.fn(async () => state.savedData),
				saveData: vi.fn(async (next: Record<string, unknown>) => {
					state.savedData = next;
				}),
			});
			await reloadedPlugin.migrateLegacyPluginDataIfNeeded();
			reloadedPlugin.registry = new ProtectedRegistry(reloadedPlugin);
			await reloadedPlugin.registry.load();
			await reloadedPlugin.loadSettings();
			expect(reloadedPlugin.settings.duressPinHash).toBeNull();
			expect(reloadedPlugin.settings.duressPinSalt).toBeNull();
			expect(reloadedPlugin.registry.has("Migrated.md")).toBe(false);

			await plugin.registry.add("Migrated.md", {
				noteId: "note-migrated",
				addedAt: 1000,
				mode: "portable",
			});

			Object.assign(plugin, {
				sessions: {
					getCoordinator: () => ({
						beginDestruction: () => ({
							generation: 1,
							waitActiveWrites: async () => undefined,
							releaseQuarantine: () => undefined,
						}),
						enqueueFileWrite: async (
							_app: App,
							job: { task: () => Promise<void> },
						) => {
							await job.task();
						},
						nextFileRevision: () => 1,
						runDestructionPathWrite: async (
							_app: App,
							_path: string,
							task: () => Promise<void>,
						) => {
							await task();
						},
					}),
					hardKillAll: vi.fn(async () => {
						eventOrder.push("hardKillAll");
					}),
					getDecoyFallback: () => "Decoy body text",
				} as unknown as SessionManager,
			});

			await (plugin as unknown as { runShred: () => Promise<void> }).runShred();

			expect(eventOrder[0]).toBe("hardKillAll");
			expect(eventOrder.indexOf("hardKillAll")).toBeLessThan(
				eventOrder.indexOf("cachedRead:ScannedUnregistered.md"),
			);
			expect(filesByPath.get("Migrated.md")?.content).toBe("Decoy body text\n");
			expect(filesByPath.get("ScannedUnregistered.md")?.content).toBe("Decoy body text\n");
			expect(filesByPath.get("Normal.md")?.content).toBe("Plain note without payload");
		});
	});
});
