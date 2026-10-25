import { addIcon, FileSystemAdapter, MarkdownView, normalizePath, Notice, Plugin, TFile } from "obsidian";
import fs from "fs";
import path from "path";
import type { EditorState } from "@codemirror/state";
import { DEFAULT_SETTINGS, MODEL_INFO, activeModel, type ModelId, type VeneerSettings } from "./settings";
import { ProtectedRegistry } from "./registry";
import { SessionManager, type ShutdownHandoffResult, type ViewSession } from "./view/session";
import { installViewPatches, type ViewPatchController } from "./view/patch";
import { getSharedLifecycleCoordinator, type ViewLifecycleCoordinator } from "./view/lifecycle";
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

export type ClosableModal = {
	cancelAndClose?: () => void;
	close?: () => void;
	onClose?: () => void;
};

export default class VeneerPlugin extends Plugin {
	private static pendingGeneratorUnload: Promise<void> | null = null;
	settings: VeneerSettings = { ...DEFAULT_SETTINGS };
	registry!: ProtectedRegistry;
	sessions!: SessionManager;
	lockEngine!: LockEngine;
	patchController?: ViewPatchController;
	viewPatchController?: ViewPatchController;
	private dots!: StatusDots;
	private wordCounter!: WordCounter;
	private generator!: DecoyGenerator;
	private isShuttingDown = false;
	private teardownDone = false;
	private modelDeletionInFlight = false;
	private modelDeletionEpoch = 0;
	private activeModals?: Set<ClosableModal>;
	private legacyDeocyMigrated = false;

	/** Returns the shared `ViewLifecycleCoordinator` from the active session manager or global singleton. */
	private getCoordinator(): ViewLifecycleCoordinator {
		return this.sessions ? this.sessions.getCoordinator() : getSharedLifecycleCoordinator();
	}

	/** Returns true while this plugin instance is active and has not entered teardown or session disposal. */
	isLive(): boolean {
		if (this.isShuttingDown || this.teardownDone) return false;
		if (this.sessions && this.sessions.isDisposed()) return false;
		return true;
	}

	/** Tracks an open modal so it can be synchronously cancelled and closed during plugin teardown. */
	trackModal<T extends ClosableModal>(modal: T): T {
		if (!this.activeModals) {
			this.activeModals = new Set<ClosableModal>();
		}
		this.activeModals.add(modal);
		const origOnClose = modal.onClose?.bind(modal);
		modal.onClose = (): void => {
			this.activeModals?.delete(modal);
			origOnClose?.();
		};
		return modal;
	}

	/** Synchronously cancels and closes all currently tracked open modals during teardown. */
	private closeTrackedModals(): void {
		if (!this.activeModals || this.activeModals.size === 0) return;
		const openModals = [...this.activeModals];
		this.activeModals.clear();
		for (const modal of openModals) {
			try {
				if (typeof modal.cancelAndClose === "function") {
					modal.cancelAndClose();
				} else if (typeof modal.close === "function") {
					modal.close();
				} else {
					modal.onClose?.();
				}
			} catch {
				// Isolate modal close failures during synchronous teardown
			}
		}
	}

	/**
	 * Migrates settings, destruction PIN records, and protected-note registry entries from
	 * a legacy `deocy/data.json` installation when upgrading to `veneer`.
	 */
	async migrateLegacyPluginDataIfNeeded(): Promise<void> {
		try {
			const configDir = this.app?.vault?.configDir || ".obsidian";
			const legacyPluginId = "deocy";
			const legacyDirRel = normalizePath(`${configDir}/plugins/${legacyPluginId}`);
			if (this.pluginDirPaths().rel === legacyDirRel) return;

			const legacyDataRel = normalizePath(`${legacyDirRel}/data.json`);
			const adapter = this.app?.vault?.adapter as
				| {
						exists?: (p: string) => Promise<boolean>;
						read?: (p: string) => Promise<string>;
						getBasePath?: () => string;
				  }
				| undefined;

			let legacyRawText: string | null = null;
			if (typeof adapter?.read === "function") {
				const exists =
					typeof adapter.exists === "function" ? await adapter.exists(legacyDataRel) : true;
				if (exists) {
					try {
						legacyRawText = await adapter.read(legacyDataRel);
					} catch {
						legacyRawText = null;
					}
				}
			} else {
				const root =
					adapter instanceof FileSystemAdapter
						? adapter.getBasePath()
						: (adapter?.getBasePath?.() ?? "");
				if (root) {
					const legacyAbs = path.join(root, ...legacyDataRel.split("/"));
					if (fs.existsSync(legacyAbs)) {
						legacyRawText = fs.readFileSync(legacyAbs, "utf8");
					}
				}
			}
			if (!legacyRawText) return;

			const parsedLegacy: unknown = JSON.parse(legacyRawText);
			if (!parsedLegacy || typeof parsedLegacy !== "object") return;
			const legacyObj = parsedLegacy as Record<string, unknown>;

			const currentRaw = (await this.loadData()) as Record<string, unknown> | null;
			if (currentRaw?.legacyDeocyMigrated === true) {
				this.legacyDeocyMigrated = true;
				return;
			}
			const legacyEntries =
				legacyObj.entries && typeof legacyObj.entries === "object"
					? (legacyObj.entries as Record<string, unknown>)
					: {};
			const currentEntries =
				currentRaw?.entries && typeof currentRaw.entries === "object"
					? (currentRaw.entries as Record<string, unknown>)
					: {};

			const mergedEntries = { ...legacyEntries, ...currentEntries };
			const mergedData: Record<string, unknown> =
				currentRaw === null
					? { ...legacyObj, entries: mergedEntries, legacyDeocyMigrated: true }
					: {
							...legacyObj,
							...currentRaw,
							duressPinSalt:
								currentRaw.duressPinSalt ?? legacyObj.duressPinSalt ?? null,
							duressPinHash:
								currentRaw.duressPinHash ?? legacyObj.duressPinHash ?? null,
							entries: mergedEntries,
							legacyDeocyMigrated: true,
					  };
			this.legacyDeocyMigrated = true;
			await this.saveData(mergedData);
		} catch (error) {
			console.warn("Veneer: legacy deocy data migration skipped", error);
		}
	}

