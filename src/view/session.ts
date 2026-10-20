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
import {
	getSharedLifecycleCoordinator,
	type CommittedDisposition,
	type FrozenSafeSnapshot,
	type OwnerPhase,
	type OwnerToken,
	type ViewLifecycleCoordinator,
	type WriteAdmissionResult,
	type WriteJobKind,
} from "./lifecycle";

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

export interface SessionRetirementGroup {
	readonly file: TFile;
	readonly path: string;
	readonly sessions: readonly ViewSession[];
	readonly pendingLockSessions: readonly ViewSession[];
	readonly allSessions: readonly ViewSession[];
	readonly isReserved: boolean;
	readonly committedDisposition: CommittedDisposition | null;
	readonly frozenSnapshot: FrozenSafeSnapshot | null;
}

export interface SessionRetirementPreparation {
	readonly owner: OwnerToken;
	readonly killEpoch: number;
	readonly groupsByFile: ReadonlyMap<TFile, SessionRetirementGroup>;
	readonly allCapturedSessions: readonly ViewSession[];
	readonly wipedDekCount: number;
	readonly revokedUrls: readonly string[];
	readonly clearedTimersCount: number;
	readonly cancelledCapturesCount: number;
	readonly errors: readonly unknown[];
}

export interface PrepareRetirementOptions {
	/**
	 * Optional synchronous hook invoked inside Pass 1 BEFORE keys/pendingPayloads
	 * are wiped or sessions are detached, allowing Task 4 (`shutdownAndHandoff`)
	 * to freeze per-file safe snapshots from live session state.
	 */
	readonly beforeWipe?: (groups: ReadonlyMap<TFile, SessionRetirementGroup>) => void;
	/**
	 * When true (default), detaches all tracked sessions from `byView` and `byPath`
	 * after wiping keys and revoking resources.
	 */
	readonly detachSessions?: boolean;
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

	/** Shared lifecycle coordinator and owner token for cross-reload fencing. */
	private readonly coordinator: ViewLifecycleCoordinator;
	private readonly owner: OwnerToken;

	/** Terminal manager state set synchronously when retirement begins. */
	private disposed = false;
	private retirementPreparation: SessionRetirementPreparation | null = null;
	private retirementSessionsDetached = false;

	/**
	 * Every live DEK `Uint8Array` owned by this manager (session keys, `lock()`'s
	 * local copy, and command-derived keys registered via `registerOwnedDek`).
	 * Wiped synchronously on retirement or `hardKillAll`, and in each owner's `finally`.
	 */
	private readonly ownedDeks = new Set<Uint8Array>();

	constructor(
		private readonly app: App,
		private readonly hooks: SessionHooks,
		private readonly triggerPrefix: () => string,
		private readonly unlockBlockReason: () => string | null,
		coordinator?: ViewLifecycleCoordinator,
		owner?: OwnerToken,
	) {
		this.coordinator = coordinator ?? getSharedLifecycleCoordinator();
		this.owner = owner ?? this.coordinator.registerOwner(this.app);
	}

	/** Returns the shared `ViewLifecycleCoordinator` governing this manager. */
	getCoordinator(): ViewLifecycleCoordinator {
		return this.coordinator;
	}

	/** Returns the unique `OwnerToken` representing this plugin/manager instance. */
	getOwnerToken(): OwnerToken {
		return this.owner;
	}

	/** Returns the current lifecycle phase of this manager's owner token. */
	getOwnerPhase(): OwnerPhase {
		return this.coordinator.getOwnerPhase(this.owner);
	}

	/**
	 * True once this manager has entered retirement or its owner token is no longer
	 * in the `"active"` phase. All normal manager entry points, post-await continuations,
	 * and queued tasks refuse work once `isDisposed()` is true.
	 */
	isDisposed(): boolean {
		return this.disposed || !this.coordinator.isOwnerActive(this.owner);
	}

