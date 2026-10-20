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
	lockingPromise: Promise<void> | null;
	killGeneration: number;
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
	onLockFailed?(error: unknown): void;
}

export const REENCRYPT_DEBOUNCE_MS = 600;

export class SessionManager {
	private readonly byView = new WeakMap<MarkdownView, ViewSession>();
	private readonly byPath = new Map<string, Set<ViewSession>>();
	private readonly reservedPaths = new Map<string, number>();
	private readonly pendingLocks = new Set<ViewSession>();
	private readonly deferredSaves = new Map<string, Set<() => void>>();

	/** Monotonic epoch fencing duress writes; `runReservedWrite` declines stale snapshots. */
	private killEpoch = 0;
	/** In-flight reserved writes under a live epoch; `hardKillAll` awaits these. */
	private readonly reservationWrites = new Set<Promise<void>>();
	/** Last-known clean decoy per path, used as the shred rewrite fallback. */
	private readonly lastKnownDecoy = new Map<string, string>();

	constructor(
		private readonly app: App,
		private readonly hooks: SessionHooks,
		private readonly triggerPrefix: () => string,
		private readonly unlockBlockReason: () => string | null,
	) {}

	private addToPath(path: string, session: ViewSession): void {
		let set = this.byPath.get(path);
		if (!set) {
			set = new Set<ViewSession>();
			this.byPath.set(path, set);
		}
		set.add(session);
	}

	private removeFromPath(path: string, session: ViewSession): void {
		const set = this.byPath.get(path);
		if (!set) return;
		set.delete(session);
		if (set.size === 0) {
			this.byPath.delete(path);
		}
	}

	get(view: MarkdownView): ViewSession | null {
		return this.byView.get(view) ?? null;
	}

	getAllByPath(path: string): ViewSession[] {
		const set = this.byPath.get(path);
		return set ? [...set] : [];
	}

	getByPath(path: string): ViewSession | null {
		const sessions = this.getAllByPath(path);
		if (sessions.length === 0) return null;
		return sessions.find((s) => s.state === "unlocked") ?? sessions[sessions.length - 1] ?? null;
	}

