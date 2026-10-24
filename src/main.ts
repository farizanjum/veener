import { addIcon, MarkdownView, Notice, Plugin, TFile } from "obsidian";
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

interface ClosableModal {
	cancelAndClose?: () => void;
	close?: () => void;
	onClose?: () => void;
}

export default class VeneerPlugin extends Plugin {
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
	private activeModals?: Set<ClosableModal>;

	/** Returns the shared `ViewLifecycleCoordinator` from the active session manager or global singleton. */
	private getCoordinator(): ViewLifecycleCoordinator {
		return this.sessions ? this.sessions.getCoordinator() : getSharedLifecycleCoordinator();
	}

	/** Returns true while this plugin instance is active and has not entered teardown or session disposal. */
	private isLive(): boolean {
		if (this.isShuttingDown || this.teardownDone) return false;
		if (this.sessions && this.sessions.isDisposed()) return false;
		return true;
	}

	/** Tracks an open modal so it can be synchronously cancelled and closed during plugin teardown. */
	private trackModal<T extends ClosableModal>(modal: T): T {
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
		this.generator = this.buildGenerator();
		this.generator.warmup();
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
			const unloadRes = this.generator?.unload();
			if (unloadRes) {
				void Promise.resolve(unloadRes).catch((error) => {
					console.warn("Veneer: generator unload failed", error);
				});
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
			.map(({ path, entry }) => ({ path, mode: entry.mode }));
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

		const destruction = coordinator.beginDestruction(this.app, coordinatorTargets);

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
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "X" }],
			callback: () => {
				if (!this.isLive()) return;
				this.lockEngine.panic();
			},
		});
		this.addCommand({
			id: "protect-note",
			name: "Protect this note",
			callback: () => {
				if (!this.isLive()) return;
				const file = this.app.workspace.getActiveFile();
				if (file) void this.protectFile(file);
			},
		});
		this.addCommand({
			id: "refresh-decoy",
			name: "Refresh decoy cover of this note",
			callback: () => {
				if (!this.isLive()) return;
				const file = this.app.workspace.getActiveFile();
				if (file) void this.refreshDecoy(file);
			},
		});
		this.addCommand({
			id: "unlock-note",
			name: "Unlock this note",
			callback: () => {
				if (!this.isLive()) return;
				void this.unlockViaModal();
			},
		});
		this.addCommand({
			id: "unprotect-note",
			name: "Unprotect this note (decrypt permanently)",
			callback: () => {
				if (!this.isLive()) return;
				void this.unprotectViaModal();
			},
		});
		this.addCommand({
			id: "change-password",
			name: "Change password of this note",
			callback: () => {
				if (!this.isLive()) return;
				void this.changePasswordViaModal();
			},
		});
		this.addCommand({
			id: "mask-note",
			name: "Mask this note (return to cover)",
			callback: () => {
				if (!this.isLive()) return;
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
		if (!(await this.awaitPredecessor(file, true))) return;
		if (!this.isLive()) return;
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
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
		const content = await this.app.vault.read(file);
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
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
		if (!this.isLive() || this.sessions.currentKillEpoch() !== startEpoch) return;
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

	/** Selects and constructs the preferred local LLM runtime (`NativeRuntime` or `WllamaRuntime`). */
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

	/** Checks on-disk existence, byte size, and partial download progress for the active model file. */
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

	/** Lists all non-empty `.gguf` model files currently present in the plugin models directory. */
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

	/** Deletes the active model file and any partial download artifacts, then rebuilds the generator. */
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

	/** Ensures the plugin models directory exists and returns its absolute and vault-relative paths. */
	async modelsDir(): Promise<{ abs: string; rel: string }> {
		const rel = `${this.app.vault.configDir}/plugins/deocy/models`;
		await this.app.vault.adapter.mkdir(rel);
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		return { abs: `${adapter.getBasePath?.() ?? ""}/${rel}`, rel };
	}

	/** Removes a model file at the given vault-relative path via the vault adapter. */
	async removeModelFile(rel: string): Promise<void> {
		await this.app.vault.adapter.remove(rel);
	}

	/** Unloads the current decoy generator and constructs a warmed-up replacement when the plugin is live. */
	rebuildGenerator(): void {
		if (!this.isLive()) return;
		void this.generator?.unload()?.catch((error) => {
			console.warn("Veneer: generator unload failed", error);
		});
		this.generator = this.buildGenerator();
		this.generator.warmup();
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

	/** Generates a short sample decoy cover using the active generator to verify model readiness. */
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

	/** Loads persisted plugin settings while stripping the registry `entries` map. */
	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as (Partial<VeneerSettings> & { entries?: unknown }) | null;
		const { entries: _entries, ...rest } = raw ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...rest };
	}

	/** Persists plugin settings together with the current protected note registry entries. */
	async saveSettings(): Promise<void> {
		await this.saveData({
			...this.settings,
			entries: this.registry ? this.registry.entriesRecord() : {},
		});
	}
}
