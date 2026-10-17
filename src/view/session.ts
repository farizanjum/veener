import type { App, MarkdownView, TFile } from "obsidian";
import {
	encryptImageMap,
	reencryptRealText,
	serializeFile,
	unlockPayload,
	type ParsedFile,
	type PayloadV1,
} from "../crypto/payload";
import {
	deleteStagedVaultImages,
	readLinkedVaultImages,
	type StagedVaultImages,
} from "../crypto/images";
import { BackoffTracker } from "../lock/backoff";
import { CaptureBuffer } from "../capture/buffer";

/**
 * Per-view session state machine (§5). A view is either locked (editor shows
 * decoy, payload held in memory) or unlocked (editor shows real text, DEK held
 * in memory, ciphertext pre-computed on a debounce so saves stay synchronous).
 */

export type UnlockOutcome = "ok" | "wrong" | "backoff" | "blocked";

export interface ViewSession {
	readonly view: MarkdownView;
	readonly file: TFile;
	state: "locked" | "unlocked";
	decoyBody: string;
	originalPayload: PayloadV1;
	pendingPayload: PayloadV1 | null;
	dek: Uint8Array<ArrayBuffer> | null;
	realTitle: string | null;
	readonly imageUrls: Map<string, string>;
	readonly backoff: BackoffTracker;
	readonly capture: CaptureBuffer;
	reencryptTimer: ReturnType<typeof setTimeout> | null;
	reencryptSeq: number;
	reencryptPromise: Promise<void> | null;
	lockingPromise: Promise<void> | null;
}

export interface SessionHooks {
	onUnlocked(session: ViewSession): void;
	onLocked(session: ViewSession): void;
	onUnlockBlocked(reason: string): void;
}

export const REENCRYPT_DEBOUNCE_MS = 600;

export class SessionManager {
	private readonly byView = new WeakMap<MarkdownView, ViewSession>();
	private readonly byPath = new Map<string, ViewSession>();

	constructor(
		private readonly app: App,
		private readonly hooks: SessionHooks,
		private readonly triggerPrefix: () => string,
		private readonly unlockBlockReason: () => string | null,
	) {}

	get(view: MarkdownView): ViewSession | null {
		return this.byView.get(view) ?? null;
	}

	getByPath(path: string): ViewSession | null {
		return this.byPath.get(path) ?? null;
	}

	all(): ViewSession[] {
		return [...this.byPath.values()];
	}

	attachFromLoad(view: MarkdownView, file: TFile, parsed: ParsedFile): ViewSession {
		const existing = this.byView.get(view);
		if (existing) {
			if (existing.file === file) {
				const isOwnPayload =
					parsed.payload.cipher.nonce === existing.originalPayload.cipher.nonce ||
					parsed.payload.cipher.nonce === existing.pendingPayload?.cipher.nonce;
				existing.decoyBody = parsed.decoyBody;
				existing.originalPayload = parsed.payload;
				if (existing.state === "unlocked" && !isOwnPayload) {
					this.resetUnlockedToLocked(existing);
				}
				return existing;
			}
			if (existing.state === "unlocked") {
				this.resetUnlockedToLocked(existing);
			}
			if (this.byPath.get(existing.file.path) === existing) {
				this.byPath.delete(existing.file.path);
			}
			this.byView.delete(view);
		}
		const session: ViewSession = {
			view,
			file,
			state: "locked",
			decoyBody: parsed.decoyBody,
			originalPayload: parsed.payload,
			pendingPayload: null,
			dek: null,
			realTitle: null,
			imageUrls: new Map<string, string>(),
			backoff: new BackoffTracker(),
			capture: new CaptureBuffer(this.triggerPrefix()),
			reencryptTimer: null,
			reencryptSeq: 0,
			reencryptPromise: null,
			lockingPromise: null,
		};
		this.byView.set(view, session);
		this.byPath.set(file.path, session);
		return session;
	}

	/**
	 * Synchronously transitions an unlocked session to locked in memory without writing to disk.
	 */
	private resetUnlockedToLocked(session: ViewSession): void {
		session.reencryptSeq += 1;
		session.dek?.fill(0);
		session.dek = null;
		this.revokeImageUrls(session);
		session.state = "locked";
		session.pendingPayload = null;
		session.realTitle = null;
		session.capture.cancel();
		if (session.reencryptTimer !== null) {
			clearTimeout(session.reencryptTimer);
			session.reencryptTimer = null;
		}
		this.applyDisplayedTitle(session, session.file.basename);
		this.hooks.onLocked(session);
	}