	/**
	 * Blocks new masking/unlocking work for a path while a caller writes the file
	 * directly, so no session can interleave a conflicting write. Returns an
	 * idempotent release.
	 */
	reservePath(path: string): () => void {
		const nextCount = (this.reservedPaths.get(path) ?? 0) + 1;
		this.reservedPaths.set(path, nextCount);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.reservedPaths.get(path) ?? 1) - 1;
			if (remaining <= 0) {
				this.reservedPaths.delete(path);
				this.flushDeferredSaves(path);
			} else {
				this.reservedPaths.set(path, remaining);
			}
		};
	}

	/** Current kill epoch; capture it before the first await of a duress write flow. */
	currentKillEpoch(): number {
		return this.killEpoch;
	}

	/**
	 * Runs `task` only while the captured epoch is still live; declines (never
	 * invokes `task`) once a shred has bumped the epoch. Registers the write
	 * under a non-rejecting shadow so `hardKillAll` awaits it; rejections
	 * still propagate to the caller unchanged.
	 */
	runReservedWrite(startEpoch: number, task: () => Promise<void>): Promise<boolean> {
		if (startEpoch !== this.killEpoch) return Promise.resolve(false);
		const write = task();
		const shadow = write.then(
			() => {},
			() => {},
		);
		this.reservationWrites.add(shadow);
		void shadow.then(() => {
			this.reservationWrites.delete(shadow);
		});
		return write.then(() => true);
	}

	/** Remembers the last-known clean decoy for `path` (shred rewrite fallback). */
	rememberDecoy(path: string, decoy: string): void {
		this.lastKnownDecoy.set(path, decoy);
	}

	/** Last-known clean decoy for `path`, or `null` when none is remembered. */
	getDecoyFallback(path: string): string | null {
		return this.lastKnownDecoy.get(path) ?? null;
	}

	/**
	 * Records a save that was skipped because `path` was reserved, so it can be
	 * replayed once the last reservation on that path releases. The holder sets
	 * decoy and payload state synchronously before its write, so a post-release
	 * `getViewData()` reads a consistent decoy + current ciphertext.
	 */
	deferSave(path: string, run: () => void): void {
		let set = this.deferredSaves.get(path);
		if (!set) {
			set = new Set<() => void>();
			this.deferredSaves.set(path, set);
		}
		set.add(run);
	}

	private flushDeferredSaves(path: string): void {
		const set = this.deferredSaves.get(path);
		if (!set) return;
		this.deferredSaves.delete(path);
		for (const run of set) {
			try {
				run();
			} catch (error) {
				console.warn("Veneer: deferred save after reservation failed", error);
			}
		}
	}

	/** True while some caller holds the path via {@link reservePath}. */
	isPathReserved(path: string): boolean {
		return this.reservedPaths.has(path);
	}

	/** True while `session` is still the session mapped to its view. */
	private isAttached(session: ViewSession): boolean {
		return this.byView.get(session.view) === session;
	}

	/**
	 * Re-reads `session.state` across a call boundary. Read directly, the declared
	 * union stays narrowed to the result of any earlier `state === "..."` check,
	 * which would hide a concurrent transition of the same field.
	 */
	private stateOf(session: ViewSession): ViewSession["state"] {
		return session.state;
	}

	hasLiveSession(path: string): boolean {
		if (this.reservedPaths.has(path)) return true;
		for (const session of this.pendingLocks) {
			if (session.file.path === path) return true;
		}
		const set = this.byPath.get(path);
		if (!set) return false;
		for (const session of set) {
			if (session.state === "unlocked" || session.lockingPromise !== null) {
				return true;
			}
		}
		return false;
	}

	all(): ViewSession[] {
		const out: ViewSession[] = [];
		for (const set of this.byPath.values()) {
			out.push(...set);
		}
		return out;
	}

	attachFromLoad(view: MarkdownView, file: TFile, parsed: ParsedFile): ViewSession {
		const existing = this.byView.get(view);
		if (existing) {
			if (existing.file === file) {
				existing.decoyBody = parsed.decoyBody;
				existing.originalPayload = parsed.payload;
				this.rememberDecoy(file.path, parsed.decoyBody);
				if (existing.state === "unlocked") {
					void this.lock(existing, "reload").catch((error) => {
						console.warn("Veneer: lock on reload failed", error);
					});
				}
				return existing;
			}
			// A pending mask keeps its captured state and finishes on its own, so only
			// its mappings move to the new session; invalidating it here would strand
			// an in-flight re-encrypt mid-write.
			if (existing.lockingPromise === null) {
				existing.killGeneration += 1;
				if (existing.state === "unlocked") {
					existing.dek?.fill(0);
					existing.dek = null;
					this.revokeImageUrls(existing);
					existing.state = "locked";
					existing.lockingPromise = null;
					existing.pendingPayload = null;
					existing.realTitle = null;
					existing.capture.cancel();
					existing.reencryptSeq += 1;
					if (existing.reencryptTimer !== null) {
						clearTimeout(existing.reencryptTimer);
						existing.reencryptTimer = null;
					}
					this.hooks.onLocked(existing);
				}
			}
			this.removeFromPath(existing.file.path, existing);
			this.byView.delete(view);
		}
		const session: ViewSession = {
			view,
			file,
			state: "locked",
			lockingPromise: null,
			killGeneration: 0,
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
			writePromise: null,
			stagedFilesByPayload: new WeakMap(),
		};
		this.byView.set(view, session);
		this.addToPath(file.path, session);
		this.rememberDecoy(file.path, parsed.decoyBody);
		return session;
	}

	renamePath(oldPath: string, newPath: string): void {
		if (oldPath === newPath) return;
		const existingSet = this.byPath.get(oldPath);
		if (!existingSet) return;
		this.byPath.delete(oldPath);
		const targetSet = this.byPath.get(newPath);
		if (targetSet) {
			for (const session of existingSet) targetSet.add(session);
		} else {
			this.byPath.set(newPath, existingSet);
		}
		const movedDecoy = this.lastKnownDecoy.get(oldPath);
		if (movedDecoy !== undefined) {
			this.lastKnownDecoy.delete(oldPath);
			this.lastKnownDecoy.set(newPath, movedDecoy);
		}
	}

	pruneDetached(activeViews: Set<MarkdownView>): void {
		for (const session of this.all()) {
			if (!activeViews.has(session.view)) this.detach(session.view);
		}
	}

	detach(view: MarkdownView): void {
		const session = this.byView.get(view);
		if (!session) return;
		void this.lock(session, "detach").catch((error) => {
			console.warn("Veneer: lock on detach failed", error);
		});
		this.byView.delete(view);
		this.removeFromPath(session.file.path, session);
	}

	/**
	 * Immediately zeroes keys, cancels timers/in-flight locks, and detaches a session
	 * without re-encrypting or writing decoy content back to disk (used when unprotecting).
	 */
	discardAndDetach(session: ViewSession): boolean {
		if (this.byView.get(session.view) !== session) return false;
		session.killGeneration += 1;
		session.dek?.fill(0);
		session.dek = null;
		this.revokeImageUrls(session);
		session.state = "locked";
		session.lockingPromise = null;
		session.pendingPayload = null;
		session.realTitle = null;
		session.capture.cancel();
		session.reencryptSeq += 1;
		if (session.reencryptTimer !== null) {
			clearTimeout(session.reencryptTimer);
			session.reencryptTimer = null;
		}
		this.pendingLocks.delete(session);
		this.byView.delete(session.view);
		this.removeFromPath(session.file.path, session);
		this.hooks.onLocked(session);
		return true;
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
		const startGeneration = session.killGeneration;
		if (this.reservedPaths.has(session.file.path)) return "blocked";
		if (session.lockingPromise !== null) {
			try {
				await session.lockingPromise;
			} catch (error) {
				console.warn("Veneer: prior lock failed before unlock", error);
			}
		}
		if (session.killGeneration !== startGeneration || !this.isAttached(session)) return "blocked";
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
			// A concurrent unlock() may have won while we awaited derivation, or a mask
			// may have started. Either way this derivation lost; zero only our freshly
			// derived key so we never touch the winner's live key material.
			const stateAfterDerivation = this.stateOf(session);
			if (stateAfterDerivation === "unlocked" || session.lockingPromise !== null) {
				dek.fill(0);
				return stateAfterDerivation === "unlocked" ? "ok" : "blocked";
			}
			if (
				session.killGeneration !== startGeneration ||
				!this.isAttached(session) ||
				this.isPathReserved(session.file.path)
			) {
				dek.fill(0);
				session.dek?.fill(0);
				session.dek = null;
				return "blocked";
			}
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
			if (session.killGeneration !== startGeneration) return "blocked";
			session.backoff.recordFailure(now);
			return "wrong";
		}
	}

	/**
	 * Coalesces concurrent mask triggers, snapshots the DEK and editor state,
	 * re-encrypts the latest plaintext to disk, zeroes key material, and restores the decoy cover.
	 */
	lock(session: ViewSession, reason: string): Promise<void> {
		if (this.reservedPaths.has(session.file.path)) return Promise.resolve();
		if (session.lockingPromise !== null) return session.lockingPromise;
		if (session.state !== "unlocked") return Promise.resolve();
		session.reencryptSeq += 1;
		if (session.reencryptTimer !== null) {
			clearTimeout(session.reencryptTimer);
			session.reencryptTimer = null;
		}
		console.debug(`Veneer: masking note (${reason})`);
		const sameFile = session.view.file === session.file;
		let currentText = sameFile ? session.view.editor.getValue() : "";
		let currentTitle = sameFile ? this.readEditedInlineTitle(session) : session.realTitle;
		const dek = session.dek ? new Uint8Array(session.dek) : null;
		const startGeneration = session.killGeneration;
		let resolveLock!: () => void;
		let rejectLock!: (reason?: unknown) => void;
		const lockingPromise = new Promise<void>((resolve, reject) => {
			resolveLock = resolve;
			rejectLock = reject;
		});
		session.lockingPromise = lockingPromise;
		this.pendingLocks.add(session);
		void (async (): Promise<void> => {
			let lockError: unknown = null;
			let hasFailed = false;
			try {
				if (
					dek &&
					sameFile &&
					session.lockingPromise === lockingPromise &&
					session.killGeneration === startGeneration
				) {
					const imageStage = await this.stageEditorImages(session, currentText);
					const mergedImages = imageStage?.mergedImages ?? session.originalPayload.images;
					if (session.lockingPromise !== lockingPromise || session.killGeneration !== startGeneration) return;
					if (
						this.isAttached(session) &&
						session.view.file === session.file &&
						session.state === "unlocked"
					) {
						const postStageText = session.view.editor.getValue();
						if (postStageText !== currentText && postStageText !== session.decoyBody) {
							currentText = postStageText;
						}
						currentTitle = this.readEditedInlineTitle(session);
					}
					session.realTitle = currentTitle;
					let lockedPayload = await reencryptRealText(
						session.originalPayload,
						dek,
						currentText,
						mergedImages,
						session.realTitle,
					);
					if (session.lockingPromise !== lockingPromise || session.killGeneration !== startGeneration) return;
					if (
						this.isAttached(session) &&
						session.view.file === session.file &&
						session.state === "unlocked"
					) {
						const latestText = session.view.editor.getValue();
						if (latestText !== currentText && latestText !== session.decoyBody) {
							currentText = latestText;
							currentTitle = this.readEditedInlineTitle(session);
							session.realTitle = currentTitle;
							lockedPayload = await reencryptRealText(
								session.originalPayload,
								dek,
								currentText,
								mergedImages,
								session.realTitle,
							);
							if (
								session.lockingPromise !== lockingPromise ||
								session.killGeneration !== startGeneration
							) {
								return;
							}
						}
					}
					session.pendingPayload = lockedPayload;
					if (this.isPathReserved(session.file.path)) return;
					await this.enqueueWrite(session, () =>
						this.app.vault.modify(
							session.file,
							serializeFile(session.decoyBody, lockedPayload),
						),
					);
					if (session.lockingPromise !== lockingPromise || session.killGeneration !== startGeneration) return;
					session.originalPayload = lockedPayload;
					for (const peer of this.getAllByPath(session.file.path)) {
						peer.originalPayload = lockedPayload;
					}
					await deleteStagedVaultImages(
						this.app,
						this.persistedStagedFiles(
							imageStage?.staged.filesToDelete ?? [],
							lockedPayload.images,
						),
					);
				}
			} catch (error) {
				hasFailed = true;
				lockError = error;
			} finally {
				dek?.fill(0);
				const ownedOnExit =
					session.lockingPromise === lockingPromise && session.killGeneration === startGeneration;
				if (ownedOnExit) {
					session.dek?.fill(0);
					session.dek = null;
					this.revokeImageUrls(session);
					session.state = "locked";
					session.lockingPromise = null;
					session.pendingPayload = null;
					session.capture.cancel();
					if (session.reencryptTimer !== null) {
						clearTimeout(session.reencryptTimer);
						session.reencryptTimer = null;
					}
					if (this.isAttached(session) && sameFile && session.view.file === session.file) {
						session.view.setViewData(session.decoyBody, true);
						this.applyDisplayedTitle(session, session.file.basename);
					}
					session.realTitle = null;
					this.hooks.onLocked(session);
					if (hasFailed) {
						this.hooks.onLockFailed?.(lockError);
						rejectLock(lockError);
					} else {
						resolveLock();
					}
				} else {
					resolveLock();
				}
				this.pendingLocks.delete(session);
			}
		})();
		return lockingPromise;
	}

	/**
	 * Masks every session in order. A per-session failure is recorded but does
	 * not abort the loop, so one rejected write cannot leave the remaining notes
	 * plaintext; the first error is rethrown once every session has been masked.
	 * Callers that must stay total (`maskAll`, which still clears the clipboard
	 * and re-enables content protection afterwards) catch and warn.
	 */
	async lockAll(reason: string): Promise<void> {
		const sessions = this.all();
		const chains = new Map<string, Promise<void>>();
		const failures = new Map<number, unknown>();

		sessions.forEach((session, index) => {
			const previous = chains.get(session.file.path) ?? Promise.resolve();
			const current = previous
				.then(() => this.lock(session, reason))
				.catch((error) => {
					failures.set(index, error);
				});
			chains.set(session.file.path, current);
		});

		await Promise.all(chains.values());
		let firstFailure: { index: number; reason: unknown } | null = null;
		for (const [index, reason] of failures) {
			if (firstFailure === null || index < firstFailure.index) {
				firstFailure = { index, reason };
			}
		}
		if (firstFailure !== null) {
			throw firstFailure.reason;
		}
	}

	/**
	 * Immediate mask with NO re-encryption: used by the duress shred (§11.2).
	 * Drops keys and swaps to decoy; the shred deletes the payload from disk.
	 * Killed sessions are also detached from their pane and path, queued deferred
	 * saves are discarded, and every in-flight reservation write is awaited, so
	 * nothing can re-serialize a payload or replay a save after the shred runs.
	 */
	hardKillAll(): Promise<void> {
		this.killEpoch += 1;
		const inflight: Promise<void>[] = [...this.reservationWrites];
		for (const session of new Set([...this.all(), ...this.pendingLocks])) {
			if (session.lockingPromise !== null) {
				inflight.push(session.lockingPromise);
			}
			if (session.writePromise !== null) {
				inflight.push(session.writePromise);
			}
			session.killGeneration += 1;
			session.dek?.fill(0);
			session.dek = null;
			this.revokeImageUrls(session);
			session.state = "locked";
			session.lockingPromise = null;
			session.pendingPayload = null;
			session.capture.cancel();
			session.reencryptSeq += 1;
			if (session.reencryptTimer !== null) {
				clearTimeout(session.reencryptTimer);
				session.reencryptTimer = null;
			}
			if (this.isAttached(session) && session.view.file === session.file) {
				session.view.setViewData(session.decoyBody, true);
				this.applyDisplayedTitle(session, session.file.basename);
			}
			session.realTitle = null;
			if (this.isAttached(session)) {
				this.byView.delete(session.view);
			}
			this.removeFromPath(session.file.path, session);
			this.pendingLocks.delete(session);
			this.hooks.onLocked(session);
		}
		this.deferredSaves.clear();
		return Promise.allSettled(inflight).then(() => undefined);
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
