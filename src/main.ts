import { addIcon, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import fs from "fs";
import path from "path";
import type { EditorState } from "@codemirror/state";
import { DEFAULT_SETTINGS, MODEL_INFO, activeModel, type ModelId, type VeneerSettings } from "./settings";
import { ProtectedRegistry } from "./registry";
import { SessionManager, type ViewSession } from "./view/session";
import { installViewPatches } from "./view/patch";
import { buildCaptureExtension } from "./capture/UnlockCapture";
import { LockEngine } from "./lock/LockEngine";
import { StatusDots, WordCounter } from "./ui/statusBar";
import { ProtectWizard } from "./decoy/wizard";
import { PasswordModal, DuressPinModal } from "./ui/modals";
import { VeneerSettingTab } from "./ui/settingsTab";
import { DecoyGenerator } from "./llm/generator";
import { WllamaRuntime } from "./llm/runtime";
import { NativeRuntime } from "./llm/nativeRuntime";
import { selectRuntime } from "./llm/preferredRuntime";
import type { LlmRuntime } from "./llm/runtime";
import { validateDecoy } from "./llm/validate";
import { DECOY_TEMPLATES, weaveTemplate } from "./decoy/templates";
import {
	changePassword,
	createFile,
	parseFileContent,
	serializeFile,
	unlockPayload,
	type PayloadV1,
} from "./crypto/payload";
import {
	deleteStagedVaultImages,
	readLinkedVaultImages,
	restoreVaultImages,
} from "./crypto/images";
import { buildUnlockedImageExtension } from "./view/imageWidget";
import { executeShred, stripPortablePayload, type ShredTarget } from "./shred/duress";
import { fileRecoveryEnabled } from "./shred/hygiene";
import { newPinRecord, verifyPin } from "./shred/pin";
import { clearPartial, partialProgress, sha256HexOfFile } from "./llm/download";
import { sanitizeTitle, siblingPath, splitTitleFromBody, withSuffix } from "./decoy/title";

interface EditorWithCm {
	cm?: { state: EditorState };
}

export default class VeneerPlugin extends Plugin {
	settings: VeneerSettings = { ...DEFAULT_SETTINGS };
	registry!: ProtectedRegistry;
	sessions!: SessionManager;
	lockEngine!: LockEngine;
	private dots!: StatusDots;
	private wordCounter!: WordCounter;
	private generator!: DecoyGenerator;

	async onload(): Promise<void> {
		addIcon(
			"veneer-layers",
			`<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M24 12 H76 A8 8 0 0 1 84 20 V56 L58 82 H24 A8 8 0 0 1 16 74 V20 A8 8 0 0 1 24 12 Z"/><path d="M84 56 H64 A6 6 0 0 0 58 62 V82"/><line x1="30" y1="30" x2="68" y2="30"/><line x1="30" y1="44" x2="58" y2="44"/><line x1="30" y1="58" x2="46" y2="58"/><path d="M58 88 H78 A10 10 0 0 0 88 78 V58" stroke-opacity="0.65"/></svg>`,
		);
		this.registry = new ProtectedRegistry(this);
		await this.registry.load();
		await this.loadSettings();
		const disk = this.modelFileStatus();
		if (disk.exists !== this.settings.modelDownloaded) {
			this.settings.modelDownloaded = disk.exists;
			if (!disk.exists) this.settings.modelVerified = false;
			await this.saveSettings();
		}
		this.dots = new StatusDots(() => this.addStatusBarItem());
		this.wordCounter = new WordCounter(() => this.addStatusBarItem());
		this.sessions = new SessionManager(
			this.app,
			{
				onUnlocked: () => { this.lockEngine.onSessionUnlocked(); this.updateWordCounter(); },
				onLocked: () => { this.dots.reset(); this.updateWordCounter(); },
				onUnlockBlocked: () => this.warnFileRecoveryOnce(),
				onLockFailed: () => {
					new Notice(
						"Veneer: could not save your latest edits before masking. The note is masked; unlock it to check for missing changes.",
					);
				},
			},
			() => this.settings.triggerPrefix,
			() =>
				fileRecoveryEnabled(this.app)
					? "File Recovery is enabled and would snapshot plaintext to disk."
					: null,
		);
		installViewPatches(this.sessions, (cleanup) => this.register(cleanup));
		this.generator = this.buildGenerator();
		this.generator.warmup();
		this.lockEngine = new LockEngine(this, this.app.workspace, this.sessions, () => this.settings);
		this.lockEngine.start();
		void this.attachAlreadyOpenViews();

		this.registerEditorExtension(
			buildCaptureExtension({
				resolveView: (state) => this.resolveMarkdownView(state),
				getSession: (view) => this.sessions.get(view),
				lineStartOnly: () => this.settings.lineStartOnly,
				onCandidate: (session, secret) => {
					void this.handleCandidate(session, secret);
				},
				onProgress: (length) => {
					if (this.settings.showCaptureDots) this.dots.setDots(length);
				},
				onCaptureReset: () => this.dots.reset(),
			}),
		);
		this.registerEditorExtension(
			buildUnlockedImageExtension((state, link) => {
				const view = this.resolveMarkdownView(state);
				if (!view) return null;
				const session = this.sessions.get(view);
				if (!session || session.state !== "unlocked") return null;
				return session.imageUrls.get(link) ?? null;
			}),
		);

		this.registerCommands();
		this.registerFileMenu();
		this.registerFileTracking();
		this.addSettingTab(new VeneerSettingTab(this.app, this));
	}

	onunload(): void {
		this.lockEngine.stop();
		void this.generator.unload();
	}

	private recoveryWarningShown = false;

	private warnFileRecoveryOnce(): void {
		if (this.recoveryWarningShown) return;
		this.recoveryWarningShown = true;
		new Notice("Veneer: unlock blocked. Disable the File Recovery core plugin first (Settings > Core plugins).");
	}

	private async attachAlreadyOpenViews(): Promise<void> {
		const leaves: MarkdownView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) leaves.push(leaf.view);
		});
		for (const view of leaves) {
			const file = view.file;
			if (!file) continue;
			const parsed = parseFileContent(await this.app.vault.cachedRead(file));
			if (parsed) {
				this.sessions.attachFromLoad(view, file, parsed);
				view.setViewData(parsed.decoyBody, true);
			}
		}
	}

	private updateWordCounter(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.wordCounter.hide();
			return;
		}
		const session = this.sessions.get(view);
		if (!session) {
			this.wordCounter.hide();
			return;
		}
		const text = view.editor?.getValue() ?? "";
		this.wordCounter.update(text, session.state);
	}

	private resolveMarkdownView(state: EditorState): MarkdownView | null {
		const found: { view: MarkdownView | null } = { view: null };
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found.view !== null) return;
			if (leaf.view instanceof MarkdownView) {
				const cm = (leaf.view.editor as unknown as EditorWithCm).cm;
				if (cm && cm.state === state) found.view = leaf.view;
			}
		});
		return found.view;
	}

	private async handleCandidate(
		session: ViewSession,
		secret: string,
	): Promise<void> {
		this.dots.reset();
		if (secret.startsWith("!")) {
			const pinCandidate = secret.slice(1);
			const { duressPinSalt, duressPinHash } = this.settings;
			if (duressPinSalt && duressPinHash) {
				const isDuress = await verifyPin(pinCandidate, duressPinSalt, duressPinHash);
				if (isDuress) {
					await this.runShred();
					return;
				}
			}
			return;
		}
		await this.sessions.unlock(session, secret);
	}

	private async runShred(): Promise<void> {
		const targets: ShredTarget[] = this.registry
			.list()
			.map(({ path, entry }) => ({ path, mode: entry.mode }));
		const report = await executeShred(targets, {
			zeroSessions: () => this.sessions.hardKillAll(),
			rewritePortable: async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return;
				const content = await this.app.vault.read(file);
				await this.app.vault.modify(
					file,
					stripPortablePayload(content, this.sessions.getDecoyFallback(path)),
				);
			},
			deleteStealth: async (path) => {
				await this.app.vault.adapter.remove(path);
			},
			clearRegistry: () => this.registry.clear(),
		});
		console.warn(
			`Veneer: shred finished, ${report.processed}/${targets.length} destroyed, ${report.failures.length} failed`,
		);
	}

	private registerCommands(): void {
		this.addCommand({
			id: "panic-mask",
			name: "Panic: mask all protected notes",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "X" }],
			callback: () => this.lockEngine.panic(),
		});
		this.addCommand({
			id: "protect-note",
			name: "Protect this note",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (file) void this.protectFile(file);
			},
		});
		this.addCommand({
			id: "refresh-decoy",
			name: "Refresh decoy cover of this note",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (file) void this.refreshDecoy(file);
			},
		});
		this.addCommand({
			id: "unlock-note",
			name: "Unlock this note",
			callback: () => {
				void this.unlockViaModal();
			},
		});
		this.addCommand({
			id: "unprotect-note",
			name: "Unprotect this note (decrypt permanently)",
			callback: () => {
				void this.unprotectViaModal();
			},
		});
		this.addCommand({
			id: "change-password",
			name: "Change password of this note",
			callback: () => {
				void this.changePasswordViaModal();
			},
		});
		this.addCommand({
			id: "mask-note",
			name: "Mask this note (return to cover)",
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return;
				const session = this.sessions.get(view);
				if (session) {
					void this.sessions.lock(session, "manual").catch((error) => {
						console.warn("Veneer: manual mask failed", error);
					});
				}
			},
		});
		this.addCommand({
			id: "set-duress-pin",
			name: "Set destruction PIN",
			callback: () => {
				void (async () => {
					const pin = await new DuressPinModal(this.app).ask();
					if (pin !== null) {
						await this.setDuressPin(pin);
						new Notice("Destruction PIN set.");
					}
				})();
			},
		});
	}

	private registerFileMenu(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) =>
						item
							.setTitle("Protect this note")
							.setIcon("veneer-layers")
							.onClick(() => void this.protectFile(file)),
					);
				}
			}),
		);
	}

	private registerFileTracking(): void {
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				const view =
					info instanceof MarkdownView
						? info
						: this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					const session = this.sessions.get(view);
					if (session && session.state === "unlocked") {
						this.sessions.scheduleReencrypt(session);
					}
				}
				this.updateWordCounter();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					void this.registry.rename(oldPath, file.path);
					this.sessions.renamePath(oldPath, file.path);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) void this.registry.remove(file.path);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				const open = new Set<MarkdownView>();
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView) open.add(leaf.view);
				});
				this.sessions.pruneDetached(open);
			}),
		);
	}

	private async protectFile(file: TFile): Promise<void> {
		if (file.extension !== "md") {
			new Notice("Veneer protects markdown notes only.");
			return;
		}
		const content = await this.app.vault.read(file);
		if (parseFileContent(content)) {
			new Notice("This note is already protected.");
			return;
		}
		const realWordCount = content.trim().split(/\s+/).filter(Boolean).length;
		const originalTitle = file.basename;
		new ProtectWizard(this.app, {
			interests: this.settings.interests,
			names: this.settings.coverNames,
			persona: this.settings.coverPersona,
			generator: this.generator,
			llmAvailable: this.modelFileStatus().exists,
			realWordCount,
			onProtect: async ({ decoy, password }) => {
				const { title: rawTitle, body: decoyBody } = splitTitleFromBody(decoy);
				const finalBody = decoyBody.length > 0 ? decoyBody : decoy;
				const staged = await readLinkedVaultImages(this.app, file.path, content);
				const { fileContent, payload } = await createFile(
					content,
					password,
					finalBody,
					undefined,
					staged.absorbed,
					originalTitle,
				);
				if (!payload || payload.v !== 1) {
					new Notice("Protection failed: encryption error. Your original note is unchanged.");
					return;
				}
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view && view.file === file) {
					this.sessions.attachFromLoad(view, file, { decoyBody: finalBody, payload });
					view.setViewData(finalBody, true);
				}
				await this.app.vault.modify(file, fileContent);
				await deleteStagedVaultImages(this.app, staged.filesToDelete);
				if (view && view.file === file) {
					this.sessions.attachFromLoad(view, file, { decoyBody: finalBody, payload });
					view.setViewData(finalBody, true);
				}
				await this.registry.add(file.path, {
					noteId: payload.note_id,
					addedAt: Date.now(),
					mode: "portable",
				});
				await this.retitleToFile(file, rawTitle);
				new Notice("Protected. The note now reads as your cover.");
			},
		}).open();
	}

	private abortIfLiveSession(file: TFile, notice: string): boolean {
		if (!this.sessions.hasLiveSession(file.path)) return false;
		new Notice(notice);
		return true;
	}

	private async refreshDecoy(file: TFile): Promise<void> {
		const startEpoch = this.sessions.currentKillEpoch();
		try {
			for (const session of this.sessions.getAllByPath(file.path)) {
				if (session.state === "unlocked" || session.lockingPromise !== null) {
					await this.sessions.lock(session, "refresh-decoy");
				}
			}
		} catch {
			return;
		}
		const content = await this.app.vault.read(file);
		const parsed = parseFileContent(content);
		if (!parsed) {
			new Notice("Not a protected note.");
			return;
		}
		const result = await this.generator.generate(
			"auto",
			this.settings.interests,
			null,
			Date.now() % 100000,
			{
				persona: this.settings.coverPersona || undefined,
				names: this.settings.coverNames.length > 0 ? [...this.settings.coverNames] : undefined,
				now: new Date(),
			},
		);
		const { title: rawTitle, body: decoyBody } = splitTitleFromBody(result.text.trim());
		const finalBody = decoyBody.length > 0 ? decoyBody : result.text.trim();
		try {
			for (const session of this.sessions.getAllByPath(file.path)) {
				if (session.state === "unlocked" || session.lockingPromise !== null) {
					await this.sessions.lock(session, "refresh-decoy");
				}
			}
		} catch {
			return;
		}
		if (this.abortIfLiveSession(file, "Note was unlocked during refresh. Mask it and try again.")) {
			return;
		}
		const releasePath = this.sessions.reservePath(file.path);
		const previousState = new Map<
			ViewSession,
			{ decoyBody: string; originalPayload: PayloadV1 }
		>();
		try {
			const latest = parseFileContent(await this.app.vault.read(file));
			if (!latest) {
				new Notice("Not a protected note.");
				return;
			}
			for (const session of this.sessions.getAllByPath(file.path)) {
				previousState.set(session, {
					decoyBody: session.decoyBody,
					originalPayload: session.originalPayload,
				});
				session.decoyBody = finalBody;
				session.originalPayload = latest.payload;
			}
			const written = await this.sessions.runReservedWrite(startEpoch, () =>
				this.app.vault.modify(file, serializeFile(finalBody, latest.payload)),
			);
			if (!written) {
				for (const [session, prev] of previousState) {
					session.decoyBody = prev.decoyBody;
					session.originalPayload = prev.originalPayload;
				}
				return;
			}
			for (const session of this.sessions.getAllByPath(file.path)) {
				session.decoyBody = finalBody;
				session.originalPayload = latest.payload;
				if (session.view.file === file) {
					session.view.setViewData(finalBody, true);
				}
			}
		} catch (error) {
			for (const [session, prev] of previousState) {
				session.decoyBody = prev.decoyBody;
				session.originalPayload = prev.originalPayload;
			}
			console.warn("Veneer: cover refresh could not write the note", error);
			new Notice("Could not refresh the cover. The previous cover is unchanged.");
			return;
		} finally {
			releasePath();
		}
		await this.retitleToFile(file, rawTitle);
		new Notice(`Cover refreshed (${result.source}).`);
	}

	private async retitleToFile(file: TFile, rawTitle: string): Promise<void> {
		const title = sanitizeTitle(rawTitle, "Cover note");
		let newPath = siblingPath(file.path, `${title}.md`);
		if (newPath === file.path) return;
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			newPath = siblingPath(file.path, withSuffix(`${title}.md`, `-${Date.now() % 10000}`));
		}
		try {
			await this.app.fileManager.renameFile(file, newPath);
		} catch (error) {
			console.warn("Veneer: cover retitle skipped", error);
		}
	}

	private async unlockViaModal(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) return;
		let session = this.sessions.get(view);
		if (!session) {
			const parsed = parseFileContent(await this.app.vault.cachedRead(view.file));
			if (!parsed) {
				new Notice("Not a protected note.");
				return;
			}
			session = this.sessions.attachFromLoad(view, view.file, parsed);
			view.setViewData(parsed.decoyBody, true);
		}
		const password = await new PasswordModal(this.app, "Unlock this note").ask();
		if (password === null) return;
		await this.sessions.unlock(session, password);
	}

	private async changePasswordViaModal(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const startEpoch = this.sessions.currentKillEpoch();
		try {
			for (const activeSession of this.sessions.getAllByPath(file.path)) {
				if (activeSession.state === "unlocked" || activeSession.lockingPromise !== null) {
					await this.sessions.lock(activeSession, "change-password");
				}
			}
		} catch {
			return;
		}
		const content = await this.app.vault.read(file);
		const parsed = parseFileContent(content);
		if (!parsed) {
			new Notice("Not a protected note.");
			return;
		}
		const oldPassword = await new PasswordModal(this.app, "Current password").ask();
		if (oldPassword === null) return;
		const newPassword = await new PasswordModal(this.app, "New password (8+ characters)").ask();
		if (newPassword === null) return;
		if (newPassword.length < 8) {
			new Notice("New password must be at least 8 characters.");
			return;
		}
		try {
			for (const activeSession of this.sessions.getAllByPath(file.path)) {
				if (activeSession.state === "unlocked" || activeSession.lockingPromise !== null) {
					await this.sessions.lock(activeSession, "change-password");
				}
			}
			if (
				this.abortIfLiveSession(
					file,
					"Note was unlocked during password change. Mask it and try again.",
				)
			) {
				return;
			}
			const releasePath = this.sessions.reservePath(file.path);
			const previousPayloads = new Map<
				ViewSession,
				{ original: PayloadV1; pending: PayloadV1 | null }
			>();
			try {
				const latestParsed = parseFileContent(await this.app.vault.read(file));
				if (!latestParsed) {
					new Notice("Not a protected note.");
					return;
				}
				const rotated = await changePassword(latestParsed.payload, oldPassword, newPassword);
				for (const openSession of this.sessions.getAllByPath(file.path)) {
					previousPayloads.set(openSession, {
						original: openSession.originalPayload,
						pending: openSession.pendingPayload,
					});
					openSession.originalPayload = rotated;
					if (openSession.pendingPayload !== null) {
						openSession.pendingPayload = rotated;
					}
				}
				const written = await this.sessions.runReservedWrite(startEpoch, () =>
					this.app.vault.modify(file, serializeFile(latestParsed.decoyBody, rotated)),
				);
				if (!written) {
					for (const [openSession, prev] of previousPayloads) {
						openSession.originalPayload = prev.original;
						openSession.pendingPayload = prev.pending;
					}
					return;
				}
				for (const openSession of this.sessions.getAllByPath(file.path)) {
					openSession.originalPayload = rotated;
					if (openSession.pendingPayload !== null) {
						openSession.pendingPayload = rotated;
					}
				}
			} catch (error) {
				for (const [openSession, prev] of previousPayloads) {
					openSession.originalPayload = prev.original;
					openSession.pendingPayload = prev.pending;
				}
				throw error;
			} finally {
				releasePath();
			}
			new Notice("Password changed.");
		} catch {
			new Notice("Password change failed.");
		}
	}

	private async unprotectViaModal(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const startEpoch = this.sessions.currentKillEpoch();
		try {
			for (const activeSession of this.sessions.getAllByPath(file.path)) {
				if (activeSession.state === "unlocked" || activeSession.lockingPromise !== null) {
					await this.sessions.lock(activeSession, "unprotect");
				}
			}
		} catch {
			return;
		}
		const content = await this.app.vault.read(file);
		const parsed = parseFileContent(content);
		if (!parsed) {
			new Notice("Not a protected note.");
			return;
		}
		const password = await new PasswordModal(this.app, "Unprotect permanently").ask();
		if (password === null) return;
		try {
			for (const activeSession of this.sessions.getAllByPath(file.path)) {
				if (activeSession.state === "unlocked" || activeSession.lockingPromise !== null) {
					await this.sessions.lock(activeSession, "unprotect");
				}
			}
			if (this.abortIfLiveSession(file, "Note was unlocked during unprotect. Mask it and try again.")) {
				return;
			}
			const openSessions = this.sessions.getAllByPath(file.path);
			const releasePath = this.sessions.reservePath(file.path);
			let realTitle: string | null = null;
			try {
				const latestParsed = parseFileContent(await this.app.vault.read(file));
				if (!latestParsed) {
					new Notice("Not a protected note.");
					return;
				}
				const unlocked = await unlockPayload(latestParsed.payload, password);
				unlocked.dek.fill(0);
				const realText = unlocked.realText;
				realTitle = unlocked.realTitle;
				if (this.sessions.currentKillEpoch() !== startEpoch) return;
				await restoreVaultImages(this.app, file.parent?.path ?? "", unlocked.images);
				if (this.sessions.currentKillEpoch() !== startEpoch) return;
				try {
					const written = await this.sessions.runReservedWrite(startEpoch, () =>
						this.app.vault.modify(file, `${realText}\n`),
					);
					if (!written) return;
				} catch (error) {
					console.warn("Veneer: unprotect could not write the note", error);
					new Notice("Could not write the unprotected note. The note is still masked.");
					return;
				}
				// Detach while the path is still reserved. Releasing first would replay any
				// save queued during the reservation against a still-attached, still-masked
				// session, re-serializing decoy + ciphertext over the plaintext just written.
				// Detaching here makes `sessions.get(view)` falsy, so a replayed save falls
				// through to the editor's real text instead.
				const targetSessions = new Set<ViewSession>([
					...openSessions,
					...this.sessions.getAllByPath(file.path),
				]);
				for (const session of targetSessions) {
					const detached = this.sessions.discardAndDetach(session);
					if (detached === true && session.view.file === file) {
						session.view.setViewData(realText, true);
					}
				}
			} finally {
				releasePath();
			}
			await this.registry.remove(file.path);
			if (realTitle && realTitle.trim().length > 0) {
				await this.retitleToFile(file, realTitle);
			}
			new Notice("Note is now a normal note.");
		} catch {
			return;
		}
	}

	async setDuressPin(pin: string): Promise<void> {
		const record = await newPinRecord(pin);
		this.settings.duressPinSalt = record.salt;
		this.settings.duressPinHash = record.hash;
		await this.saveSettings();
	}

	async clearDuressPin(): Promise<void> {
		this.settings.duressPinSalt = null;
		this.settings.duressPinHash = null;
		await this.saveSettings();
	}

	private buildGenerator(): DecoyGenerator {
		const runtime = this.settings.modelDownloaded ? this.buildRuntime() : null;
		return new DecoyGenerator({
			runtime,
			validate: (candidate, real) => validateDecoy(candidate, real),
			fallbackTemplate: (seed) => {
				const template = DECOY_TEMPLATES[seed % DECOY_TEMPLATES.length];
				return weaveTemplate(template, {
					topics: [...this.settings.interests],
					names: [...this.settings.coverNames],
					now: new Date(),
					seed,
				});
			},
		});
	}

	private buildRuntime(): LlmRuntime {
		const model = activeModel(this.settings);
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const root = adapter.getBasePath?.() ?? "";
		const base = path.join(root, this.app.vault.configDir, "plugins", "deocy");
		const modelPath = path.join(base, "models", model.file);
		
		const wllama = new WllamaRuntime(
			modelPath,
			path.join(base, "assets", "wllama", "wasm", "wllama.wasm"),
		);

		const engineDir = path.join(base, "assets", "llama-vulkan");
		const executablePath = path.join(engineDir, "llama-server.exe");
		const executableExists = fs.existsSync(executablePath);

		const native = new NativeRuntime({ engineDir, executablePath, modelPath });

		return selectRuntime(process.platform, executableExists, native, wllama);
	}

	modelFileStatus(): {
		exists: boolean;
		sizeBytes: number;
		fileName: string;
		partial: { downloaded: number; total: number | null } | null;
	} {
		const model = activeModel(this.settings);
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const root = adapter.getBasePath?.() ?? "";
		const abs = `${root}/${this.app.vault.configDir}/plugins/deocy/models/${model.file}`;
		let exists = false;
		let sizeBytes = 0;
		try {
			const stat = fs.statSync(abs);
			exists = stat.isFile() && stat.size > 0;
			sizeBytes = stat.size;
		} catch {
			exists = false;
		}
		return { exists, sizeBytes, fileName: model.file, partial: exists ? null : partialProgress(abs) };
	}

	downloadedModels(): { fileName: string; sizeBytes: number; modelId: ModelId | "custom" }[] {
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const root = adapter.getBasePath?.() ?? "";
		const dir = `${root}/${this.app.vault.configDir}/plugins/deocy/models`;
		const results: { fileName: string; sizeBytes: number; modelId: ModelId | "custom" }[] = [];
		try {
			const files = fs.readdirSync(dir);
			for (const file of files) {
				if (!file.endsWith(".gguf")) continue;
				const stat = fs.statSync(`${dir}/${file}`);
				if (!stat.isFile() || stat.size === 0) continue;
				const builtin = Object.entries(MODEL_INFO).find(([, info]) => info.file === file);
				results.push({
					fileName: file,
					sizeBytes: stat.size,
					modelId: builtin ? (builtin[0] as ModelId) : "custom",
				});
			}
		} catch {
		}
		return results;
	}

	async deleteModelFile(): Promise<void> {
		const model = activeModel(this.settings);
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const root = adapter.getBasePath?.() ?? "";
		const abs = `${root}/${this.app.vault.configDir}/plugins/deocy/models/${model.file}`;
		try {
			if (fs.existsSync(abs)) fs.unlinkSync(abs);
			clearPartial(abs);
		} catch (error) {
			console.warn("Veneer: model delete skipped", error);
		}
		this.settings.modelDownloaded = false;
		this.settings.modelVerified = false;
		await this.saveSettings();
		this.rebuildGenerator();
	}

	async modelsDir(): Promise<{ abs: string; rel: string }> {
		const rel = `${this.app.vault.configDir}/plugins/deocy/models`;
		await this.app.vault.adapter.mkdir(rel);
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		return { abs: `${adapter.getBasePath?.() ?? ""}/${rel}`, rel };
	}

	async removeModelFile(rel: string): Promise<void> {
		await this.app.vault.adapter.remove(rel);
	}

	rebuildGenerator(): void {
		void this.generator.unload();
		this.generator = this.buildGenerator();
		this.generator.warmup();
	}

	async importLocalModelFlow(
		sourcePath: string,
	): Promise<{ ok: boolean; sha256: string | null; error: string | null }> {
		try {
			if (!sourcePath.toLowerCase().endsWith(".gguf")) {
				return { ok: false, sha256: null, error: "Pick a .gguf model file." };
			}
			const dir = await this.modelsDir();
			const fileName = sourcePath.split(/[\\/]/).pop() ?? "custom-model.gguf";
			const dest = `${dir.abs}/${fileName}`;
			fs.copyFileSync(sourcePath, dest);
			const sizeBytes = fs.statSync(dest).size;
			const sha256 = await sha256HexOfFile(dest);
			this.settings.customModel = { file: fileName, url: null, sizeBytes, label: fileName };
			this.settings.modelId = "custom";
			this.settings.modelDownloaded = true;
			await this.saveSettings();
			this.rebuildGenerator();
			return { ok: true, sha256, error: null };
		} catch (error) {
			console.warn("Veneer: local model import failed", error);
			return { ok: false, sha256: null, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async testModelFlow(): Promise<string> {
		const result = await this.generator.generate(
			"auto",
			this.settings.interests,
			null,
			Date.now() % 100000,
			{
				persona: this.settings.coverPersona || undefined,
				names: this.settings.coverNames.length > 0 ? [...this.settings.coverNames] : undefined,
				now: new Date(),
			},
		);
		return `[${result.source}] ${result.text.trim().slice(0, 400)}`;
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as (Partial<VeneerSettings> & { entries?: unknown }) | null;
		const { entries: _entries, ...rest } = raw ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...rest };
	}

	async saveSettings(): Promise<void> {
		await this.saveData({
			...this.settings,
			entries: this.registry ? this.registry.entriesRecord() : {},
		});
	}
}
