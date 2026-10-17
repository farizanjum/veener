import type { App, MarkdownView, TFile } from "obsidian";
import {
	encryptImageMap,
	reencryptRealText,
	serializeFile,
	unlockPayload,
	type ParsedFile,
	type PayloadV1,
} from "../crypto/payload";
import { absorbVaultImages } from "../crypto/images";
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
}

export interface SessionHooks {
	onUnlocked(session: ViewSession): void;
	onLocked(session: ViewSession): void;
	onUnlockBlocked(reason: string): void;
}

const REENCRYPT_DEBOUNCE_MS = 250;

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
				if (existing.state === "unlocked") void this.lock(existing, "reload");
				return existing;
			}
			if (existing.state === "unlocked") {
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

	async absorbNewEditorImages(session: ViewSession): Promise<void> {
		if (session.state !== "unlocked" || !session.dek) return;
		const text = session.view.editor.getValue();
		const newImages = await absorbVaultImages(this.app, session.file.path, text);
		if (Object.keys(newImages).length === 0) return;
		if (session.state !== "unlocked" || !session.dek) return;
		const encryptedNew = await encryptImageMap(
			session.dek,
			session.originalPayload.note_id,
			newImages,
		);
		session.originalPayload = {
			...session.originalPayload,
			images: {
				...(session.originalPayload.images ?? {}),
				...encryptedNew,
			},
		};
		this.populateImageUrls(session, newImages);
		const cm = (session.view.editor as unknown as { cm?: { dispatch: (tr: Record<string, never>) => void } }).cm;
		cm?.dispatch({});
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
		if (session.state !== "unlocked") return;
		console.debug(`Veneer: masking note (${reason})`);
		const sameFile = session.view.file === session.file;
		try {
			if (session.dek && sameFile) {
				await this.absorbNewEditorImages(session);
				const current = session.view.editor.getValue();
				session.realTitle = this.readEditedInlineTitle(session);
				session.pendingPayload = await reencryptRealText(
					session.originalPayload,
					session.dek,
					current,
					session.originalPayload.images,
					session.realTitle,
				);
				await this.app.vault.modify(
					session.file,
					serializeFile(session.decoyBody, session.pendingPayload),
				);
				session.originalPayload = session.pendingPayload;
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
		if (session.reencryptTimer !== null) clearTimeout(session.reencryptTimer);
		session.reencryptTimer = setTimeout(() => {
			session.reencryptTimer = null;
			void (async () => {
				if (session.state !== "unlocked" || !session.dek) return;
				try {
					await this.absorbNewEditorImages(session);
					if (session.state !== "unlocked" || !session.dek) return;
					const currentTitle = this.readEditedInlineTitle(session);
					session.realTitle = currentTitle;
					session.pendingPayload = await reencryptRealText(
						session.originalPayload,
						session.dek,
						session.view.editor.getValue(),
						session.originalPayload.images,
						session.realTitle,
					);
				} catch (error) {
					console.warn("Veneer: re-encryption skipped, keeping last good ciphertext", error);
				}
			})();
		}, REENCRYPT_DEBOUNCE_MS);
	}
}