	renamePath(oldPath: string, newPath: string): void {
		const session = this.byPath.get(oldPath);
		if (!session) return;
		this.byPath.delete(oldPath);
		this.byPath.set(newPath, session);
	}

	pruneDetached(activeViews: Set<MarkdownView>): void {
		for (const session of this.all()) {
			if (!activeViews.has(session.view)) this.detach(session.view);
		}
	}

	detach(view: MarkdownView): void {
		const session = this.byView.get(view);
		if (!session) return;
		void this.lock(session, "detach");
		this.byView.delete(view);
		if (this.byPath.get(session.file.path) === session) {
			this.byPath.delete(session.file.path);
		}
	}

	private populateImageUrls(
		session: ViewSession,
		images: Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }>,
	): void {
		if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
		for (const [name, img] of Object.entries(images)) {
			const blob = new Blob([img.data], { type: img.mime });
			const url = URL.createObjectURL(blob);
			session.imageUrls.set(name, url);
			const basename = name.split("/").pop() ?? name;
			session.imageUrls.set(basename, url);
		}
	}

	private revokeImageUrls(session: ViewSession): void {
		if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
			const uniqueUrls = new Set(session.imageUrls.values());
			for (const url of uniqueUrls) {
				URL.revokeObjectURL(url);
			}
		}
		session.imageUrls.clear();
	}

	private applyDisplayedTitle(session: ViewSession, titleText: string): void {
		const container = (session.view as unknown as { containerEl?: HTMLElement }).containerEl;
		if (container) {
			const inlineEl = container.querySelector(".inline-title");
			if (inlineEl) inlineEl.textContent = titleText;
			const headerEl = container.querySelector(".view-header-title");
			if (headerEl) headerEl.textContent = titleText;
		}
		const leaf = (session.view as unknown as { leaf?: { tabHeaderInnerTitleEl?: HTMLElement } }).leaf;
		if (leaf?.tabHeaderInnerTitleEl) {
			leaf.tabHeaderInnerTitleEl.textContent = titleText;
		}
	}

	private readEditedInlineTitle(session: ViewSession): string | null {
		const container = (session.view as unknown as { containerEl?: HTMLElement }).containerEl;
		const inlineEl = container?.querySelector(".inline-title");
		return inlineEl?.textContent?.trim() || session.realTitle;
	}

	/**
	 * Reads and encrypts any newly linked vault images without deleting source files yet.
	 */
	private async stageEditorImages(
		session: ViewSession,
		text: string,
	): Promise<{
		staged: StagedVaultImages;
		mergedImages: PayloadV1["images"];
	} | null> {
		if (session.state !== "unlocked" || !session.dek) return null;
		if (!text.includes("!")) {
			return {
				staged: { absorbed: {}, filesToDelete: [] },
				mergedImages: session.originalPayload.images,
			};
		}
		const staged = await readLinkedVaultImages(this.app, session.file.path, text);
		if (session.state !== "unlocked" || !session.dek) return null;
		if (Object.keys(staged.absorbed).length === 0) {
			return {
				staged,
				mergedImages: session.originalPayload.images,
			};
		}
		const encryptedNew = await encryptImageMap(
			session.dek,
			session.originalPayload.note_id,
			staged.absorbed,
		);
		if (session.state !== "unlocked" || !session.dek) return null;
		return {
			staged,
			mergedImages: {
				...(session.originalPayload.images ?? {}),
				...encryptedNew,
			},
		};
	}

	/**
	 * Deletes staged source image files and refreshes in-memory blob: URLs after disk save.
	 */
	private async finalizeStagedImages(
		session: ViewSession,
		staged: StagedVaultImages,
	): Promise<void> {
		if (Object.keys(staged.absorbed).length === 0) return;
		await deleteStagedVaultImages(this.app, staged.filesToDelete);
		if (session.state === "unlocked") {
			this.populateImageUrls(session, staged.absorbed);
			const cm = (
				session.view.editor as unknown as {
					cm?: { dispatch: (tr: Record<string, never>) => void };
				}
			).cm;
			cm?.dispatch({});
		}
	}

	/**
	 * Persists `payload` through the view's own `save()` path when available so Obsidian
	 * treats the write as an internal view save rather than an external file reload.
	 */
	private async persistSessionPayload(session: ViewSession, payload: PayloadV1): Promise<void> {
		const serialized = serializeFile(session.decoyBody, payload);
		(session.view as unknown as { data?: string }).data = serialized;
		const viewWithSave = session.view as unknown as { save?: () => Promise<void> };
		if (typeof viewWithSave.save === "function") {
			await viewWithSave.save();
			return;
		}
		await this.app.vault.modify(session.file, serialized);
	}

	/**
	 * Waits for all in-flight re-encryption and lock tasks across sessions to settle.
	 */
	async waitForIdle(): Promise<void> {
		for (const session of this.all()) {
			if (session.reencryptPromise) {
				await session.reencryptPromise;
			}
			if (session.lockingPromise) {
				await session.lockingPromise;
			}
		}
	}

	async absorbNewEditorImages(session: ViewSession): Promise<void> {
		if (session.state !== "unlocked" || !session.dek) return;
		const text = session.view.editor.getValue();
		const result = await this.stageEditorImages(session, text);
		if (!result || Object.keys(result.staged.absorbed).length === 0) return;
		const nextPayload = await reencryptRealText(
			session.originalPayload,
			session.dek,
			text,
			result.mergedImages,
			this.readEditedInlineTitle(session),
		);
		if (session.state !== "unlocked" || !session.dek) return;
		const prevPending = session.pendingPayload;
		session.pendingPayload = nextPayload;
		try {
			await this.persistSessionPayload(session, nextPayload);
		} catch (saveError) {
			session.pendingPayload = prevPending;
			throw saveError;
		}
		session.originalPayload = nextPayload;
		await this.finalizeStagedImages(session, result.staged);
	}

	async unlock(session: ViewSession, password: string): Promise<UnlockOutcome> {
		if (session.state === "unlocked") return "ok";
		const blockReason = this.unlockBlockReason();
		if (blockReason !== null) {
			this.hooks.onUnlockBlocked(blockReason);
			return "blocked";
		}
		const now = Date.now();
		if (!session.backoff.canAttempt(now)) return "backoff";
		try {
			const { realText, dek, images, realTitle } = await unlockPayload(session.originalPayload, password);
			session.backoff.recordSuccess();
			session.dek = dek;
			session.state = "unlocked";
			session.realTitle = realTitle ?? session.file.basename;
			session.pendingPayload = session.originalPayload;
			this.revokeImageUrls(session);
			this.populateImageUrls(session, images);
			session.view.setViewData(realText, true);
			this.applyDisplayedTitle(session, session.realTitle);
			queueMicrotask(() => {
				if (session.state === "unlocked") {
					this.applyDisplayedTitle(session, session.realTitle ?? session.file.basename);
				}
			});
			this.hooks.onUnlocked(session);
			return "ok";
		} catch {
			session.backoff.recordFailure(now);
			return "wrong";
		}
	}

	async lock(session: ViewSession, reason: string): Promise<void> {
		if (session.lockingPromise) return session.lockingPromise;
		if (session.state !== "unlocked") return;
		const runLock = (async () => {
			console.debug(`Veneer: masking note (${reason})`);
			session.reencryptSeq += 1;
			if (session.reencryptTimer !== null) {
				clearTimeout(session.reencryptTimer);
				session.reencryptTimer = null;
			}
			if (session.reencryptPromise !== null) {
				await session.reencryptPromise;
			}
			if (session.state !== "unlocked") return;
			const sameFile = session.view.file === session.file;
			try {
				if (session.dek && sameFile) {
					const current = session.view.editor.getValue();
					const currentTitle = this.readEditedInlineTitle(session);
					const imageStage = await this.stageEditorImages(session, current);
					const mergedImages = imageStage?.mergedImages ?? session.originalPayload.images;
					session.realTitle = currentTitle;
					session.pendingPayload = await reencryptRealText(
						session.originalPayload,
						session.dek,
						current,
						mergedImages,
						session.realTitle,
					);
					const serialized = serializeFile(session.decoyBody, session.pendingPayload);
					(session.view as unknown as { data?: string }).data = serialized;
					await this.app.vault.modify(session.file, serialized);
					session.originalPayload = session.pendingPayload;
					if (imageStage && imageStage.staged.filesToDelete.length > 0) {
						await deleteStagedVaultImages(this.app, imageStage.staged.filesToDelete);
					}
				}
			} finally {
				session.dek?.fill(0);
				session.dek = null;
				this.revokeImageUrls(session);
				session.state = "locked";
				session.pendingPayload = null;
				session.capture.cancel();
				if (session.reencryptTimer !== null) {
					clearTimeout(session.reencryptTimer);
					session.reencryptTimer = null;
				}
				if (sameFile) {
					session.view.setViewData(session.decoyBody, true);
					this.applyDisplayedTitle(session, session.file.basename);
				}
				session.realTitle = null;
				this.hooks.onLocked(session);
			}
		})().finally(() => {
			if (session.lockingPromise === runLock) {
				session.lockingPromise = null;
			}
		});
		session.lockingPromise = runLock;
		return runLock;
	}

	async lockAll(reason: string): Promise<void> {
		for (const session of this.all()) {
			await this.lock(session, reason);
		}
	}

	/**
	 * Immediate mask with NO re-encryption: used by the duress shred (§11.2).
	 * Drops keys and swaps to decoy; the shred deletes the payload from disk.
	 */
	hardKillAll(): void {
		for (const session of this.all()) {
			session.reencryptSeq += 1;
			session.dek?.fill(0);
			session.dek = null;
			this.revokeImageUrls(session);
			session.state = "locked";
			session.pendingPayload = null;
			session.capture.cancel();
			if (session.reencryptTimer !== null) {
				clearTimeout(session.reencryptTimer);
				session.reencryptTimer = null;
			}
			session.view.setViewData(session.decoyBody, true);
			this.applyDisplayedTitle(session, session.file.basename);
			session.realTitle = null;
			this.hooks.onLocked(session);
		}
	}

	/** Debounced ciphertext refresh so the synchronous save path never sees plaintext. */
	scheduleReencrypt(session: ViewSession): void {
		if (session.state !== "unlocked" || !session.dek) return;
		const seq = ++session.reencryptSeq;
		if (session.reencryptTimer !== null) clearTimeout(session.reencryptTimer);
		session.reencryptTimer = setTimeout(() => {
			session.reencryptTimer = null;
			const prev = session.reencryptPromise ?? Promise.resolve();
			const next = prev
				.catch(() => undefined)
				.then(async () => {
					if (session.state !== "unlocked" || !session.dek || session.reencryptSeq !== seq) {
						return;
					}
					try {
						const snapshotText = session.view.editor.getValue();
						const snapshotTitle = this.readEditedInlineTitle(session);
						const imageStage = await this.stageEditorImages(session, snapshotText);
						if (
							!imageStage ||
							session.state !== "unlocked" ||
							!session.dek ||
							session.reencryptSeq !== seq
						) {
							return;
						}
						const nextPayload = await reencryptRealText(
							session.originalPayload,
							session.dek,
							snapshotText,
							imageStage.mergedImages,
							snapshotTitle,
						);
						if (
							session.state !== "unlocked" ||
							!session.dek ||
							session.reencryptSeq !== seq ||
							session.view.file !== session.file
						) {
							return;
						}
						const prevPending = session.pendingPayload;
						const prevTitle = session.realTitle;
						session.realTitle = snapshotTitle;
						session.pendingPayload = nextPayload;
						try {
							await this.persistSessionPayload(session, nextPayload);
						} catch (saveError) {
							session.pendingPayload = prevPending;
							session.realTitle = prevTitle;
							throw saveError;
						}
						session.originalPayload = nextPayload;
						await this.finalizeStagedImages(session, imageStage.staged);
						if (session.state === "unlocked" && session.reencryptSeq === seq) {
							(session.view as unknown as { requestSave?: () => void }).requestSave?.();
						}
					} catch (error) {
						console.warn("Veneer: re-encryption skipped, keeping last good ciphertext", error);
					}
				})
				.finally(() => {
					if (session.reencryptPromise === next) {
						session.reencryptPromise = null;
					}
				});
			session.reencryptPromise = next;
		}, REENCRYPT_DEBOUNCE_MS);
	}
}
