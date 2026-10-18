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
	type StagedFile,
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
	/**
	 * Tail of the per-session disk-write queue. Serializes `MarkdownView.save`
	 * and `lock`'s `vault.modify` so an in-flight save cannot land after
	 * `lock()` and overwrite newer ciphertext.
	 */
	writePromise: Promise<void> | null;
	/** Source files staged for a payload, released once that payload is persisted. */
	stagedFilesByPayload: WeakMap<PayloadV1, StagedFile[]>;
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
				existing.decoyBody = parsed.decoyBody;
				existing.originalPayload = parsed.payload;
				if (existing.state === "unlocked") {
					void this.lock(existing, "reload").catch((error) =>
						console.warn("Veneer: reload lock failed", error),
					);
				}
				return existing;
			}
			if (existing.state === "unlocked") {
				existing.reencryptSeq += 1;
				existing.dek?.fill(0);
				existing.dek = null;
				this.revokeImageUrls(existing);
				existing.state = "locked";
				existing.pendingPayload = null;
				existing.realTitle = null;
				existing.capture.cancel();
				if (existing.reencryptTimer !== null) {
					clearTimeout(existing.reencryptTimer);
					existing.reencryptTimer = null;
				}
				this.hooks.onLocked(existing);
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
			writePromise: null,
			stagedFilesByPayload: new WeakMap(),
		};
		this.byView.set(view, session);
		this.byPath.set(file.path, session);
		return session;
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
		void this.lock(session, "detach").catch((error) =>
			console.warn("Veneer: detach lock failed", error),
		);
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
		// One vault image can appear under several keys (link path and basename) that
		// share a single `data` reference; a per-entry URL would revoke a URL still
		// referenced by a sibling key.
		const next = new Map(session.imageUrls);
		const urlByData = new Map<Uint8Array<ArrayBuffer>, string>();
		for (const [name, img] of Object.entries(images)) {
			let url = urlByData.get(img.data);
			if (!url) {
				const blob = new Blob([img.data], { type: img.mime });
				url = URL.createObjectURL(blob);
				urlByData.set(img.data, url);
			}
			next.set(name, url);
			const basename = name.split("/").pop() ?? name;
			if (!next.has(basename)) next.set(basename, url);
		}
		if (typeof URL.revokeObjectURL === "function") {
			const retained = new Set(next.values());
			for (const url of new Set(session.imageUrls.values())) {
				if (!retained.has(url)) URL.revokeObjectURL(url);
			}
		}
		session.imageUrls.clear();
		for (const [key, url] of next) {
			session.imageUrls.set(key, url);
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
	 * Reads and encrypts any linked vault images referenced in `text` without deleting
	 * their source files from disk until the encrypted note payload is durably saved.
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
	 * Updates in-memory blob: preview URLs for newly staged images without deleting disk files.
	 */
	private refreshPreviewImageUrls(
		session: ViewSession,
		staged: StagedVaultImages,
	): void {
		if (session.state !== "unlocked" || Object.keys(staged.absorbed).length === 0) return;
		this.populateImageUrls(session, staged.absorbed);
		const cm = (
			session.view.editor as unknown as {
				cm?: { dispatch: (tr: Record<string, never>) => void };
			}
		).cm;
		cm?.dispatch({});
	}

	/**
	 * Stages images newly referenced by the editor buffer and re-encrypts the
	 * payload so they are absorbed without waiting for an explicit save.
	 */
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
		await this.enqueueWrite(session, () =>
			this.app.vault.modify(
				session.file,
				serializeFile(session.decoyBody, nextPayload),
			),
		);
		session.originalPayload = nextPayload;
		session.pendingPayload = nextPayload;
		this.refreshPreviewImageUrls(session, result.staged);
		await deleteStagedVaultImages(
			this.app,
			this.persistedStagedFiles(result.staged.filesToDelete, nextPayload.images),
		);
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
					const lockedPayload = await reencryptRealText(
						session.originalPayload,
						session.dek,
						current,
						mergedImages,
						session.realTitle,
					);
					session.pendingPayload = lockedPayload;
					await this.enqueueWrite(session, () =>
						this.app.vault.modify(
							session.file,
							serializeFile(session.decoyBody, lockedPayload),
						),
					);
					session.originalPayload = lockedPayload;
					await deleteStagedVaultImages(
						this.app,
						this.persistedStagedFiles(
							imageStage?.staged.filesToDelete ?? [],
							lockedPayload.images,
						),
					);
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

	/**
	 * Masks every session, reporting and swallowing a per-session failure so one
	 * rejected write cannot leave the remaining notes plaintext. Keeping this
	 * method total also lets `maskAll` reach the clipboard clear and content
	 * protection that follow it.
	 */
	async lockAll(reason: string): Promise<void> {
		const results = await Promise.allSettled(
			this.all().map((session) => this.lock(session, reason)),
		);
		for (const result of results) {
			if (result.status === "rejected") {
				console.warn("Veneer: lock failed", result.reason);
			}
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
		if (session.state !== "unlocked" || !session.dek || session.lockingPromise !== null) return;
		const seq = ++session.reencryptSeq;
		if (session.reencryptTimer !== null) clearTimeout(session.reencryptTimer);
		session.reencryptTimer = setTimeout(() => {
			session.reencryptTimer = null;
			const prev = session.reencryptPromise ?? Promise.resolve();
			const next = prev
				.catch(() => undefined)
				.then(async () => {
					if (
						session.state !== "unlocked" ||
						!session.dek ||
						session.lockingPromise !== null ||
						session.reencryptSeq !== seq
					) {
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
							session.lockingPromise !== null ||
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
							session.lockingPromise !== null ||
							session.reencryptSeq !== seq
						) {
							return;
						}
						session.realTitle = snapshotTitle;
						session.pendingPayload = nextPayload;
						// Hold the staged source files until this payload is actually
						// written to disk, so a failed save cannot delete them.
						if (imageStage.staged.filesToDelete.length > 0) {
							session.stagedFilesByPayload.set(
								nextPayload,
								imageStage.staged.filesToDelete,
							);
						}
						this.refreshPreviewImageUrls(session, imageStage.staged);
						(session.view as unknown as { requestSave?: () => void }).requestSave?.();
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

	/**
	 * Serializes disk writes (`MarkdownView.save` and `lock`'s `vault.modify`)
	 * for a single session so an in-flight save cannot land after `lock()` and
	 * overwrite newer ciphertext, and a new save cannot start until `lock()`'s
	 * write completes.
	 */
	enqueueWrite<T>(session: ViewSession, task: () => Promise<T>): Promise<T> {
		const prev = session.writePromise ?? Promise.resolve();
		const run = prev.catch(() => undefined).then(task);
		const tracked = run.then(
			() => undefined,
			() => undefined,
		);
		session.writePromise = tracked;
		void tracked.finally(() => {
			if (session.writePromise === tracked) {
				session.writePromise = null;
			}
		});
		return run;
	}

	/**
	 * The payload a save would write for this session right now. Mirrors
	 * `computeSavedContent` so a completed save can be matched to its images.
	 */
	savedPayloadFor(session: ViewSession): PayloadV1 {
		return session.state === "unlocked"
			? (session.pendingPayload ?? session.originalPayload)
			: session.originalPayload;
	}

	/**
	 * Marks `persisted` as durably on disk: it becomes the new baseline and any
	 * staged source files queued for it are released. Matching is by payload
	 * identity, so saving a stale snapshot releases nothing.
	 */
	async commitPersistedPayload(session: ViewSession, persisted: PayloadV1): Promise<void> {
		if (session.state !== "unlocked" || session.lockingPromise !== null) return;
		session.originalPayload = persisted;
		const staged = session.stagedFilesByPayload.get(persisted);
		if (!staged) return;
		session.stagedFilesByPayload.delete(persisted);
		await deleteStagedVaultImages(
			this.app,
			this.persistedStagedFiles(staged, persisted.images),
		);
	}

	/**
	 * Narrows `staged` to the files whose bytes are present in the persisted
	 * payload, so a source removed from the note before a save is never deleted.
	 */
	private persistedStagedFiles(
		staged: readonly StagedFile[],
		images: PayloadV1["images"],
	): StagedFile[] {
		if (staged.length === 0) return [];
		return staged.filter((entry) => entry.keys.some((key) => key in (images ?? {})));
	}
}