	/**
	 * Registers a transient or session-owned DEK byte array so it is guaranteed to be
	 * zeroed synchronously if retirement or duress occurs while it is live.
	 * Returns an idempotent `releaseAndWipe` cleanup function for `finally` blocks.
	 */
	registerOwnedDek(dek: Uint8Array | null | undefined): () => void {
		if (!dek) return () => undefined;
		if (this.isDisposed()) {
			dek.fill(0);
			return () => {
				dek.fill(0);
			};
		}
		this.ownedDeks.add(dek);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.ownedDeks.delete(dek);
			dek.fill(0);
		};
	}

	/**
	 * Unregisters a DEK array from `ownedDeks` and zeroes its bytes in place.
	 */
	releaseOwnedDek(dek: Uint8Array | null | undefined): void {
		if (!dek) return;
		this.ownedDeks.delete(dek);
		dek.fill(0);
	}

	/**
	 * Returns a snapshot of currently tracked live DEK arrays (for testing/diagnostics).
	 */
	getTrackedOwnedDeks(): readonly Uint8Array[] {
		return [...this.ownedDeks];
	}

	/**
	 * Synchronously wipes all tracked owned DEK arrays (including `session.dek`,
	 * `lock()`'s local DEK copy, and any command-registered keys) and clears the set.
	 */
	private wipeAllOwnedDeks(sessions: Iterable<ViewSession>): number {
		const seen = new Set<Uint8Array>();
		for (const dek of this.ownedDeks) {
			seen.add(dek);
		}
		for (const session of sessions) {
			if (session.dek) {
				seen.add(session.dek);
			}
		}
		this.ownedDeks.clear();
		for (const dek of seen) {
			try {
				dek.fill(0);
			} catch {
				// Ignore errors on exotic buffer views; isolate each array wipe.
			}
		}
		for (const session of sessions) {
			session.dek = null;
		}
		return seen.size;
	}

	/**
	 * Collects all currently tracked sessions and detached `pendingLocks` grouped by `TFile`
	 * so Task 4 (`shutdownAndHandoff`) can inspect and freeze per-file safe snapshots before
	 * or during retirement.
	 */
	collectFileSessionGroups(): Map<TFile, SessionRetirementGroup> {
		const activeByFile = new Map<TFile, ViewSession[]>();
		const pendingByFile = new Map<TFile, ViewSession[]>();
		const allFiles = new Set<TFile>();

		for (const session of this.all()) {
			allFiles.add(session.file);
			let list = activeByFile.get(session.file);
			if (!list) {
				list = [];
				activeByFile.set(session.file, list);
			}
			if (!list.includes(session)) {
				list.push(session);
			}
		}

		for (const session of this.pendingLocks) {
			allFiles.add(session.file);
			let list = pendingByFile.get(session.file);
			if (!list) {
				list = [];
				pendingByFile.set(session.file, list);
			}
			if (!list.includes(session)) {
				list.push(session);
			}
		}

		const groups = new Map<TFile, SessionRetirementGroup>();
		for (const file of allFiles) {
			const sessions = activeByFile.get(file) ?? [];
			const pendingLockSessions = pendingByFile.get(file) ?? [];
			const combined: ViewSession[] = [...sessions];
			for (const p of pendingLockSessions) {
				if (!combined.includes(p)) {
					combined.push(p);
				}
			}
			groups.set(file, {
				file,
				path: file.path,
				sessions,
				pendingLockSessions,
				allSessions: combined,
				isReserved: this.reservedPaths.has(file.path),
				committedDisposition: this.coordinator.getCommittedDisposition(this.app, file),
				frozenSnapshot: this.coordinator.getFrozenSnapshot(this.app, file),
			});
		}

		return groups;
	}

	/**
	 * Returns the captured `SessionRetirementPreparation` from `prepareRetirement()`, if retired.
	 */
	getRetirementPreparation(): SessionRetirementPreparation | null {
		return this.retirementPreparation;
	}

	/**
	 * Idempotent synchronous retirement-preparation API (Clause 1 & Clause 5).
	 *
	 * With NO await:
	 * 1. Marks this manager terminal (`disposed = true`) and transitions the owner token
	 *    to `"retiring"` BEFORE any external hook can run.
	 * 2. Captures all tracked sessions and detached `pendingLocks` grouped by `TFile`,
	 *    running optional `options.beforeWipe` while `pendingPayload` / `realTitle` are intact.
	 * 3. Bumps `killGeneration` and `reencryptSeq` on every session, clears all `reencryptTimer`s,
	 *    cancels all `CaptureBuffer`s, wipes every tracked owned DEK array, revokes every
	 *    preview `blob:` URL, clears `deferredSaves` and `pendingLocks`, and transitions
	 *    sessions to `"locked"` with `realTitle = null` and `pendingPayload = null`.
	 * 4. Isolates per-session/per-URL/per-hook failures so a throwing hook or `revokeObjectURL`
	 *    never prevents the remaining keys, timers, URLs, or sessions from being sanitized.
	 */
	prepareRetirement(options?: PrepareRetirementOptions): SessionRetirementPreparation {
		const shouldDetach = options?.detachSessions ?? true;

		if (this.retirementPreparation !== null) {
			if (options?.beforeWipe) {
				try {
					options.beforeWipe(this.retirementPreparation.groupsByFile);
				} catch {
					// Isolated hook failure on idempotent re-entry
				}
			}
			// Ensure any late-registered DEKs or resources are still wiped on repeated calls
			this.wipeAllOwnedDeks(this.retirementPreparation.allCapturedSessions);
			this.deferredSaves.clear();
			this.pendingLocks.clear();
			if (shouldDetach && !this.retirementSessionsDetached) {
				this.detachCapturedSessions(this.retirementPreparation.allCapturedSessions);
				this.retirementSessionsDetached = true;
			}
			return this.retirementPreparation;
		}

		// Step 1: Mark terminal BEFORE any external hook or callback can run.
		this.disposed = true;
		if (this.owner.phase === "active") {
			this.owner.phase = "retiring";
		}

		const errors: unknown[] = [];
		const groupsByFile = this.collectFileSessionGroups();
		const allCapturedSessions: ViewSession[] = [];
		for (const group of groupsByFile.values()) {
			for (const session of group.allSessions) {
				if (!allCapturedSessions.includes(session)) {
					allCapturedSessions.push(session);
				}
			}
		}

		if (options?.beforeWipe) {
			try {
				options.beforeWipe(groupsByFile);
			} catch (error) {
				errors.push(error);
			}
		}

		// Step 2: Synchronously wipe all tracked owned DEKs (session.dek, lock local copies, command keys).
		const wipedDekCount = this.wipeAllOwnedDeks(allCapturedSessions);

		// Step 3: Cancel timers, capture buffers, and revoke preview URLs with per-operation error isolation.
		let clearedTimersCount = 0;
		let cancelledCapturesCount = 0;
		const revokedUrls: string[] = [];

		for (const session of allCapturedSessions) {
			session.killGeneration += 1;
			session.reencryptSeq += 1;

			if (session.reencryptTimer !== null) {
				try {
					clearTimeout(session.reencryptTimer);
					clearedTimersCount += 1;
				} catch (error) {
					errors.push(error);
				} finally {
					session.reencryptTimer = null;
				}
			}

			try {
				session.capture.cancel();
				cancelledCapturesCount += 1;
			} catch (error) {
				errors.push(error);
			}

			const sessionRevoked = this.revokeImageUrlsIsolated(session, errors);
			for (const url of sessionRevoked) {
				if (!revokedUrls.includes(url)) {
					revokedUrls.push(url);
				}
			}

			session.state = "locked";
			session.lockingPromise = null;
			session.pendingPayload = null;
			session.realTitle = null;
		}

		// Step 4: Invalidate deferred saves and clean pendingLocks before any external hook.
		this.deferredSaves.clear();
		this.pendingLocks.clear();

		// Step 5: Optionally detach sessions from view/path maps.
		if (shouldDetach) {
			this.detachCapturedSessions(allCapturedSessions);
			this.retirementSessionsDetached = true;
		}

		// Step 6: Notify onLocked hooks with error isolation so one throwing hook cannot abort cleanup.
		for (const session of allCapturedSessions) {
			try {
				this.hooks.onLocked(session);
			} catch (error) {
				errors.push(error);
			}
		}

		const preparation: SessionRetirementPreparation = {
			owner: this.owner,
			killEpoch: this.killEpoch,
			groupsByFile,
			allCapturedSessions,
			wipedDekCount,
			revokedUrls,
			clearedTimersCount,
			cancelledCapturesCount,
			errors,
		};
		this.retirementPreparation = preparation;
		return preparation;
	}

	private detachCapturedSessions(sessions: readonly ViewSession[]): void {
		for (const session of sessions) {
			if (this.byView.get(session.view) === session) {
				this.byView.delete(session.view);
			}
			this.removeFromPath(session.file.path, session);
		}
		this.byPath.clear();
	}

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
		if (this.isDisposed()) {
			return () => undefined;
		}
		const nextCount = (this.reservedPaths.get(path) ?? 0) + 1;
		this.reservedPaths.set(path, nextCount);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.reservedPaths.get(path) ?? 1) - 1;
			if (remaining <= 0) {
				this.reservedPaths.delete(path);
				if (!this.isDisposed()) {
					this.flushDeferredSaves(path);
				} else {
					this.deferredSaves.delete(path);
				}
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
	 * Runs `task` only while the captured epoch is still live and the manager is
	 * not disposed; declines (never invokes `task`) once a shred has bumped the
	 * epoch or the manager has begun retirement. Registers the write under a
	 * non-rejecting shadow so `hardKillAll` awaits it; rejections still propagate
	 * to the caller unchanged.
	 */
	runReservedWrite(startEpoch: number, task: () => Promise<void>): Promise<boolean> {
		if (this.isDisposed() || startEpoch !== this.killEpoch) {
			return Promise.resolve(false);
		}
		const write = task();
		const shadow = write.then(
			() => undefined,
			() => undefined,
		);
		this.reservationWrites.add(shadow);
		void shadow.then(() => {
			this.reservationWrites.delete(shadow);
		});
		return write.then(() => true);
	}

	/**
	 * Enqueues a file write through the shared `ViewLifecycleCoordinator` while
	 * maintaining `session.writePromise` / `reservationWrites` shadow accounting.
	 */
	enqueueCoordinatedWrite<T = void>(
		file: TFile,
		task: () => Promise<T>,
		options?: {
			readonly session?: ViewSession;
			readonly epoch?: number;
			readonly kind?: WriteJobKind;
			readonly onCommitted?: (value: T) => void | Promise<void>;
			readonly dispositionOnCommit?: CommittedDisposition;
			readonly commandId?: symbol;
		},
	): Promise<WriteAdmissionResult<T>> {
		const kind: WriteJobKind = options?.kind ?? "normal";
		if (kind === "normal" && this.isDisposed()) {
			return Promise.resolve({ status: "declined" });
		}
		if (options?.epoch !== undefined && options.epoch !== this.killEpoch) {
			return Promise.resolve({ status: "declined" });
		}
		const capturedEpoch = options?.epoch ?? this.killEpoch;
		const promise = this.coordinator.enqueueFileWrite<T>(this.app, {
			file,
			owner: this.owner,
			epoch: this.owner.killEpoch,
			kind,
			task: async () => {
				if (kind === "normal" && (this.isDisposed() || capturedEpoch !== this.killEpoch)) {
					throw new DeclinedByManagerError();
				}
				return task();
			},
			...(options?.onCommitted ? { onCommitted: options.onCommitted } : {}),
			...(options?.dispositionOnCommit
				? { dispositionOnCommit: options.dispositionOnCommit }
				: {}),
			...(options?.commandId ? { commandId: options.commandId } : {}),
		}).catch((err: unknown) => {
			if (err instanceof DeclinedByManagerError) {
				return { status: "declined" as const };
			}
			throw err;
		});

		const shadow = promise.then(
			() => undefined,
			() => undefined,
		);
		this.reservationWrites.add(shadow);
		void shadow.finally(() => {
			this.reservationWrites.delete(shadow);
		});
		if (options?.session) {
			const session = options.session;
			session.writePromise = shadow;
			void shadow.finally(() => {
				if (session.writePromise === shadow) {
					session.writePromise = null;
				}
			});
		}
		return promise;
	}

	/** Remembers the last-known clean decoy for `path` (shred rewrite fallback). */
	rememberDecoy(path: string, decoy: string): void {
		if (this.isDisposed()) return;
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
		if (this.isDisposed()) return;
		const capturedEpoch = this.killEpoch;
		let set = this.deferredSaves.get(path);
		if (!set) {
			set = new Set<() => void>();
			this.deferredSaves.set(path, set);
		}
		const guardedRun = (): void => {
			if (this.isDisposed() || this.killEpoch !== capturedEpoch) return;
			run();
		};
		set.add(guardedRun);
	}

	private flushDeferredSaves(path: string): void {
		const set = this.deferredSaves.get(path);
		if (!set) return;
		this.deferredSaves.delete(path);
		if (this.isDisposed()) return;
		for (const run of set) {
			if (this.isDisposed()) break;
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
		return !this.isDisposed() && this.byView.get(session.view) === session;
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
		if (this.isDisposed()) return false;
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
		if (this.isDisposed()) {
			const inertSession: ViewSession = {
				view,
				file,
				state: "locked",
				lockingPromise: null,
				killGeneration: 1,
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
			inertSession.capture.cancel();
			return inertSession;
		}
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
					this.releaseOwnedDek(existing.dek);
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
		if (existingSet) {
			for (const session of existingSet) {
				this.coordinator.notifyFileRenamed(this.app, session.file, oldPath, newPath);
			}
			this.byPath.delete(oldPath);
			const targetSet = this.byPath.get(newPath);
			if (targetSet) {
				for (const session of existingSet) targetSet.add(session);
			} else {
				this.byPath.set(newPath, existingSet);
			}
		}
		const movedDecoy = this.lastKnownDecoy.get(oldPath);
		if (movedDecoy !== undefined) {
			this.lastKnownDecoy.delete(oldPath);
			this.lastKnownDecoy.set(newPath, movedDecoy);
		}
	}

	pruneDetached(activeViews: Set<MarkdownView>): void {
		if (this.isDisposed()) return;
		for (const session of this.all()) {
			if (!activeViews.has(session.view)) this.detach(session.view);
		}
	}

	detach(view: MarkdownView): void {
		const session = this.byView.get(view);
		if (!session) return;
		if (!this.isDisposed()) {
			void this.lock(session, "detach").catch((error) => {
				console.warn("Veneer: lock on detach failed", error);
			});
		}
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
		this.releaseOwnedDek(session.dek);
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
		if (this.isDisposed() || session.state !== "unlocked") return;
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
				if (!retained.has(url)) {
					try {
						URL.revokeObjectURL(url);
					} catch {
						// Isolate URL revocation failure
					}
				}
			}
		}
		session.imageUrls.clear();
		for (const [key, url] of next) {
			session.imageUrls.set(key, url);
		}
	}

	private revokeImageUrls(session: ViewSession): void {
		this.revokeImageUrlsIsolated(session);
	}

	private revokeImageUrlsIsolated(session: ViewSession, errors?: unknown[]): string[] {
		const revoked: string[] = [];
		if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
			const uniqueUrls = new Set(session.imageUrls.values());
			for (const url of uniqueUrls) {
				try {
					URL.revokeObjectURL(url);
					revoked.push(url);
				} catch (error) {
					revoked.push(url);
					errors?.push(error);
				}
			}
		}
		session.imageUrls.clear();
		return revoked;
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
		dekOverride?: Uint8Array<ArrayBuffer>,
	): Promise<{
		staged: StagedVaultImages;
		mergedImages: PayloadV1["images"];
	} | null> {
		const startGeneration = session.killGeneration;
		const startEpoch = this.killEpoch;
		const activeDek = dekOverride ?? session.dek;
		if (
			this.isDisposed() ||
			session.state !== "unlocked" ||
			!activeDek ||
			activeDek.every((b) => b === 0)
		) {
			return null;
		}
		if (!text.includes("!")) {
			return {
				staged: { absorbed: {}, filesToDelete: [] },
				mergedImages: session.originalPayload.images,
			};
		}
		const staged = await readLinkedVaultImages(this.app, session.file.path, text);
		const postReadDek = dekOverride ?? session.dek;
		if (
			this.isDisposed() ||
			this.killEpoch !== startEpoch ||
			session.killGeneration !== startGeneration ||
			session.state !== "unlocked" ||
			!postReadDek ||
			postReadDek.every((b) => b === 0)
		) {
			return null;
		}
		if (Object.keys(staged.absorbed).length === 0) {
			return {
				staged,
				mergedImages: session.originalPayload.images,
			};
		}
		const encryptedNew = await encryptImageMap(
			postReadDek,
			session.originalPayload.note_id,
			staged.absorbed,
		);
		const postEncryptDek = dekOverride ?? session.dek;
		if (
			this.isDisposed() ||
			this.killEpoch !== startEpoch ||
			session.killGeneration !== startGeneration ||
			session.state !== "unlocked" ||
			!postEncryptDek ||
			postEncryptDek.every((b) => b === 0)
		) {
			return null;
		}
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
		if (
			this.isDisposed() ||
			!this.isAttached(session) ||
			session.state !== "unlocked" ||
			Object.keys(staged.absorbed).length === 0
		) {
			return;
		}
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
		const startGeneration = session.killGeneration;
		const startEpoch = this.killEpoch;
		if (
			this.isDisposed() ||
			!this.isAttached(session) ||
			session.state !== "unlocked" ||
			!session.dek
		) {
			return;
		}
		const text = session.view.editor.getValue();
		const result = await this.stageEditorImages(session, text);
		if (
			!result ||
			Object.keys(result.staged.absorbed).length === 0 ||
			this.isDisposed() ||
			this.killEpoch !== startEpoch ||
			session.killGeneration !== startGeneration ||
			!this.isAttached(session) ||
			session.state !== "unlocked" ||
			!session.dek
		) {
			return;
		}
		const nextPayload = await reencryptRealText(
			session.originalPayload,
			session.dek,
			text,
			result.mergedImages,
			this.readEditedInlineTitle(session),
		);
		if (
			this.isDisposed() ||
			this.killEpoch !== startEpoch ||
			session.killGeneration !== startGeneration ||
			!this.isAttached(session) ||
			session.state !== "unlocked" ||
			!session.dek ||
			this.isPathReserved(session.file.path)
		) {
			return;
		}
		let writeCommitted = false;
		await this.enqueueWrite(session, async () => {
			if (
				this.isDisposed() ||
				this.killEpoch !== startEpoch ||
				session.killGeneration !== startGeneration ||
				this.isPathReserved(session.file.path)
			) {
				return;
			}
			await this.app.vault.modify(
				session.file,
				serializeFile(session.decoyBody, nextPayload),
			);
			writeCommitted = true;
		});
		if (
			!writeCommitted ||
			this.isDisposed() ||
			this.killEpoch !== startEpoch ||
			session.killGeneration !== startGeneration ||
			session.state !== "unlocked" ||
			!session.dek
		) {
			return;
		}
		session.originalPayload = nextPayload;
		session.pendingPayload = nextPayload;
		this.refreshPreviewImageUrls(session, result.staged);
		if (this.isDisposed() || this.killEpoch !== startEpoch || session.killGeneration !== startGeneration) {
			return;
		}
		await deleteStagedVaultImages(
			this.app,
			this.persistedStagedFiles(result.staged.filesToDelete, nextPayload.images),
		);
	}

	async unlock(session: ViewSession, password: string): Promise<UnlockOutcome> {
		const startGeneration = session.killGeneration;
		const startEpoch = this.killEpoch;
		if (this.isDisposed() || !this.isAttached(session) || this.reservedPaths.has(session.file.path)) {
			return "blocked";
		}
		if (session.lockingPromise !== null) {
			try {
				await session.lockingPromise;
			} catch (error) {
				console.warn("Veneer: prior lock failed before unlock", error);
			}
		}
		if (
			this.isDisposed() ||
			this.killEpoch !== startEpoch ||
			session.killGeneration !== startGeneration ||
			!this.isAttached(session) ||
			this.isPathReserved(session.file.path)
		) {
			return "blocked";
		}
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
			// Register immediately on continuation so any concurrent retirement/duress knows about it
			const releaseDerivedDek = this.registerOwnedDek(dek);
			// A concurrent unlock() may have won while we awaited derivation, or a mask
			// may have started. Either way this derivation lost; zero only our freshly
			// derived key so we never touch the winner's live key material.
			const stateAfterDerivation = this.stateOf(session);
			if (stateAfterDerivation === "unlocked" || session.lockingPromise !== null) {
				releaseDerivedDek();
				return stateAfterDerivation === "unlocked" && !this.isDisposed() ? "ok" : "blocked";
			}
			if (
				this.isDisposed() ||
				this.killEpoch !== startEpoch ||
				session.killGeneration !== startGeneration ||
				!this.isAttached(session) ||
				session.view.file !== session.file ||
				this.isPathReserved(session.file.path)
			) {
				releaseDerivedDek();
				return "blocked";
			}
			session.backoff.recordSuccess();
			if (session.dek && session.dek !== dek) {
				this.releaseOwnedDek(session.dek);
			}
			session.dek = dek;
			session.state = "unlocked";
			session.realTitle = realTitle ?? session.file.basename;
			session.pendingPayload = session.originalPayload;
			this.revokeImageUrls(session);
			this.populateImageUrls(session, images);
			session.view.setViewData(realText, true);
			this.applyDisplayedTitle(session, session.realTitle);
			const unlockedGeneration = session.killGeneration;
			const unlockedEpoch = this.killEpoch;
			queueMicrotask(() => {
				if (
					!this.isDisposed() &&
					this.killEpoch === unlockedEpoch &&
					session.killGeneration === unlockedGeneration &&
					this.isAttached(session) &&
					session.view.file === session.file &&
					session.state === "unlocked" &&
					session.lockingPromise === null
				) {
					this.applyDisplayedTitle(session, session.realTitle ?? session.file.basename);
				}
			});
			this.hooks.onUnlocked(session);
			return "ok";
		} catch {
			if (
				this.isDisposed() ||
				this.killEpoch !== startEpoch ||
				session.killGeneration !== startGeneration
			) {
				return "blocked";
			}
			session.backoff.recordFailure(now);
			return "wrong";
		}
	}

	/**
	 * Coalesces concurrent mask triggers, snapshots the DEK and editor state,
	 * re-encrypts the latest plaintext to disk, zeroes key material, and restores the decoy cover.
	 */
	lock(session: ViewSession, reason: string): Promise<void> {
		if (this.isDisposed() || this.reservedPaths.has(session.file.path)) {
			return Promise.resolve();
		}
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
		const releaseLocalDek = this.registerOwnedDek(dek);
		const startGeneration = session.killGeneration;
		const startEpoch = this.killEpoch;
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
					!this.isDisposed() &&
					this.killEpoch === startEpoch &&
					session.lockingPromise === lockingPromise &&
					session.killGeneration === startGeneration
				) {
					const imageStage = await this.stageEditorImages(session, currentText, dek);
					const mergedImages = imageStage?.mergedImages ?? session.originalPayload.images;
					if (
						this.isDisposed() ||
						this.killEpoch !== startEpoch ||
						session.lockingPromise !== lockingPromise ||
						session.killGeneration !== startGeneration
					) {
						return;
					}
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
					if (
						this.isDisposed() ||
						this.killEpoch !== startEpoch ||
						session.lockingPromise !== lockingPromise ||
						session.killGeneration !== startGeneration
					) {
						return;
					}
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
								this.isDisposed() ||
								this.killEpoch !== startEpoch ||
								session.lockingPromise !== lockingPromise ||
								session.killGeneration !== startGeneration
							) {
								return;
							}
						}
					}
					session.pendingPayload = lockedPayload;
					if (this.isDisposed() || this.isPathReserved(session.file.path)) return;
					let writeCommitted = false;
					await this.enqueueWrite(session, async () => {
						if (
							this.isDisposed() ||
							this.killEpoch !== startEpoch ||
							session.lockingPromise !== lockingPromise ||
							session.killGeneration !== startGeneration ||
							this.isPathReserved(session.file.path)
						) {
							return;
						}
						await this.app.vault.modify(
							session.file,
							serializeFile(session.decoyBody, lockedPayload),
						);
						writeCommitted = true;
					});
					if (
						!writeCommitted ||
						this.isDisposed() ||
						this.killEpoch !== startEpoch ||
						session.lockingPromise !== lockingPromise ||
						session.killGeneration !== startGeneration
					) {
						return;
					}
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
				releaseLocalDek();
				const ownedOnExit =
					!this.isDisposed() &&
					session.lockingPromise === lockingPromise &&
					session.killGeneration === startGeneration;
				if (ownedOnExit) {
					this.releaseOwnedDek(session.dek);
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
		if (this.isDisposed()) return;
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
		this.owner.killEpoch = this.killEpoch;
		const inflight: Promise<void>[] = [...this.reservationWrites];
		const allSessions = new Set([...this.all(), ...this.pendingLocks]);
		this.wipeAllOwnedDeks(allSessions);
		for (const session of allSessions) {
			if (session.lockingPromise !== null) {
				inflight.push(session.lockingPromise);
			}
			if (session.writePromise !== null) {
				inflight.push(session.writePromise);
			}
			session.killGeneration += 1;
			this.releaseOwnedDek(session.dek);
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
			if (this.byView.get(session.view) === session && session.view.file === session.file) {
				session.view.setViewData(session.decoyBody, true);
				this.applyDisplayedTitle(session, session.file.basename);
			}
			session.realTitle = null;
			if (this.byView.get(session.view) === session) {
				this.byView.delete(session.view);
			}
			this.removeFromPath(session.file.path, session);
			this.pendingLocks.delete(session);
			try {
				this.hooks.onLocked(session);
			} catch {
				// Isolate hook error during emergency duress kill
			}
		}
		this.deferredSaves.clear();
		return Promise.allSettled(inflight).then(() => undefined);
	}

	/** Debounced ciphertext refresh so the synchronous save path never sees plaintext. */
	scheduleReencrypt(session: ViewSession): void {
		if (
			this.isDisposed() ||
			!this.isAttached(session) ||
			session.state !== "unlocked" ||
			!session.dek ||
			session.lockingPromise !== null
		) {
			return;
		}
		const seq = ++session.reencryptSeq;
		const startGeneration = session.killGeneration;
		const startEpoch = this.killEpoch;
		if (session.reencryptTimer !== null) clearTimeout(session.reencryptTimer);
		session.reencryptTimer = setTimeout(() => {
			session.reencryptTimer = null;
			if (
				this.isDisposed() ||
				this.killEpoch !== startEpoch ||
				session.killGeneration !== startGeneration ||
				!this.isAttached(session) ||
				session.state !== "unlocked" ||
				!session.dek ||
				session.lockingPromise !== null ||
				session.reencryptSeq !== seq
			) {
				return;
			}
			const prev = session.reencryptPromise ?? Promise.resolve();
			const next = prev
				.catch(() => undefined)
				.then(async () => {
					if (
						this.isDisposed() ||
						this.killEpoch !== startEpoch ||
						session.killGeneration !== startGeneration ||
						!this.isAttached(session) ||
						session.view.file !== session.file ||
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
							this.isDisposed() ||
							this.killEpoch !== startEpoch ||
							session.killGeneration !== startGeneration ||
							!this.isAttached(session) ||
							session.view.file !== session.file ||
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
							snapshotTitle ?? undefined,
						);
						if (
							this.isDisposed() ||
							this.killEpoch !== startEpoch ||
							session.killGeneration !== startGeneration ||
							!this.isAttached(session) ||
							session.view.file !== session.file ||
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
						if (
							!this.isDisposed() &&
							this.killEpoch === startEpoch &&
							session.killGeneration === startGeneration &&
							this.isAttached(session) &&
							session.view.file === session.file &&
							session.state === "unlocked" &&
							session.lockingPromise === null &&
							session.reencryptSeq === seq
						) {
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

	/**
	 * Serializes disk writes (`MarkdownView.save` and `lock`'s `vault.modify`)
	 * for a single session so an in-flight save cannot land after `lock()` and
	 * overwrite newer ciphertext, and a new save cannot start until `lock()`'s
	 * write completes.
	 */
	enqueueWrite<T>(session: ViewSession, task: () => Promise<T>): Promise<T> {
		if (this.isDisposed()) {
			return Promise.resolve(undefined as unknown as T);
		}
		const startEpoch = this.killEpoch;
		const prev = session.writePromise;
		const run =
			prev === null
				? task()
				: prev.catch(() => undefined).then(async () => {
						if (this.isDisposed() || this.killEpoch !== startEpoch) {
							return undefined as unknown as T;
						}
						return task();
					});
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
		const startGeneration = session.killGeneration;
		const startEpoch = this.killEpoch;
		if (
			this.isDisposed() ||
			this.killEpoch !== startEpoch ||
			session.killGeneration !== startGeneration ||
			!this.isAttached(session) ||
			session.state !== "unlocked" ||
			session.lockingPromise !== null
		) {
			return;
		}
		session.originalPayload = persisted;
		const staged = session.stagedFilesByPayload.get(persisted);
		if (!staged) return;
		session.stagedFilesByPayload.delete(persisted);
		if (
			this.isDisposed() ||
			this.killEpoch !== startEpoch ||
			session.killGeneration !== startGeneration ||
			!this.isAttached(session)
		) {
			return;
		}
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

class DeclinedByManagerError extends Error {
	constructor() {
		super("Declined by retired or epoch-fenced SessionManager");
	}
}