	/** Initializes plugin state, lifecycle coordination, view patches, lock engine, and commands. */
	async onload(): Promise<void> {
		this.isShuttingDown = false;
		this.teardownDone = false;
		const coordinator = getSharedLifecycleCoordinator();
		try {
			await coordinator.predecessorReady(this.app);
		} catch (error) {
			console.warn("Veneer: predecessor retirement failed; continuing load", error);
		}
		if (!this.isLive()) return;

		addIcon(
			"veneer-layers",
			`<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M24 12 H76 A8 8 0 0 1 84 20 V56 L58 82 H24 A8 8 0 0 1 16 74 V20 A8 8 0 0 1 24 12 Z"/><path d="M84 56 H64 A6 6 0 0 0 58 62 V82"/><line x1="30" y1="30" x2="68" y2="30"/><line x1="30" y1="44" x2="58" y2="44"/><line x1="30" y1="58" x2="46" y2="58"/><path d="M58 88 H78 A10 10 0 0 0 88 78 V58" stroke-opacity="0.65"/></svg>`,
		);
		await this.migrateLegacyPluginDataIfNeeded();
		if (!this.isLive()) return;
		this.registry = new ProtectedRegistry(this);
		await this.registry.load();
		if (!this.isLive()) return;
		await this.loadSettings();
		if (!this.isLive()) return;
		const disk = this.modelFileStatus();
		if (disk.exists !== this.settings.modelDownloaded) {
			this.settings.modelDownloaded = disk.exists;
			if (!disk.exists) this.settings.modelVerified = false;
			await this.saveSettings();
			if (!this.isLive()) return;
		}
		this.dots = new StatusDots(() => this.addStatusBarItem());
		this.wordCounter = new WordCounter(() => this.addStatusBarItem());
		this.sessions = new SessionManager(
			this.app,
			{
				onUnlocked: () => {
					if (!this.isLive()) return;
					this.lockEngine?.onSessionUnlocked();
					this.updateWordCounter();
				},
				onLocked: () => {
					this.dots?.reset();
					if (this.isLive()) {
						this.lockEngine?.applyContentProtection();
						this.updateWordCounter();
					}
				},
				onUnlockBlocked: () => {
					if (!this.isLive()) return;
					this.warnFileRecoveryOnce();
				},
				onLockFailed: () => {
					if (!this.isLive()) return;
					new Notice(
						"Veneer: could not save your latest edits before masking. The note is masked; unlock it to check for missing changes.",
					);
				},
				onAttached: (file, payload) => {
					if (!this.isLive() || !this.registry) return;
					if (this.registry.has(file.path)) return;
					void this.registry.ensure(file.path, {
						noteId: payload.note_id,
						addedAt: Date.now(),
						mode: "portable",
					});
				},
			},
			() => this.settings.triggerPrefix,
			() =>
				fileRecoveryEnabled(this.app)
					? "File Recovery is enabled and would snapshot plaintext to disk."
					: null,
			coordinator,
		);
		const controller = installViewPatches(this.sessions, (cleanup) => {
			this.register(() => {
				this.teardown();
				cleanup();
			});
		});
		this.patchController = controller;
		this.viewPatchController = controller;
		this.generator = this.buildGenerator(VeneerPlugin.pendingGeneratorUnload ?? undefined);
		this.lockEngine = new LockEngine(this, this.app.workspace, this.sessions, () => this.settings);
		this.lockEngine.start();
		void this.attachAlreadyOpenViews();

		this.registerEditorExtension(
			buildCaptureExtension({
				resolveView: (state) => this.resolveMarkdownView(state),
				getSession: (view) => (this.isLive() ? this.sessions.get(view) : null),
				lineStartOnly: () => this.settings.lineStartOnly,
				onCandidate: (session, secret) => {
					void this.handleCandidate(session, secret);
				},
				onProgress: (length) => {
					if (this.isLive() && this.settings.showCaptureDots) this.dots?.setDots(length);
				},
				onCaptureReset: () => this.dots?.reset(),
			}),
		);
		this.registerEditorExtension(
			buildUnlockedImageExtension((state, link) => {
				if (!this.isLive()) return null;
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

	/**
	 * Synchronously retires sessions, hands off open views to safe snapshots, closes modals,
	 * and stops timers and background resources. Idempotent across repeated calls.
	 */
	teardown(): ShutdownHandoffResult | null {
		this.isShuttingDown = true;

		if (this.teardownDone) {
			const existingController = this.patchController ?? this.viewPatchController;
			if (existingController) {
				try {
					return existingController.retireAndHandoff();
				} catch {
					// Ignore repeated handoff errors
				}
			}
			return this.sessions?.getShutdownHandoffResult() ?? null;
		}
		this.teardownDone = true;

		const hadUnlockedSession = this.sessions
			? this.sessions.all().some((s) => s.state === "unlocked")
			: false;

		let handoff: ShutdownHandoffResult | null = null;
		const controller = this.patchController ?? this.viewPatchController;
		if (controller) {
			try {
				handoff = controller.retireAndHandoff();
			} catch (error) {
				console.warn("Veneer: patch controller retireAndHandoff encountered an error", error);
			}
		}
		if (handoff === null && this.sessions) {
			try {
				handoff = this.sessions.shutdownAndHandoff();
				const coordinator = this.sessions.getCoordinator();
				const owner = this.sessions.getOwnerToken();
				void coordinator
					.beginRetirement(this.app, owner, handoff.retirementSpecs)
					.catch((error) => {
						console.warn("Veneer: retirement drain failed", error);
					});
			} catch (error) {
				console.warn("Veneer: session shutdownAndHandoff encountered an error", error);
			}
		}

		this.closeTrackedModals();

		try {
			this.lockEngine?.stop();
		} catch (error) {
			console.warn("Veneer: lockEngine stop failed", error);
		}

		if (hadUnlockedSession && this.settings?.clearClipboardOnLock && this.lockEngine?.clipboard) {
			try {
				void Promise.resolve(this.lockEngine.clipboard.clearIfTainted()).catch(() => undefined);
			} catch {
				// Best-effort clipboard clear must never block synchronous teardown
			}
		}

		try {
			this.dots?.reset();
		} catch {}

		try {
			this.wordCounter?.hide();
		} catch {}

		try {
			const unloadRes = this.generator?.unload(true);
			if (unloadRes) {
				const trackedUnload = Promise.resolve(unloadRes).catch((error) => {
					console.warn("Veneer: generator unload failed", error);
				});
				const settledUnload = trackedUnload.finally(() => {
					if (VeneerPlugin.pendingGeneratorUnload === settledUnload) {
						VeneerPlugin.pendingGeneratorUnload = null;
					}
				});
				VeneerPlugin.pendingGeneratorUnload = settledUnload;
			}
		} catch (error) {
			console.warn("Veneer: generator unload failed", error);
		}

		return handoff;
	}

	/** Obsidian lifecycle hook invoked when the plugin is disabled or unloaded. */
	onunload(): void {
		this.teardown();
	}

	private recoveryWarningShown = false;

	/** Displays a one-time notice when Obsidian's File Recovery core plugin blocks unlocking. */
	private warnFileRecoveryOnce(): void {
		if (!this.isLive()) return;
		if (this.recoveryWarningShown) return;
		this.recoveryWarningShown = true;
		new Notice("Veneer: unlock blocked. Disable the File Recovery core plugin first (Settings > Core plugins).");
	}

	/**
	 * Waits for any predecessor plugin retirement barrier on `file` to settle.
	 * When `explicitRetry` is true (user-initiated command), clears a prior failed
	 * barrier before waiting and surfaces a user `Notice` if waiting still fails.
	 */
	private async awaitPredecessor(file: TFile, explicitRetry = false): Promise<boolean> {
		const coordinator = this.getCoordinator();
		if (explicitRetry) {
			coordinator.clearBarrierFailure(this.app, file);
		}
		try {
			await coordinator.predecessorReady(this.app, file);
			return true;
		} catch (error) {
			console.warn("Veneer: predecessor retirement barrier failed", error);
			if (this.isLive()) {
				new Notice("Veneer: a previous save for this note failed. Check the note, then retry.");
			}
			return false;
		}
	}

	/** Attaches locked sessions to any already-open markdown views once predecessor retirement settles. */
	private async attachAlreadyOpenViews(): Promise<void> {
		if (!this.isLive()) return;
		const coordinator = this.getCoordinator();
		try {
			await coordinator.predecessorReady(this.app);
		} catch (error) {
			console.warn("Veneer: predecessor retirement failed; skipping automatic view attachment", error);
			return;
		}
		if (!this.isLive()) return;

		const leaves: MarkdownView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) leaves.push(leaf.view);
		});
		for (const view of leaves) {
			if (!this.isLive()) return;
			const file = view.file;
			if (!file) continue;
			try {
				await coordinator.predecessorReady(this.app, file);
			} catch (error) {
				console.warn(`Veneer: skipping automatic attachment for ${file.path}`, error);
				continue;
			}
			if (!this.isLive() || view.file !== file) continue;
			const raw = await this.app.vault.cachedRead(file);
			if (!this.isLive() || view.file !== file) continue;
			const parsed = parseFileContent(raw);
			if (parsed) {
				this.sessions.attachFromLoad(view, file, parsed);
				view.setViewData(parsed.decoyBody, true);
			}
		}
	}

	/** Refreshes the status bar word counter for the currently active protected markdown view. */
	private updateWordCounter(): void {
		if (!this.isLive()) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.wordCounter?.hide();
			return;
		}
		const session = this.sessions.get(view);
		if (!session) {
			this.wordCounter?.hide();
			return;
		}
		const text = view.editor?.getValue() ?? "";
		this.wordCounter?.update(text, session.state);
	}

	/** Resolves the workspace `MarkdownView` owning the given CodeMirror `EditorState`, if any. */
	private resolveMarkdownView(state: EditorState): MarkdownView | null {
		if (!this.isLive()) return null;
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

	/** Handles an in-editor captured trigger candidate, routing `!` prefixes to duress verification or unlocking the session. */
	private async handleCandidate(
		session: ViewSession,
		secret: string,
	): Promise<void> {
		this.dots?.reset();
		if (!this.isLive()) return;
		if (secret.startsWith("!")) {
			const pinCandidate = secret.slice(1);
			const { duressPinSalt, duressPinHash } = this.settings;
			if (duressPinSalt && duressPinHash) {
				const isDuress = await verifyPin(pinCandidate, duressPinSalt, duressPinHash);
				if (!this.isLive()) return;
				if (isDuress) {
					await this.runShred();
					return;
				}
			}
			return;
		}
		if (!this.isLive()) return;
		await this.sessions.unlock(session, secret);
	}

	/** Executes emergency duress destruction across all registered protected notes. */
	private async runShred(): Promise<void> {
		const coordinator = this.getCoordinator();
		const targets: ShredTarget[] = this.registry
			.list()
			.map(({ path: p, entry }) => ({ path: p, mode: entry.mode }));
		const seenPaths = new Set(targets.map((t) => t.path));
		const targetFiles = new Map<string, TFile>();
		const coordinatorTargets: Array<{ file?: TFile; path: string }> = [];
		for (const t of targets) {
			const abs = this.app.vault.getAbstractFileByPath(t.path);
			if (abs instanceof TFile) {
				targetFiles.set(t.path, abs);
				coordinatorTargets.push({ file: abs, path: t.path });
			} else {
				coordinatorTargets.push({ path: t.path });
			}
		}

		let destruction = coordinator.beginDestruction(this.app, coordinatorTargets);
		await this.sessions.hardKillAll();
		this.lockEngine?.applyContentProtection();

		const scannedPortablePaths = new Set<string>();
		if (typeof this.app.vault.getMarkdownFiles === "function") {
			const extraCoordinatorTargets: Array<{ file?: TFile; path: string }> = [];
			for (const mdFile of this.app.vault.getMarkdownFiles()) {
				if (seenPaths.has(mdFile.path)) continue;
				try {
					const raw =
						typeof this.app.vault.cachedRead === "function"
							? await this.app.vault.cachedRead(mdFile)
							: await this.app.vault.read(mdFile);
					if (parseFileContent(raw) !== null) {
						seenPaths.add(mdFile.path);
						scannedPortablePaths.add(mdFile.path);
						targets.push({ path: mdFile.path, mode: "portable" });
						targetFiles.set(mdFile.path, mdFile);
						extraCoordinatorTargets.push({ file: mdFile, path: mdFile.path });
					}
				} catch {
					// Ignore unreadable files during emergency vault scan
				}
			}
			if (extraCoordinatorTargets.length > 0) {
				destruction = coordinator.beginDestruction(this.app, [
					...coordinatorTargets,
					...extraCoordinatorTargets,
				]);
			}
		}

		const report = await executeShred(targets, {
			zeroSessions: async () => {
				await this.sessions.hardKillAll();
				await destruction.waitActiveWrites();
			},
			rewritePortable: async (targetPath) => {
				const file =
					targetFiles.get(targetPath) ??
					(this.app.vault.getAbstractFileByPath(targetPath) instanceof TFile
						? (this.app.vault.getAbstractFileByPath(targetPath) as TFile)
						: null);
				if (!file) {
					destruction.releaseQuarantine(undefined, targetPath);
					return;
				}
				const fallbackDecoy = this.sessions.getDecoyFallback(targetPath);
				try {
					await coordinator.enqueueFileWrite(this.app, {
						file,
						owner: null,
						kind: "destruction",
						destructionGeneration: destruction.generation,
						task: async () => {
							const content = await this.app.vault.read(file);
							if (
								scannedPortablePaths.has(targetPath) &&
								parseFileContent(content) === null
							) {
								throw new Error("Scanned portable payload is no longer present");
							}
							const stripped = stripPortablePayload(content, fallbackDecoy);
							await this.app.vault.modify(file, stripped);
						},
						dispositionOnCommit: {
							kind: "destroyed",
							revision: coordinator.nextFileRevision(this.app, file),
							...(fallbackDecoy ? { decoyBody: fallbackDecoy } : {}),
						},
					});
				} finally {
					destruction.releaseQuarantine(file, targetPath);
				}
			},
			deleteStealth: async (targetPath) => {
				try {
					await coordinator.runDestructionPathWrite(
						this.app,
						targetPath,
						async () => {
							await this.app.vault.adapter.remove(targetPath);
						},
						destruction.generation,
					);
				} finally {
					destruction.releaseQuarantine(undefined, targetPath);
				}
			},
			clearRegistry: async (succeededPaths) => {
				if (succeededPaths === undefined || succeededPaths.length === targets.length) {
					await this.registry.clear();
					return;
				}
				for (const succeededPath of succeededPaths) {
					await this.registry.remove(succeededPath);
				}
			},
		});
		console.warn(
			`Veneer: shred finished, ${report.processed}/${targets.length} destroyed, ${report.failures.length} failed`,
		);
	}

	/** Registers all command palette actions and hotkeys for Veneer. */
	private registerCommands(): void {
		this.addCommand({
			id: "panic-mask",
			name: "Panic: mask all protected notes",
			callback: () => {
				if (!this.isLive()) return;
				this.lockEngine.panic();
			},
		});
		this.addCommand({
			id: "protect-note",
			name: "Protect this note",
			checkCallback: (checking: boolean) => {
				if (!this.isLive()) return false;
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					void this.protectFile(file);
				}
				return true;
			},
		});
		this.addCommand({
			id: "refresh-decoy",
			name: "Refresh decoy cover of this note",
			checkCallback: (checking: boolean) => {
				if (!this.isLive()) return false;
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					void this.refreshDecoy(file);
				}
				return true;
			},
		});
		this.addCommand({
			id: "unlock-note",
			name: "Unlock this note",
			checkCallback: (checking: boolean) => {
				if (!this.isLive()) return false;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file || view.file.extension !== "md") return false;
				if (!checking) {
					void this.unlockViaModal();
				}
				return true;
			},
		});
		this.addCommand({
			id: "unprotect-note",
			name: "Unprotect this note (decrypt permanently)",
			checkCallback: (checking: boolean) => {
				if (!this.isLive()) return false;
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					void this.unprotectViaModal();
				}
				return true;
			},
		});
		this.addCommand({
			id: "change-password",
			name: "Change password of this note",
			checkCallback: (checking: boolean) => {
				if (!this.isLive()) return false;
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					void this.changePasswordViaModal();
				}
				return true;
			},
		});
		this.addCommand({
			id: "mask-note",
			name: "Mask this note (return to cover)",
			checkCallback: (checking: boolean) => {
				if (!this.isLive()) return false;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				const session = this.sessions.get(view);
				if (!session) return false;
				if (!checking) {
					void this.sessions.lock(session, "manual").catch((error) => {
						console.warn("Veneer: manual mask failed", error);
					});
				}
				return true;
			},
		});
		this.addCommand({
			id: "set-duress-pin",
			name: "Set destruction PIN",
			callback: () => {
				if (!this.isLive()) return;
				void (async () => {
					const modal = this.trackModal(new DuressPinModal(this.app));
					const pin = await modal.ask();
					if (pin !== null && this.isLive()) {
						await this.setDuressPin(pin);
						if (this.isLive()) {
							new Notice("Destruction PIN set.");
						}
					}
				})();
			},
		});
	}

	/** Registers the file explorer context menu item for protecting markdown notes. */
	private registerFileMenu(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!this.isLive()) return;
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) =>
						item
							.setTitle("Protect this note")
							.setIcon("veneer-layers")
							.onClick(() => {
								if (this.isLive()) void this.protectFile(file);
							}),
					);
				}
			}),
		);
	}

	/** Registers workspace and vault event listeners for editor changes, renames, deletions, and active leaf changes. */
	private registerFileTracking(): void {
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				if (!this.isLive()) return;
				const view =
					info instanceof MarkdownView
						? info
						: this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					const session = this.sessions.get(view);
					if (session && session.state === "unlocked") {
						this.sessions.scheduleReencrypt(session);
					} else if (session && session.state === "locked" && session.lockingPromise === null) {
						this.sessions.observeCoverEdit(session);
					}
				}
				this.updateWordCounter();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.isLive()) return;
				if (file instanceof TFile) {
					void this.registry.rename(oldPath, file.path);
					this.sessions.renamePath(oldPath, file.path);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.isLive()) return;
				if (file instanceof TFile) void this.registry.remove(file.path);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (!this.isLive()) return;
				const open = new Set<MarkdownView>();
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView) open.add(leaf.view);
				});
				this.sessions.pruneDetached(open);
			}),
		);
	}

	/** Opens the protection wizard for `file` and encrypts its content behind a decoy cover. */
	private async protectFile(file: TFile): Promise<void> {
		if (!this.isLive()) return;
		if (file.extension !== "md") {
			new Notice("Veneer protects markdown notes only.");
			return;
		}
		if (!(await this.awaitPredecessor(file, true))) return;
		if (!this.isLive()) return;
		const content = await this.app.vault.read(file);
		if (!this.isLive()) return;
		if (parseFileContent(content)) {
			new Notice("This note is already protected.");
			return;
		}
		const realWordCount = content.trim().split(/\s+/).filter(Boolean).length;
		const originalTitle = file.basename;
		const wizard = this.trackModal(
			new ProtectWizard(this.app, {
				interests: this.settings.interests,
				names: this.settings.coverNames,
				persona: this.settings.coverPersona,
				generator: this.generator,
				llmAvailable: this.modelFileStatus().exists,
				realWordCount,
				realText: content,
				onProtect: async ({ decoy, password }) => {
					if (!this.isLive()) return;
					const startEpoch = this.sessions.currentKillEpoch();
					const cmdId = this.sessions.beginCommand(file, "protect");
					if (cmdId === null) return;
					try {
						const { title: rawTitle, body: decoyBody } = splitTitleFromBody(decoy);
						const finalBody = decoyBody.length > 0 ? decoyBody : decoy;
						const staged = await readLinkedVaultImages(this.app, file.path, content);
						if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
						const { fileContent, payload } = await createFile(
							content,
							password,
							finalBody,
							undefined,
							staged.absorbed,
							originalTitle,
						);
						if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
						if (!payload || payload.v !== 1) {
							new Notice("Protection failed: encryption error. Your original note is unchanged.");
							return;
						}
						const view = this.app.workspace.getActiveViewOfType(MarkdownView);
						if (view && view.file === file && this.isLive()) {
							this.sessions.attachFromLoad(view, file, { decoyBody: finalBody, payload });
							view.setViewData(finalBody, true);
						}
						const restorePreProtectViewIfLive = (): void => {
							if (!this.isLive()) {
								return;
							}
							if (this.registry?.has(file.path)) {
								void this.registry.remove(file.path);
							}
							if (view && view.file === file) {
								const attached = this.sessions.get(view);
								if (attached) {
									this.sessions.discardAndDetach(attached);
								}
								view.setViewData(content, true);
							}
							this.sessions.clearFileAuthority(file);
						};
						let committedAcrossRetirement = false;
						let writeRes: { status: "committed" | "declined" };
						try {
							writeRes = await this.sessions.enqueueCoordinatedWrite(
								file,
								async () => {
									await this.app.vault.modify(file, fileContent);
								},
								{
									epoch: startEpoch,
									kind: "normal",
									commandId: cmdId,
									onCommitted: async () => {
										committedAcrossRetirement = true;
										this.sessions.publishCommandCommit(file, {
											kind: "protect",
											payload,
											decoyBody: finalBody,
										});
										await this.registry.add(file.path, {
											noteId: payload.note_id,
											addedAt: Date.now(),
											mode: "portable",
										});
									},
								},
							);
						} catch (error) {
							if (!committedAcrossRetirement) {
								restorePreProtectViewIfLive();
							}
							console.warn("Veneer: protectFile could not write the note", error);
							return;
						}
						if (!committedAcrossRetirement && writeRes.status !== "committed") {
							restorePreProtectViewIfLive();
							return;
						}
						if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) {
							return;
						}
						await deleteStagedVaultImages(this.app, staged.filesToDelete);
						if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) {
							return;
						}
						if (view && view.file === file) {
							this.sessions.attachFromLoad(view, file, { decoyBody: finalBody, payload });
							view.setViewData(finalBody, true);
						}
						await this.retitleToFile(file, rawTitle);
						if (this.isLive()) {
							new Notice("Protected. The note now reads as your cover.");
						}
					} finally {
						this.sessions.finishCommand(file, cmdId);
					}
				},
			}),
		);
		wizard.open();
	}

	/** Shows `notice` and returns true if `file` currently has an unlocked or locking session. */
	private abortIfLiveSession(file: TFile, notice: string): boolean {
		if (!this.sessions.hasLiveSession(file.path)) return false;
		if (this.isLive()) {
			new Notice(notice);
		}
		return true;
	}

	/** Generates and persists a fresh decoy cover for an already-protected note. */
	private async refreshDecoy(file: TFile): Promise<void> {
		if (!this.isLive()) return;
		const deletionEpoch = this.modelDeletionEpoch;
		if (this.modelDeletionInFlight) {
			new Notice("The model is being deleted. Try again after deletion finishes.");
			return;
		}
		if (!(await this.awaitPredecessor(file, true))) return;
		if (!this.isLive()) return;
		if (this.modelDeletionInFlight || this.modelDeletionEpoch !== deletionEpoch) {
			new Notice("The model is being deleted. Try again after deletion finishes.");
			return;
		}
		const startEpoch = this.sessions.currentKillEpoch();
		const capturedSnapshots: string[] = [];
		let latestRealText: string | null = null;
		const recordSnapshot = (text: string): void => {
			if (!text) return;
			latestRealText = text;
			if (!capturedSnapshots.includes(text)) {
				capturedSnapshots.push(text);
			}
		};
		try {
			for (const session of this.sessions.getAllByPath(file.path)) {
				if (
					session.state === "unlocked" &&
					session.view.file === file &&
					session.view.editor &&
					typeof session.view.editor.getValue === "function"
				) {
					const editorText = session.view.editor.getValue();
					if (
						typeof editorText === "string" &&
						editorText !== session.decoyBody &&
						parseFileContent(editorText) === null
					) {
						recordSnapshot(editorText);
					}
				}
				if (session.state === "unlocked" || session.lockingPromise !== null) {
					await this.sessions.lock(session, "refresh-decoy", recordSnapshot);
				}
			}
		} catch {
			capturedSnapshots.length = 0;
			latestRealText = null;
			return;
		}
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) {
			capturedSnapshots.length = 0;
			latestRealText = null;
			return;
		}
		const content = await this.app.vault.read(file);
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) {
			capturedSnapshots.length = 0;
			latestRealText = null;
			return;
		}
		const parsed = parseFileContent(content);
		if (!parsed) {
			capturedSnapshots.length = 0;
			latestRealText = null;
			new Notice("Not a protected note.");
			return;
		}
		if (this.modelDeletionInFlight || this.modelDeletionEpoch !== deletionEpoch) {
			capturedSnapshots.length = 0;
			latestRealText = null;
			new Notice("The model is being deleted. Try again after deletion finishes.");
			return;
		}
		let result: Awaited<ReturnType<DecoyGenerator["generate"]>>;
		try {
			const combinedRealText =
				capturedSnapshots.length === 0
					? null
					: capturedSnapshots.length === 1
						? capturedSnapshots[0]!
						: capturedSnapshots.join("\0");
			const latestSnapshot = latestRealText as string | null;
			const realWordCount =
				latestSnapshot !== null
					? latestSnapshot.trim().split(/\s+/).filter(Boolean).length
					: undefined;
			result = await this.generator.generate(
				"auto",
				this.settings.interests,
				combinedRealText,
				Date.now() % 100000,
				{
					persona: this.settings.coverPersona || undefined,
					names: this.settings.coverNames.length > 0 ? [...this.settings.coverNames] : undefined,
					now: new Date(),
					...(realWordCount !== undefined ? { realWordCount } : {}),
				},
			);
		} finally {
			latestRealText = null;
		}
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) {
			capturedSnapshots.length = 0;
			return;
		}
		if (this.modelDeletionInFlight || this.modelDeletionEpoch !== deletionEpoch) {
			capturedSnapshots.length = 0;
			new Notice("The model is being deleted. Try again after deletion finishes.");
			return;
		}
		try {
			for (const session of this.sessions.getAllByPath(file.path)) {
				if (session.state === "unlocked" || session.lockingPromise !== null) {
					await this.sessions.lock(session, "refresh-decoy", recordSnapshot);
				}
			}
		} catch {
			capturedSnapshots.length = 0;
			return;
		}
		if (
			capturedSnapshots.length > 0 &&
			!validateDecoy(result.text.trim(), capturedSnapshots.join("\0")).ok
		) {
			const seed = Date.now() % 100000;
			const template =
				DECOY_TEMPLATES[seed % DECOY_TEMPLATES.length] ?? DECOY_TEMPLATES[0]!;
			result = {
				text: weaveTemplate(template, {
					topics: [...this.settings.interests],
					names: [...this.settings.coverNames],
					now: new Date(),
					seed,
				}),
				source: "template",
				attempts: result.attempts,
			};
		}
		capturedSnapshots.length = 0;
		const { title: rawTitle, body: decoyBody } = splitTitleFromBody(result.text.trim());
		const finalBody = decoyBody.length > 0 ? decoyBody : result.text.trim();
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		if (this.abortIfLiveSession(file, "Note was unlocked during refresh. Mask it and try again.")) {
			return;
		}
		const cmdId = this.sessions.beginCommand(file, "refresh");
		if (cmdId === null) return;
		const releasePath = this.sessions.reservePath(file.path);
		const previousState = new Map<
			ViewSession,
			{ decoyBody: string; originalPayload: PayloadV1 }
		>();
		try {
			const latest = parseFileContent(await this.app.vault.read(file));
			if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
			if (this.modelDeletionInFlight || this.modelDeletionEpoch !== deletionEpoch) {
				new Notice("The model is being deleted. Try again after deletion finishes.");
				return;
			}
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
			const written = await this.sessions.runReservedWrite(
				startEpoch,
				() => this.app.vault.modify(file, serializeFile(finalBody, latest.payload)),
				{
					file,
					commandId: cmdId,
					canCommit: () =>
						!this.modelDeletionInFlight && this.modelDeletionEpoch === deletionEpoch,
					onCommitted: () => {
						this.sessions.publishCommandCommit(file, {
							kind: "refresh",
							payload: latest.payload,
							decoyBody: finalBody,
						});
					},
				},
			);
			if (!written) {
				for (const [session, prev] of previousState) {
					session.decoyBody = prev.decoyBody;
					session.originalPayload = prev.originalPayload;
				}
				return;
			}
			if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
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
			if (this.isLive()) {
				console.warn("Veneer: cover refresh could not write the note", error);
				new Notice("Could not refresh the cover. The previous cover is unchanged.");
			}
			return;
		} finally {
			releasePath();
			this.sessions.finishCommand(file, cmdId);
		}
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		await this.retitleToFile(file, rawTitle);
		if (this.isLive()) {
			new Notice(`Cover refreshed (${result.source}).`);
		}
	}

	/** Renames `file` to match `rawTitle` (sanitized), appending a numeric suffix on collision. */
	private async retitleToFile(file: TFile, rawTitle: string): Promise<void> {
		if (!this.isLive()) return;
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

	/** Prompts for a password via modal and unlocks the active markdown view's session. */
	private async unlockViaModal(): Promise<void> {
		if (!this.isLive()) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) return;
		const targetFile = view.file;
		if (!(await this.awaitPredecessor(targetFile, true))) return;
		if (!this.isLive() || view.file !== targetFile) return;
		let session = this.sessions.get(view);
		if (!session) {
			const parsed = parseFileContent(await this.app.vault.cachedRead(targetFile));
			if (!this.isLive() || view.file !== targetFile) return;
			if (!parsed) {
				new Notice("Not a protected note.");
				return;
			}
			session = this.sessions.attachFromLoad(view, targetFile, parsed);
			view.setViewData(parsed.decoyBody, true);
		}
		const modal = this.trackModal(new PasswordModal(this.app, "Unlock this note"));
		const password = await modal.ask();
		if (password === null || !this.isLive()) return;
		await this.sessions.unlock(session, password);
	}

	/** Prompts for current and new passwords via modal and rotates the note's KEK wrapper. */
	private async changePasswordViaModal(): Promise<void> {
		if (!this.isLive()) return;
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		if (!(await this.awaitPredecessor(file, true))) return;
		if (!this.isLive()) return;
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
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		const content = await this.app.vault.read(file);
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		const parsed = parseFileContent(content);
		if (!parsed) {
			new Notice("Not a protected note.");
			return;
		}
		const oldModal = this.trackModal(new PasswordModal(this.app, "Current password"));
		const oldPassword = await oldModal.ask();
		if (oldPassword === null || !this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		const newModal = this.trackModal(new PasswordModal(this.app, "New password (8+ characters)"));
		const newPassword = await newModal.ask();
		if (newPassword === null || !this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
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
			if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
			if (
				this.abortIfLiveSession(
					file,
					"Note was unlocked during password change. Mask it and try again.",
				)
			) {
				return;
			}
			const cmdId = this.sessions.beginCommand(file, "password");
			if (cmdId === null) return;
			const releasePath = this.sessions.reservePath(file.path);
			const previousPayloads = new Map<
				ViewSession,
				{ original: PayloadV1; pending: PayloadV1 | null }
			>();
			try {
				const latestParsed = parseFileContent(await this.app.vault.read(file));
				if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
				if (!latestParsed) {
					new Notice("Not a protected note.");
					return;
				}
				const rotated = await changePassword(latestParsed.payload, oldPassword, newPassword);
				if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
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
				const written = await this.sessions.runReservedWrite(
					startEpoch,
					() => this.app.vault.modify(file, serializeFile(latestParsed.decoyBody, rotated)),
					{
						file,
						commandId: cmdId,
						onCommitted: () => {
							this.sessions.publishCommandCommit(file, {
								kind: "password",
								payload: rotated,
								decoyBody: latestParsed.decoyBody,
							});
						},
					},
				);
				if (!written) {
					for (const [openSession, prev] of previousPayloads) {
						openSession.originalPayload = prev.original;
						openSession.pendingPayload = prev.pending;
					}
					return;
				}
				if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
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
				this.sessions.finishCommand(file, cmdId);
			}
			if (this.isLive()) {
				new Notice("Password changed.");
			}
		} catch {
			if (this.isLive()) {
				new Notice("Password change failed.");
			}
		}
	}

	/** Permanently decrypts a protected note, restores its embedded images, and detaches its sessions. */
	private async unprotectViaModal(): Promise<void> {
		if (!this.isLive()) return;
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		if (!(await this.awaitPredecessor(file, true))) return;
		if (!this.isLive()) return;
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
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		const content = await this.app.vault.read(file);
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		const parsed = parseFileContent(content);
		if (!parsed) {
			new Notice("Not a protected note.");
			return;
		}
		const modal = this.trackModal(new PasswordModal(this.app, "Unprotect permanently"));
		const password = await modal.ask();
		if (password === null || !this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		try {
			for (const activeSession of this.sessions.getAllByPath(file.path)) {
				if (activeSession.state === "unlocked" || activeSession.lockingPromise !== null) {
					await this.sessions.lock(activeSession, "unprotect");
				}
			}
			if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
			if (this.abortIfLiveSession(file, "Note was unlocked during unprotect. Mask it and try again.")) {
				return;
			}
			const cmdId = this.sessions.beginCommand(file, "unprotect");
			if (cmdId === null) return;
			const openSessions = this.sessions.getAllByPath(file.path);
			const releasePath = this.sessions.reservePath(file.path);
			let realTitle: string | null = null;
			let committedAcrossRetirement = false;
			try {
				const latestParsed = parseFileContent(await this.app.vault.read(file));
				if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
				if (!latestParsed) {
					new Notice("Not a protected note.");
					return;
				}
				const unlocked = await unlockPayload(latestParsed.payload, password);
				const releaseCommandDek = this.sessions.registerOwnedDek(unlocked.dek);
				let realText = "";
				try {
					realText = unlocked.realText;
					realTitle = unlocked.realTitle;
				} finally {
					releaseCommandDek();
				}
				if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
				await restoreVaultImages(this.app, file.parent?.path ?? "", unlocked.images);
				if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
				const plaintextWithNewline = `${realText}\n`;
				try {
					const written = await this.sessions.runReservedWrite(
						startEpoch,
						() => this.app.vault.modify(file, plaintextWithNewline),
						{
							file,
							commandId: cmdId,
							onCommitted: async () => {
								committedAcrossRetirement = true;
								this.sessions.publishCommandCommit(file, {
									kind: "unprotect",
									plaintextContent: plaintextWithNewline,
								});
								const hydrateMatchingViews = (): void => {
									const rawSet = this.sessions.getCapturedNativeSetViewData();
									if (!rawSet) return;
									const matchingViews = new Set<MarkdownView>();
									for (const s of openSessions) {
										if (s.view.file === file) matchingViews.add(s.view);
									}
									try {
										this.app.workspace.iterateAllLeaves((leaf) => {
											if (
												leaf.view instanceof MarkdownView &&
												leaf.view.file === file
											) {
												matchingViews.add(leaf.view);
											}
										});
									} catch {}
									const coordinator = this.getCoordinator();
									for (const v of matchingViews) {
										try {
											const currentText =
												v.editor && typeof v.editor.getValue === "function"
													? v.editor.getValue()
													: ((v as unknown as { data?: string }).data ?? "");
											const backingText =
												(v as unknown as { data?: string }).data ?? "";
											if (
												coordinator.isViewUnprotectReconciled(
													this.app,
													file,
													v,
												) &&
												parseFileContent(currentText) === null &&
												parseFileContent(backingText) === null
											) {
												continue;
											}
											if (rawSet.length >= 3) {
												(
													rawSet as (
														view: MarkdownView,
														data: string,
														clear: boolean,
													) => void
												)(v, plaintextWithNewline, true);
											} else {
												(
													rawSet as (
														this: MarkdownView,
														data: string,
														clear: boolean,
													) => void
												).call(v, plaintextWithNewline, true);
											}
											(v as unknown as { data: string }).data =
												plaintextWithNewline;
											coordinator.markViewUnprotectReconciled(
												this.app,
												file,
												v,
											);
										} catch {}
									}
								};
								if (!this.isLive()) {
									hydrateMatchingViews();
								}
								const wasLiveBeforeRegistryRemove = this.isLive();
								await this.registry.remove(file.path);
								if (wasLiveBeforeRegistryRemove && !this.isLive()) {
									hydrateMatchingViews();
								}
							},
						},
					);
					if (!written && !committedAcrossRetirement) return;
				} catch (error) {
					if (this.isLive()) {
						console.warn("Veneer: unprotect could not write the note", error);
						new Notice("Could not write the unprotected note. The note is still masked.");
					}
					return;
				}
				if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) {
					return;
				}
				const targetSessions = new Set<ViewSession>([
					...openSessions,
					...this.sessions.getAllByPath(file.path),
				]);
				for (const session of targetSessions) {
					const detached = this.sessions.discardAndDetach(session);
					if (detached === true && session.view.file === file) {
						session.view.setViewData(realText, true);
						this.getCoordinator().markViewUnprotectReconciled(
							this.app,
							file,
							session.view,
						);
					}
				}
				this.sessions.clearFileAuthority(file);
			} finally {
				releasePath();
				this.sessions.finishCommand(file, cmdId);
			}
			if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) {
				return;
			}
			if (realTitle && realTitle.trim().length > 0) {
				await this.retitleToFile(file, realTitle);
			}
			if (this.isLive()) {
				new Notice("Note is now a normal note.");
			}
		} catch {
			return;
		}
	}

	/** Derives and persists a new salted hash record for the destruction PIN. */
	async setDuressPin(pin: string): Promise<void> {
		const record = await newPinRecord(pin);
		if (!this.isLive()) return;
		this.settings.duressPinSalt = record.salt;
		this.settings.duressPinHash = record.hash;
		await this.saveSettings();
	}

	/** Clears any configured destruction PIN salt and hash from plugin settings. */
	async clearDuressPin(): Promise<void> {
		this.settings.duressPinSalt = null;
		this.settings.duressPinHash = null;
		await this.saveSettings();
	}

	/** Constructs a `DecoyGenerator` wired to the active local LLM runtime and fallback templates. */
	private buildGenerator(initialUnloadBarrier?: Promise<void>): DecoyGenerator {
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
			...(initialUnloadBarrier ? { initialUnloadBarrier } : {}),
		});
	}

	/** Resolves the vault-relative and absolute filesystem paths for this plugin's directory. */
	pluginDirPaths(): { abs: string; rel: string } {
		const configDir = this.app?.vault?.configDir || ".obsidian";
		const pluginId = this.manifest?.id || "veneer";
		const rel = normalizePath(this.manifest?.dir || `${configDir}/plugins/${pluginId}`);
		const adapter = this.app?.vault?.adapter;
		const root =
			adapter instanceof FileSystemAdapter
				? adapter.getBasePath()
				: ((adapter as unknown as { getBasePath?: () => string })?.getBasePath?.() ?? "");
		const abs = root ? path.join(root, ...rel.split("/")) : path.join(...rel.split("/"));
		return { abs, rel };
	}

	/** Selects and constructs the preferred local LLM runtime (`NativeRuntime` or `WllamaRuntime`). */
	private buildRuntime(): LlmRuntime {
		const model = activeModel(this.settings);
		const base = this.pluginDirPaths().abs;
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

	/** Checks on-disk existence, byte size, and partial download progress for the active model file. */
	modelFileStatus(): {
		exists: boolean;
		sizeBytes: number;
		fileName: string;
		partial: { downloaded: number; total: number | null } | null;
	} {
		const model = activeModel(this.settings);
		const abs = path.join(this.pluginDirPaths().abs, "models", model.file);
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

	/** Lists all non-empty `.gguf` model files currently present in the plugin models directory. */
	downloadedModels(): { fileName: string; sizeBytes: number; modelId: ModelId | "custom" }[] {
		const dir = path.join(this.pluginDirPaths().abs, "models");
		const results: { fileName: string; sizeBytes: number; modelId: ModelId | "custom" }[] = [];
		try {
			const files = fs.readdirSync(dir);
			for (const file of files) {
				if (!file.endsWith(".gguf")) continue;
				const stat = fs.statSync(path.join(dir, file));
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

	/**
	 * Unloads any active LLM runtime so file handles are released on Windows, deletes the
	 * specified (or active) `.gguf` model file and partial artifacts, updates settings, and
	 * rebuilds the generator without warming it up.
	 */
	async deleteModelFile(targetFileName?: string): Promise<boolean> {
		const activeFile = activeModel(this.settings).file;
		const fileName = targetFileName ?? activeFile;
		const wasActiveModel = fileName === activeFile;
		const abs = path.join(this.pluginDirPaths().abs, "models", fileName);
		if (wasActiveModel && this.modelDeletionInFlight) {
			return false;
		}
		if (wasActiveModel) {
			this.modelDeletionInFlight = true;
			this.modelDeletionEpoch += 1;
		}
		try {
			if (wasActiveModel) {
				try {
					await this.generator?.unload();
				} catch (error) {
					console.warn("Veneer: generator unload before model delete failed", error);
					return false;
				}
			}
			let deleted = false;
			try {
				if (fs.existsSync(abs)) {
					fs.unlinkSync(abs);
				}
				clearPartial(abs);
				deleted = !fs.existsSync(abs);
			} catch (error) {
				console.warn("Veneer: model delete skipped", error);
				deleted = false;
			}
			const prevModelId = this.settings.modelId;
			const prevCustomFile = this.settings.customModel?.file ?? null;
			const prevDownloaded = this.settings.modelDownloaded;
			const disk = this.modelFileStatus();
			if (disk.exists) {
				this.settings.modelDownloaded = true;
			} else {
				const remaining = this.downloadedModels();
				const next = remaining[0];
				if (next) {
					if (next.modelId === "custom") {
						this.settings.modelId = "custom";
						this.settings.customModel = {
							file: next.fileName,
							url: null,
							sizeBytes: next.sizeBytes,
							label: next.fileName,
						};
					} else {
						this.settings.modelId = next.modelId;
						this.settings.customModel = null;
					}
					this.settings.modelDownloaded = true;
					this.settings.modelVerified = false;
				} else {
					this.settings.modelDownloaded = false;
					this.settings.modelVerified = false;
				}
			}
			await this.saveSettings();
			const selectionOrAvailabilityChanged =
				this.settings.modelId !== prevModelId ||
				(this.settings.customModel?.file ?? null) !== prevCustomFile ||
				this.settings.modelDownloaded !== prevDownloaded;
			if (wasActiveModel || selectionOrAvailabilityChanged) {
				await this.rebuildGenerator();
			}
			return deleted;
		} finally {
			if (wasActiveModel) {
				this.modelDeletionInFlight = false;
			}
		}
	}

	/** Ensures the plugin models directory exists and returns its absolute and vault-relative paths. */
	async modelsDir(): Promise<{ abs: string; rel: string }> {
		const pluginDir = this.pluginDirPaths();
		const rel = normalizePath(`${pluginDir.rel}/models`);
		await this.app.vault.adapter.mkdir(rel);
		return { abs: path.join(pluginDir.abs, "models"), rel };
	}

	/** Removes a model file at the given vault-relative path via the vault adapter. */
	async removeModelFile(rel: string): Promise<void> {
		await this.app.vault.adapter.remove(rel);
	}

	/** Retires and unloads the current decoy generator and synchronously publishes a replacement gated on the unload barrier. */
	rebuildGenerator(): Promise<void> {
		if (!this.isLive()) return Promise.resolve();
		const prevGenerator = this.generator;
		if (!prevGenerator) {
			this.generator = this.buildGenerator();
			return Promise.resolve();
		}
		const unloadTask = Promise.resolve(prevGenerator.unload(true)).catch((error) => {
			console.warn("Veneer: generator unload failed", error);
		});
		this.generator = this.buildGenerator(unloadTask);
		return unloadTask;
	}

	/** Copies a local `.gguf` file into the models directory, computes its SHA-256 digest, and activates it. */
	async importLocalModelFlow(
		sourcePath: string,
	): Promise<{ ok: boolean; sha256: string | null; error: string | null }> {
		try {
			if (!sourcePath.toLowerCase().endsWith(".gguf")) {
				return { ok: false, sha256: null, error: "Pick a .gguf model file." };
			}
			const dir = await this.modelsDir();
			const fileName = sourcePath.split(/[\\/]/).pop() ?? "custom-model.gguf";
			const dest = path.join(dir.abs, fileName);
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

	/** Generates a short sample decoy cover using the active generator to verify model readiness. */
	async testModelFlow(): Promise<string> {
		if (this.modelDeletionInFlight) {
			return "The model is being deleted. Try again after deletion finishes.";
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
		return `[${result.source}] ${result.text.trim().slice(0, 400)}`;
	}

	/** Loads persisted plugin settings while stripping the registry `entries` map. */
	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as
			| (Partial<VeneerSettings> & { entries?: unknown; legacyDeocyMigrated?: unknown })
			| null;
		if (raw?.legacyDeocyMigrated === true) {
			this.legacyDeocyMigrated = true;
		}
		const { entries: _entries, legacyDeocyMigrated: _migrated, ...rest } = raw ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...rest };
	}

	/** Persists plugin settings together with the current protected note registry entries. */
	async saveSettings(): Promise<void> {
		await this.saveData({
			...this.settings,
			entries: this.registry ? this.registry.entriesRecord() : {},
			...(this.legacyDeocyMigrated ? { legacyDeocyMigrated: true } : {}),
		});
	}
}
