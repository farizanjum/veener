import type { App, MarkdownView, TFile } from "obsidian";
import {
	encryptImageMap,
	parseFileContent,
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
	type KeylessRetirementSpec,
	type OwnerPhase,
	type OwnerToken,
	type PendingCommandKind,
	type PendingCommandRecord,
	type ViewLifecycleCoordinator,
	type WriteAdmissionResult,
	type WriteJobKind,
} from "./lifecycle";
import { computeSavedContent } from "./saveDecision";

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
	reencryptTimer: ReturnType<typeof window.setTimeout> | number | null;
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
	onAttached?(file: TFile, payload: PayloadV1): void;
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

export type NativeViewDataSetter =
	| ((this: MarkdownView, data: string, clear: boolean) => void)
	| ((view: MarkdownView, data: string, clear: boolean) => void);

export type ViewHydrationStatus =
	| "hydrated"
	| "fallback-hydrated"
	| "save-blocked"
	| "skipped-switched-file";

export interface ViewHydrationOutcome {
	readonly view: MarkdownView;
	readonly file: TFile;
	readonly path: string;
	readonly status: ViewHydrationStatus;
	readonly error?: unknown;
}

export interface ShutdownHandoffFailure {
	readonly file: TFile;
	readonly path: string;
	readonly view?: MarkdownView;
	readonly reason: unknown;
	readonly saveBlocked: boolean;
}

export interface ShutdownHandoffResult {
	readonly preparation: SessionRetirementPreparation;
	readonly capturedNativeSetViewData: NativeViewDataSetter | null;
	readonly snapshotsByFile: ReadonlyMap<TFile, FrozenSafeSnapshot>;
	readonly dispositionsByFile: ReadonlyMap<TFile, CommittedDisposition>;
	readonly pendingCommandsByFile: ReadonlyMap<TFile, readonly PendingCommandRecord[]>;
	readonly retirementSpecs: readonly KeylessRetirementSpec[];
	readonly viewOutcomes: readonly ViewHydrationOutcome[];
	readonly saveBlockedViews: readonly MarkdownView[];
	readonly hasSaveBlockedViews: boolean;
	readonly failures: readonly ShutdownHandoffFailure[];
	readonly errors: readonly unknown[];
}

export type CommandCommitOutcome =
	| {
			readonly kind: "password" | "refresh" | "protect";
			readonly payload: PayloadV1;
			readonly decoyBody: string;
			readonly revision?: number;
	  }
	| {
			readonly kind: "unprotect";
			readonly plaintextContent: string;
			readonly revision?: number;
	  };

interface FileSnapshotAuthority {
	readonly file: TFile;
	acceptedPayload: PayloadV1;
	acceptedPayloadRevision: number;
	acceptedDecoyBody: string;
	acceptedCoverRevision: number;
	stagedCommand: {
		payload?: PayloadV1;
		decoyBody?: string;
	} | null;
}

interface SessionInternalMeta {
	readonly attachSeq: number;
	loadedDecoyBody: string;
	decoyBody: string;
	originalPayload: PayloadV1;
	pendingPayload: PayloadV1 | null;
	observedCoverText: string | null;
	observedCoverRevision: number;
	internalMutationDepth: number;
}

export const REENCRYPT_DEBOUNCE_MS = 600;

export class SessionManager {
	private readonly byView = new WeakMap<MarkdownView, ViewSession>();
	private readonly byPath = new Map<string, Set<ViewSession>>();
	private readonly reservedPaths = new Map<string, number>();
	private readonly pendingLocks = new Set<ViewSession>();
	private readonly lockTextObservers = new WeakMap<ViewSession, Set<(text: string) => void>>();
	private readonly activeLockSnapshots = new WeakMap<ViewSession, string[]>();
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
	private handoffResult: ShutdownHandoffResult | null = null;
	private capturedNativeSetViewData: NativeViewDataSetter | null = null;
	private isHydratingView = false;

	private readonly fileAuthorities = new Map<TFile, FileSnapshotAuthority>();
	private readonly dirtySessionSnapshots = new Set<TFile>();
	private readonly sessionMeta = new WeakMap<ViewSession, SessionInternalMeta>();
	private readonly payloadRevisions = new WeakMap<PayloadV1, number>();
	private readonly payloadFingerprintRevisions = new Map<string, number>();
	private readonly uncommittedStagedPayloads = new WeakSet<PayloadV1>();
	private readonly frozenSnapshotsByFile = new Map<TFile, FrozenSafeSnapshot>();
	private readonly capturedDispositionsByFile = new Map<TFile, CommittedDisposition>();
	private readonly capturedPendingCommandsByFile = new Map<TFile, readonly PendingCommandRecord[]>();
	private readonly trackedCommandIdsByFile = new Map<TFile, Set<symbol>>();
	private attachSequenceCounter = 0;

	/**
	 * Every live DEK `Uint8Array` owned by this manager (session keys, `lock()`'s
	 * local copy, and command-derived keys registered via `registerOwnedDek`).
	 * Wiped synchronously on retirement or `hardKillAll`, and in each owner's `finally`.
	 */
	private readonly ownedDeks = new Set<Uint8Array>();

	/** Creates a `SessionManager` bound to `app` and registered with the shared `ViewLifecycleCoordinator`. */
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

	/** Returns the Obsidian `App` instance associated with this manager. */
	getApp(): App {
		return this.app;
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

	/** Returns the captured retirement preparation record once `prepareRetirement` has run. */
	getRetirementPreparation(): SessionRetirementPreparation | null {
		return this.retirementPreparation;
	}

	/** Records the original native `MarkdownView.prototype.setViewData` implementation. */
	setCapturedNativeSetViewData(setter: NativeViewDataSetter): void {
		this.capturedNativeSetViewData = setter;
	}

	/** Returns the captured native `setViewData` implementation, if one was recorded. */
	getCapturedNativeSetViewData(): NativeViewDataSetter | null {
		return this.capturedNativeSetViewData;
	}

	/** Returns the frozen safe snapshot for `file` from this manager or the shared coordinator. */
	getFrozenSnapshot(file: TFile): FrozenSafeSnapshot | null {
		return this.frozenSnapshotsByFile.get(file) ?? this.coordinator.getFrozenSnapshot(this.app, file);
	}

	/** Returns all frozen safe snapshots captured by this manager during retirement. */
	getFrozenSnapshots(): ReadonlyMap<TFile, FrozenSafeSnapshot> {
		return this.frozenSnapshotsByFile;
	}

	/** Returns the latest committed disposition for `file` from the coordinator or local cache. */
	getCommittedDisposition(file: TFile): CommittedDisposition | null {
		return (
			this.coordinator.getCommittedDisposition(this.app, file) ??
			this.capturedDispositionsByFile.get(file) ??
			null
		);
	}

	/**
	 * Clears cached per-file snapshot authority, frozen snapshot, and committed disposition
	 * once an explicit unprotect transition completes for `file`.
	 */
	clearFileAuthority(file: TFile): void {
		this.fileAuthorities.delete(file);
		this.frozenSnapshotsByFile.delete(file);
		this.capturedDispositionsByFile.delete(file);
		this.coordinator.clearCommittedDisposition(this.app, file);
	}

	/** Returns all committed dispositions captured by this manager. */
	getCapturedDispositions(): ReadonlyMap<TFile, CommittedDisposition> {
		return this.capturedDispositionsByFile;
	}

	/** Returns all pending command records captured per file at retirement. */
	getCapturedPendingCommands(): ReadonlyMap<TFile, readonly PendingCommandRecord[]> {
		return this.capturedPendingCommandsByFile;
	}

	/** Returns the cached `ShutdownHandoffResult` if `shutdownAndHandoff` has already executed. */
	getShutdownHandoffResult(): ShutdownHandoffResult | null {
		return this.handoffResult;
	}

	/** Registers the start of a mutating file command with the lifecycle coordinator. */
	beginCommand(file: TFile, kind: PendingCommandKind): symbol | null {
		const cmdId = this.coordinator.beginCommand(this.app, this.owner, file, kind);
		if (cmdId !== null) {
			let set = this.trackedCommandIdsByFile.get(file);
			if (!set) {
				set = new Set<symbol>();
				this.trackedCommandIdsByFile.set(file, set);
			}
			set.add(cmdId);
		}
		return cmdId;
	}

	/** Looks up the coordinator's tracking record for an in-flight command. */
	getCommandRecord(file: TFile, commandId: symbol): Readonly<PendingCommandRecord> | null {
		return this.coordinator.getCommandRecord(this.app, file, commandId);
	}

	/** Marks a tracked file command as finished in both local and coordinator state. */
	finishCommand(file: TFile, commandId: symbol): void {
		this.trackedCommandIdsByFile.get(file)?.delete(commandId);
		this.coordinator.finishCommand(this.app, file, commandId);
	}

	/** Computes a deterministic fingerprint for `payload` scoped to `file.path`. */
	private payloadFingerprint(file: TFile, payload: PayloadV1): string {
		return `${file.path}::${payload.note_id}::${payload.cipher.nonce}::${payload.cipher.ct.slice(0, 64)}`;
	}

	/** Associates `payload` (and its ciphertext fingerprint) with a monotonic revision number. */
	private recordPayloadRevision(file: TFile, payload: PayloadV1, revision: number): void {
		const existing = this.payloadRevisions.get(payload);
		const nextRev = existing !== undefined && existing > revision ? existing : revision;
		this.payloadRevisions.set(payload, nextRev);
		const fp = this.payloadFingerprint(file, payload);
		const existingFp = this.payloadFingerprintRevisions.get(fp);
		if (existingFp === undefined || nextRev > existingFp) {
			this.payloadFingerprintRevisions.set(fp, nextRev);
		}
	}

	/** Returns the recorded monotonic revision number for `payload`, or `0` if unknown. */
	getPayloadRevision(file: TFile, payload: PayloadV1): number {
		const direct = this.payloadRevisions.get(payload);
		if (direct !== undefined) return direct;
		const byFp = this.payloadFingerprintRevisions.get(this.payloadFingerprint(file, payload));
		if (byFp !== undefined) {
			this.payloadRevisions.set(payload, byFp);
			return byFp;
		}
		return 0;
	}

	/**
	 * Returns or initializes the per-file snapshot authority, reconciling `initialPayload`
	 * and `initialDecoyBody` against any newer coordinator disposition or frozen snapshot.
	 */
	private getOrCreateFileAuthority(
		file: TFile,
		initialPayload: PayloadV1,
		initialDecoyBody: string,
	): FileSnapshotAuthority {
		let authority = this.fileAuthorities.get(file);
		if (authority) {
			return authority;
		}

		const settledDisposition = this.coordinator.getCommittedDisposition(this.app, file);
		const settledSnapshot = this.coordinator.getFrozenSnapshot(this.app, file);
		let chosenPayload = initialPayload;
		let chosenDecoy = initialDecoyBody;
		let chosenPayloadRevision = this.getPayloadRevision(file, initialPayload);
		let chosenCoverRevision = 0;

		if (
			settledDisposition?.kind === "protected" &&
			settledDisposition.payload &&
			settledDisposition.payload.note_id === initialPayload.note_id
		) {
			const sameCiphertext =
				settledDisposition.payload.cipher.nonce === initialPayload.cipher.nonce &&
				settledDisposition.payload.cipher.ct === initialPayload.cipher.ct;
			if (sameCiphertext) {
				chosenPayload = initialPayload;
				chosenPayloadRevision = settledDisposition.revision;
				chosenDecoy = initialDecoyBody;
				if (
					settledDisposition.decoyBody !== undefined &&
					initialDecoyBody !== settledDisposition.decoyBody
				) {
					chosenCoverRevision = this.coordinator.nextFileRevision(this.app, file);
				}
			} else if (chosenPayloadRevision === 0 || chosenPayloadRevision <= settledDisposition.revision) {
				chosenPayload = settledDisposition.payload;
				chosenPayloadRevision = settledDisposition.revision;
				if (settledDisposition.decoyBody !== undefined) {
					chosenDecoy = settledDisposition.decoyBody;
				}
			}
		}

		if (
			settledSnapshot !== null &&
			settledSnapshot.payload.note_id === initialPayload.note_id
		) {
			const sameCiphertext =
				settledSnapshot.payload.cipher.nonce === chosenPayload.cipher.nonce &&
				settledSnapshot.payload.cipher.ct === chosenPayload.cipher.ct;
			if (sameCiphertext) {
				if (settledSnapshot.revision > chosenPayloadRevision) {
					chosenPayloadRevision = settledSnapshot.revision;
				}
				if (
					settledSnapshot.decoyBody !== chosenDecoy &&
					settledSnapshot.revision >= chosenCoverRevision
				) {
					chosenDecoy = settledSnapshot.decoyBody;
					chosenCoverRevision = settledSnapshot.revision;
				}
			} else if (chosenPayloadRevision === 0 || chosenPayloadRevision <= settledSnapshot.revision) {
				chosenPayload = settledSnapshot.payload;
				chosenPayloadRevision = settledSnapshot.revision;
				chosenDecoy = settledSnapshot.decoyBody;
				if (settledSnapshot.revision > chosenCoverRevision) {
					chosenCoverRevision = settledSnapshot.revision;
				}
			}
		}

		if (chosenPayloadRevision === 0) {
			chosenPayloadRevision = this.coordinator.nextFileRevision(this.app, file);
		}
		this.recordPayloadRevision(file, chosenPayload, chosenPayloadRevision);
		if (chosenPayload !== initialPayload && this.getPayloadRevision(file, initialPayload) === 0) {
			this.recordPayloadRevision(file, initialPayload, 1);
		}

		authority = {
			file,
			acceptedPayload: chosenPayload,
			acceptedPayloadRevision: chosenPayloadRevision,
			acceptedDecoyBody: chosenDecoy,
			acceptedCoverRevision: chosenCoverRevision,
			stagedCommand: null,
		};
		this.fileAuthorities.set(file, authority);
		return authority;
	}

	/** Runs `fn` while suppressing property-setter staging side effects on `session`. */
	private runInternalSessionMutation(session: ViewSession, fn: () => void): void {
		const meta = this.sessionMeta.get(session);
		if (!meta) {
			fn();
			return;
		}
		meta.internalMutationDepth += 1;
		try {
			fn();
		} finally {
			meta.internalMutationDepth -= 1;
		}
	}

	/**
	 * Records a locked-session decoy cover edit into the per-file authority and assigns
	 * it a monotonic revision so retirement and save paths preserve the newest cover.
	 */
	observeCoverEdit(session: ViewSession, explicitCover?: string): number {
		if (
			this.isDisposed() ||
			this.isHydratingView ||
			session.state !== "locked" ||
			session.lockingPromise !== null ||
			session.view.file !== session.file
		) {
			return 0;
		}
		const meta = this.sessionMeta.get(session);
		const rawSource =
			explicitCover !== undefined
				? explicitCover
				: session.view.editor && typeof session.view.editor.getValue === "function"
					? session.view.editor.getValue()
					: session.decoyBody;
		const parsed = parseFileContent(rawSource);
		const cleanCover = parsed ? parsed.decoyBody : rawSource;
		const authority = this.getOrCreateFileAuthority(
			session.file,
			session.originalPayload,
			session.decoyBody,
		);

		const baselineCover = meta?.loadedDecoyBody ?? authority.acceptedDecoyBody;
		if (
			cleanCover === baselineCover &&
			cleanCover === authority.acceptedDecoyBody &&
			explicitCover === undefined
		) {
			return meta?.observedCoverRevision ?? 0;
		}

		if (
			meta &&
			meta.observedCoverText === cleanCover &&
			meta.observedCoverRevision > 0 &&
			explicitCover === undefined
		) {
			return meta.observedCoverRevision;
		}

		const rev = this.coordinator.nextFileRevision(this.app, session.file);
		if (meta) {
			meta.observedCoverText = cleanCover;
			meta.observedCoverRevision = rev;
			meta.decoyBody = cleanCover;
		}
		if (rev >= authority.acceptedCoverRevision) {
			authority.acceptedDecoyBody = cleanCover;
			authority.acceptedCoverRevision = rev;
		}
		this.dirtySessionSnapshots.add(session.file);
		this.rememberDecoy(session.file.path, cleanCover);
		return rev;
	}

	/**
	 * Accepts a newly re-encrypted payload into the session and per-file authority
	 * if its revision is at least as new as the currently accepted payload revision.
	 */
	private acceptReencryptedPayload(
		session: ViewSession,
		payload: PayloadV1,
		candidateRevision: number,
		nextRealTitle?: string | null,
	): boolean {
		if (this.isDisposed()) return false;
		const authority = this.getOrCreateFileAuthority(
			session.file,
			session.originalPayload,
			session.decoyBody,
		);
		this.recordPayloadRevision(session.file, payload, candidateRevision);
		if (candidateRevision < authority.acceptedPayloadRevision) {
			return false;
		}
		this.uncommittedStagedPayloads.delete(payload);
		authority.acceptedPayload = payload;
		authority.acceptedPayloadRevision = candidateRevision;
		this.dirtySessionSnapshots.add(session.file);
		this.runInternalSessionMutation(session, () => {
			if (nextRealTitle !== undefined) {
				session.realTitle = nextRealTitle;
			}
			session.pendingPayload = payload;
		});
		return true;
	}

	/**
	 * Marks `payload` as committed on disk for `session` and publishes the resulting
	 * `"protected"` disposition to the shared lifecycle coordinator.
	 */
	private commitSessionPayload(
		session: ViewSession,
		payload: PayloadV1,
		candidateRevision?: number,
	): number {
		const authority = this.getOrCreateFileAuthority(
			session.file,
			session.originalPayload,
			session.decoyBody,
		);
		const existingRev = this.getPayloadRevision(session.file, payload);
		const rev =
			candidateRevision ??
			(existingRev > 0 ? existingRev : this.coordinator.nextFileRevision(this.app, session.file));
		this.recordPayloadRevision(session.file, payload, rev);
		this.uncommittedStagedPayloads.delete(payload);
		if (rev >= authority.acceptedPayloadRevision) {
			authority.acceptedPayload = payload;
			authority.acceptedPayloadRevision = rev;
			this.dirtySessionSnapshots.delete(session.file);
		}
		this.runInternalSessionMutation(session, () => {
			session.originalPayload = payload;
		});
		const rawSerialized = computeSavedContent({
			unlocked: true,
			editorValue: "",
			decoyBody: authority.acceptedDecoyBody,
			originalPayload: authority.acceptedPayload,
			pendingPayload: authority.acceptedPayload,
		});
		this.coordinator.publishCommittedDisposition(this.app, session.file, {
			kind: "protected",
			revision: authority.acceptedPayloadRevision,
			decoyBody: authority.acceptedDecoyBody,
			payload: authority.acceptedPayload,
			rawSerialized,
		});
		return rev;
	}

	/**
	 * Publishes the committed outcome of a file command (`protect`, `refresh`, `password`,
	 * or `unprotect`) to the shared lifecycle coordinator and updates local authority state.
	 */
	publishCommandCommit(file: TFile, outcome: CommandCommitOutcome): CommittedDisposition | null {
		if (outcome.kind === "unprotect") {
			const rev = outcome.revision ?? this.coordinator.nextFileRevision(this.app, file);
			const disposition: CommittedDisposition = {
				kind: "unprotected",
				revision: rev,
				plaintextContent: outcome.plaintextContent,
			};
			const published = this.coordinator.publishCommittedDisposition(
				this.app,
				file,
				disposition,
			);
			if (!published) return null;
			this.capturedDispositionsByFile.set(file, disposition);
			this.frozenSnapshotsByFile.delete(file);
			const auth = this.fileAuthorities.get(file);
			if (auth) {
				auth.stagedCommand = null;
			}
			return disposition;
		}

		const authority = this.getOrCreateFileAuthority(file, outcome.payload, outcome.decoyBody);
		const rev = outcome.revision ?? this.coordinator.nextFileRevision(this.app, file);
		this.uncommittedStagedPayloads.delete(outcome.payload);
		this.recordPayloadRevision(file, outcome.payload, rev);
		authority.stagedCommand = null;

		if (rev < authority.acceptedPayloadRevision) {
			return this.coordinator.getCommittedDisposition(this.app, file);
		}

		authority.acceptedPayload = outcome.payload;
		authority.acceptedPayloadRevision = rev;
		authority.acceptedDecoyBody = outcome.decoyBody;
		authority.acceptedCoverRevision = rev;
		this.lastKnownDecoy.set(file.path, outcome.decoyBody);

		const rawSerialized = computeSavedContent({
			unlocked: true,
			editorValue: "",
			decoyBody: outcome.decoyBody,
			originalPayload: outcome.payload,
			pendingPayload: outcome.payload,
		});
		const disposition: CommittedDisposition = {
			kind: "protected",
			revision: rev,
			decoyBody: outcome.decoyBody,
			payload: outcome.payload,
			rawSerialized,
		};
		this.coordinator.publishCommittedDisposition(this.app, file, disposition);
		this.capturedDispositionsByFile.set(file, disposition);
		return disposition;
	}

	/** Collects all unsettled command records tracked by this manager for `file`. */
	private collectPendingCommandsForFile(file: TFile): readonly PendingCommandRecord[] {
		const ids = this.trackedCommandIdsByFile.get(file);
		if (!ids || ids.size === 0) return [];
		const out: PendingCommandRecord[] = [];
		for (const id of ids) {
			const rec = this.coordinator.getCommandRecord(this.app, file, id);
			if (rec && !rec.settled) {
				out.push({ ...rec });
			}
		}
		return out;
	}

	/** Selects the highest-revision committed or accepted payload across all sessions for `file`. */
	private selectCanonicalPayloadForGroup(
		file: TFile,
		group: SessionRetirementGroup,
		authority: FileSnapshotAuthority,
	): { payload: PayloadV1; revision: number } {
		let bestPayload = authority.acceptedPayload;
		let bestRevision = authority.acceptedPayloadRevision;

		const committed = this.coordinator.getCommittedDisposition(this.app, file);
		if (
			committed?.kind === "protected" &&
			committed.payload &&
			!this.uncommittedStagedPayloads.has(committed.payload) &&
			committed.revision >= bestRevision
		) {
			bestPayload = committed.payload;
			bestRevision = committed.revision;
		}

		const existingFrozen = this.coordinator.getFrozenSnapshot(this.app, file);
		if (
			existingFrozen &&
			!this.uncommittedStagedPayloads.has(existingFrozen.payload) &&
			existingFrozen.revision >= bestRevision
		) {
			bestPayload = existingFrozen.payload;
			bestRevision = existingFrozen.revision;
		}

		for (const session of group.allSessions) {
			const meta = this.sessionMeta.get(session);
			const pendingCandidate = meta ? meta.pendingPayload : session.pendingPayload;
			if (pendingCandidate !== null && !this.uncommittedStagedPayloads.has(pendingCandidate)) {
				const pendingRev = this.getPayloadRevision(file, pendingCandidate);
				if (pendingRev > bestRevision) {
					bestPayload = pendingCandidate;
					bestRevision = pendingRev;
				}
			}
			const origCandidate = meta ? meta.originalPayload : session.originalPayload;
			if (!this.uncommittedStagedPayloads.has(origCandidate)) {
				const origRev = this.getPayloadRevision(file, origCandidate);
				if (origRev > bestRevision) {
					bestPayload = origCandidate;
					bestRevision = origRev;
				}
			}
		}

		return { payload: bestPayload, revision: bestRevision };
	}

	/** Selects the canonical decoy cover across all sessions and coordinator state for `file`. */
	private selectCanonicalCoverForGroup(
		file: TFile,
		group: SessionRetirementGroup,
		authority: FileSnapshotAuthority,
	): { decoyBody: string; revision: number } {
		let bestCover = authority.acceptedDecoyBody;
		let bestCoverRevision = authority.acceptedCoverRevision;
		let hasChangedCover = authority.acceptedCoverRevision > 0;
		let bestTieIsActiveView = false;
		let bestTieAttachSeq = -1;

		const committed = this.coordinator.getCommittedDisposition(this.app, file);
		if (
			committed?.kind === "protected" &&
			committed.decoyBody !== undefined &&
			committed.revision > bestCoverRevision
		) {
			bestCover = committed.decoyBody;
			bestCoverRevision = committed.revision;
		}

		let activeWorkspaceView: MarkdownView | null = null;
		try {
			const ws = (this.app as unknown as {
				workspace?: { getActiveViewOfType?: (ctor: unknown) => MarkdownView | null };
			}).workspace;
			activeWorkspaceView = ws?.getActiveViewOfType?.(null) ?? null;
		} catch {
			activeWorkspaceView = null;
		}

		for (const session of group.allSessions) {
			const meta = this.sessionMeta.get(session);
			const attachSeq = meta?.attachSeq ?? 0;
			const loadedDecoy = meta?.loadedDecoyBody ?? authority.acceptedDecoyBody;

			if (meta && meta.observedCoverRevision > 0 && meta.observedCoverText !== null) {
				if (
					!hasChangedCover ||
					meta.observedCoverRevision > bestCoverRevision ||
					(meta.observedCoverRevision === bestCoverRevision && attachSeq > bestTieAttachSeq)
				) {
					bestCover = meta.observedCoverText;
					bestCoverRevision = meta.observedCoverRevision;
					hasChangedCover = true;
					bestTieAttachSeq = attachSeq;
					bestTieIsActiveView = session.view === activeWorkspaceView;
				}
			}

			const isAttachedToSameView = this.byView.get(session.view) === session;
			const isSameFile = session.view.file === file;
			const isPureLockedSession =
				session.state === "locked" && session.lockingPromise === null;

			if (isAttachedToSameView && isSameFile && isPureLockedSession) {
				let rawEditor: string | null = null;
				try {
					if (session.view.editor && typeof session.view.editor.getValue === "function") {
						rawEditor = session.view.editor.getValue();
					}
				} catch {
					rawEditor = null;
				}
				if (rawEditor !== null) {
					const parsed = parseFileContent(rawEditor);
					const cleanCandidate = parsed ? parsed.decoyBody : rawEditor;
					const candidateChanged =
						cleanCandidate !== loadedDecoy ||
						cleanCandidate !== authority.acceptedDecoyBody;
					const candidateObservedRev =
						meta && meta.observedCoverText === cleanCandidate
							? meta.observedCoverRevision
							: 0;
					const isActiveView = session.view === activeWorkspaceView;

					if (candidateChanged) {
						if (!hasChangedCover) {
							bestCover = cleanCandidate;
							bestCoverRevision = candidateObservedRev;
							hasChangedCover = true;
							bestTieIsActiveView = isActiveView;
							bestTieAttachSeq = attachSeq;
						} else if (candidateObservedRev > bestCoverRevision) {
							bestCover = cleanCandidate;
							bestCoverRevision = candidateObservedRev;
							bestTieIsActiveView = isActiveView;
							bestTieAttachSeq = attachSeq;
						} else if (candidateObservedRev === bestCoverRevision) {
							if (
								(isActiveView && !bestTieIsActiveView) ||
								(isActiveView === bestTieIsActiveView && attachSeq > bestTieAttachSeq)
							) {
								bestCover = cleanCandidate;
								bestTieIsActiveView = isActiveView;
								bestTieAttachSeq = attachSeq;
							}
						}
					}
				}
			}
		}

		return { decoyBody: bestCover, revision: bestCoverRevision };
	}

	/**
	 * Freezes a canonical `FrozenSafeSnapshot` per file from live session groups before
	 * keys and pending payloads are wiped during retirement.
	 */
	private freezeCanonicalSnapshotsFromGroups(
		groupsByFile: ReadonlyMap<TFile, SessionRetirementGroup>,
		errors: unknown[],
	): void {
		for (const [file, group] of groupsByFile) {
			try {
				const pendingCmds = this.collectPendingCommandsForFile(file);
				if (pendingCmds.length > 0) {
					this.capturedPendingCommandsByFile.set(file, pendingCmds);
				}

				const committed = this.coordinator.getCommittedDisposition(this.app, file);
				if (committed !== null) {
					this.capturedDispositionsByFile.set(file, committed);
					if (committed.kind === "unprotected" || committed.kind === "destroyed") {
						continue;
					}
				}

				const firstSession = group.allSessions[0];
				if (!firstSession && !this.fileAuthorities.has(file)) {
					continue;
				}
				const fallbackMeta = firstSession ? this.sessionMeta.get(firstSession) : undefined;
				const fallbackPayload = fallbackMeta
					? fallbackMeta.originalPayload
					: firstSession!.originalPayload;
				const fallbackDecoy = fallbackMeta
					? fallbackMeta.loadedDecoyBody
					: firstSession!.decoyBody;
				const authority = this.getOrCreateFileAuthority(file, fallbackPayload, fallbackDecoy);

				const { payload: canonicalPayload, revision: payloadRev } =
					this.selectCanonicalPayloadForGroup(file, group, authority);
				const { decoyBody: canonicalCover, revision: coverRev } =
					this.selectCanonicalCoverForGroup(file, group, authority);

				authority.acceptedPayload = canonicalPayload;
				if (payloadRev > authority.acceptedPayloadRevision) {
					authority.acceptedPayloadRevision = payloadRev;
				}
				authority.acceptedDecoyBody = canonicalCover;
				if (coverRev > authority.acceptedCoverRevision) {
					authority.acceptedCoverRevision = coverRev;
				}
				this.lastKnownDecoy.set(file.path, canonicalCover);

				const rawSerialized = computeSavedContent({
					unlocked: true,
					editorValue: "",
					decoyBody: canonicalCover,
					originalPayload: canonicalPayload,
					pendingPayload: canonicalPayload,
				});
				const snapshotRevision = Math.max(
					payloadRev,
					coverRev,
					authority.acceptedPayloadRevision,
					1,
				);
				const snapshot: FrozenSafeSnapshot = {
					file,
					path: file.path,
					revision: snapshotRevision,
					decoyBody: canonicalCover,
					payload: canonicalPayload,
					rawSerialized,
				};
				this.frozenSnapshotsByFile.set(file, snapshot);
				this.coordinator.freezeSafeSnapshot(this.app, snapshot);

				for (const session of group.allSessions) {
					this.runInternalSessionMutation(session, () => {
						session.decoyBody = canonicalCover;
						session.originalPayload = canonicalPayload;
					});
				}
			} catch (error) {
				errors.push(error);
			}
		}
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

		this.freezeCanonicalSnapshotsFromGroups(groupsByFile, errors);

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
					window.clearTimeout(session.reencryptTimer);
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
			this.runInternalSessionMutation(session, () => {
				session.pendingPayload = null;
			});
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

	/** Invokes a captured `NativeViewDataSetter` regardless of whether it takes `(data, clear)` or `(view, data, clear)`. */
	private invokeNativeSetter(
		setter: NativeViewDataSetter,
		view: MarkdownView,
		fullRaw: string,
	): void {
		if (setter.length >= 3) {
			(setter as (view: MarkdownView, data: string, clear: boolean) => void)(
				view,
				fullRaw,
				true,
			);
			return;
		}
		(setter as (this: MarkdownView, data: string, clear: boolean) => void).call(
			view,
			fullRaw,
			true,
		);
	}

	/**
	 * Clears editor undo/redo history on `view` during fallback hydration so `Ctrl+Z`
	 * cannot recover decrypted plaintext when `nativeSetViewData(fullRaw, true)` fails.
	 */
	private clearFallbackUndoHistory(view: MarkdownView): void {
		try {
			const viewWithClear = view as unknown as {
				clear?: () => void;
				undoHistory?: unknown[];
			};
			if (typeof viewWithClear.clear === "function") {
				viewWithClear.clear();
			}
			if (Array.isArray(viewWithClear.undoHistory)) {
				viewWithClear.undoHistory.length = 0;
			}
		} catch {}
		try {
			const editorWithHistory = view.editor as unknown as {
				clearHistory?: () => void;
				undoHistory?: unknown[];
			};
			if (typeof editorWithHistory?.clearHistory === "function") {
				editorWithHistory.clearHistory();
			}
			if (Array.isArray(editorWithHistory?.undoHistory)) {
				editorWithHistory.undoHistory.length = 0;
			}
		} catch {}
	}

	/** Verifies that both `view.editor.getValue()` and `view.data` exactly match `expectedRaw`. */
	private isViewProvenSafe(view: MarkdownView, expectedRaw: string): boolean {
		try {
			const hasEditor =
				view.editor !== undefined &&
				view.editor !== null &&
				typeof view.editor.getValue === "function";
			if (!hasEditor) {
				return false;
			}
			const editorMatches = view.editor.getValue() === expectedRaw;
			const backingMatches = (view as unknown as { data?: unknown }).data === expectedRaw;
			const viewHistory = (view as unknown as { undoHistory?: unknown[] }).undoHistory;
			const editorHistory = (view.editor as unknown as { undoHistory?: unknown[] }).undoHistory;
			const historyClean =
				(!Array.isArray(viewHistory) || viewHistory.length === 0) &&
				(!Array.isArray(editorHistory) || editorHistory.length === 0);
			return editorMatches && backingMatches && historyClean;
		} catch {
			return false;
		}
	}

	/** Marks `view` as save-blocked in the coordinator and installs a throwing `view.save` guard. */
	private installSaveBlockGuardOnView(view: MarkdownView, reason: unknown): void {
		this.coordinator.markViewSaveBlocked(this.app, view);
		const message =
			reason instanceof Error
				? `Veneer: refusing native save on a view whose sanitization failed (${reason.message})`
				: "Veneer: refusing native save on a view whose sanitization failed";
		try {
			Object.defineProperty(view, "save", {
				value: async (): Promise<void> => {
					throw new Error(message);
				},
				writable: true,
				configurable: true,
				enumerable: false,
			});
		} catch {}
	}

	/** Restores the displayed title DOM elements on `session.view` with per-element error isolation. */
	private applyDisplayedTitleIsolated(
		session: ViewSession,
		titleText: string,
		errors: unknown[],
		failures: ShutdownHandoffFailure[],
	): void {
		try {
			const container = (session.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (container) {
				try {
					const inlineEl = container.querySelector(".inline-title");
					if (inlineEl) inlineEl.textContent = titleText;
				} catch (error) {
					errors.push(error);
					failures.push({
						file: session.file,
						path: session.file.path,
						view: session.view,
						reason: error,
						saveBlocked: false,
					});
				}
				try {
					const headerEl = container.querySelector(".view-header-title");
					if (headerEl) headerEl.textContent = titleText;
				} catch (error) {
					errors.push(error);
					failures.push({
						file: session.file,
						path: session.file.path,
						view: session.view,
						reason: error,
						saveBlocked: false,
					});
				}
			}
		} catch (error) {
			errors.push(error);
			failures.push({
				file: session.file,
				path: session.file.path,
				view: session.view,
				reason: error,
				saveBlocked: false,
			});
		}

		try {
			const leaf = (
				session.view as unknown as { leaf?: { tabHeaderInnerTitleEl?: HTMLElement } }
			).leaf;
			if (leaf?.tabHeaderInnerTitleEl) {
				leaf.tabHeaderInnerTitleEl.textContent = titleText;
			}
		} catch (error) {
			errors.push(error);
			failures.push({
				file: session.file,
				path: session.file.path,
				view: session.view,
				reason: error,
				saveBlocked: false,
			});
		}
	}

	/**
	 * Synchronously prepares retirement, freezes canonical per-file snapshots, hydrates
	 * open views with safe serialized content, and installs save-block guards on any view
	 * that cannot be proven safe.
	 */
	shutdownAndHandoff(nativeSetViewData?: NativeViewDataSetter): ShutdownHandoffResult {
		if (nativeSetViewData !== undefined) {
			this.capturedNativeSetViewData = nativeSetViewData;
		}
		if (this.handoffResult !== null) {
			this.prepareRetirement();
			return this.handoffResult;
		}

		const preparation = this.prepareRetirement();
		const effectiveSetter = nativeSetViewData ?? this.capturedNativeSetViewData;
		const errors: unknown[] = [...preparation.errors];
		const failures: ShutdownHandoffFailure[] = [];
		const viewOutcomes: ViewHydrationOutcome[] = [];
		const saveBlockedViews: MarkdownView[] = [];
		const processedViews = new Set<MarkdownView>();

		this.isHydratingView = true;
		try {
			for (const [file, group] of preparation.groupsByFile) {
				const disposition =
					this.coordinator.getCommittedDisposition(this.app, file) ??
					this.capturedDispositionsByFile.get(file) ??
					null;
				if (disposition !== null) {
					this.capturedDispositionsByFile.set(file, disposition);
				}

				const snapshot = this.frozenSnapshotsByFile.get(file) ?? null;
				const targetRaw =
					disposition?.kind === "unprotected" && disposition.plaintextContent !== undefined
						? disposition.plaintextContent
						: snapshot?.rawSerialized;

				for (const session of group.allSessions) {
					const view = session.view;
					if (processedViews.has(view)) {
						continue;
					}
					processedViews.add(view);

					let currentViewFile: TFile | null = null;
					try {
						currentViewFile = (view as unknown as { file?: TFile | null }).file ?? null;
					} catch (error) {
						errors.push(error);
						currentViewFile = null;
					}

					if (currentViewFile !== file) {
						viewOutcomes.push({
							view,
							file,
							path: file.path,
							status: "skipped-switched-file",
						});
						continue;
					}

					if (targetRaw === undefined) {
						if (disposition?.kind !== "destroyed") {
							const reason = new Error(`No safe snapshot available for ${file.path}`);
							this.installSaveBlockGuardOnView(view, reason);
							if (!saveBlockedViews.includes(view)) {
								saveBlockedViews.push(view);
							}
							failures.push({
								file,
								path: file.path,
								view,
								reason,
								saveBlocked: true,
							});
							viewOutcomes.push({
								view,
								file,
								path: file.path,
								status: "save-blocked",
								error: reason,
							});
						}
						this.applyDisplayedTitleIsolated(session, file.basename, errors, failures);
						continue;
					}

					let setterError: unknown = null;
					let nativeSetterSucceeded = false;

					if (effectiveSetter !== null) {
						try {
							this.invokeNativeSetter(effectiveSetter, view, targetRaw);
							(view as unknown as { data: string }).data = targetRaw;
							if (
								view.editor &&
								typeof view.editor.getValue === "function" &&
								view.editor.getValue() !== targetRaw &&
								typeof view.editor.setValue === "function"
							) {
								view.editor.setValue(targetRaw);
							}
							nativeSetterSucceeded = this.isViewProvenSafe(view, targetRaw);
						} catch (error) {
							setterError = error;
							errors.push(error);
							nativeSetterSucceeded = false;
						}
					} else {
						setterError = new Error("No captured native setViewData setter available");
						errors.push(setterError);
					}

					if (nativeSetterSucceeded) {
						if (
							disposition?.kind === "unprotected" &&
							disposition.plaintextContent !== undefined
						) {
							this.coordinator.markViewUnprotectReconciled(this.app, file, view);
						}
						this.coordinator.clearViewSaveBlocked(this.app, view);
						viewOutcomes.push({
							view,
							file,
							path: file.path,
							status: "hydrated",
						});
					} else {
						let fallbackError: unknown = null;
						try {
							this.clearFallbackUndoHistory(view);
							view.editor?.setValue?.(targetRaw);
							(view as unknown as { data: string }).data = targetRaw;
							this.clearFallbackUndoHistory(view);
							view.editor?.setValue?.(targetRaw);
							(view as unknown as { data: string }).data = targetRaw;
						} catch (error) {
							fallbackError = error;
							errors.push(error);
						}

						if (fallbackError === null && this.isViewProvenSafe(view, targetRaw)) {
							if (
								disposition?.kind === "unprotected" &&
								disposition.plaintextContent !== undefined
							) {
								this.coordinator.markViewUnprotectReconciled(this.app, file, view);
							}
							this.coordinator.clearViewSaveBlocked(this.app, view);
							viewOutcomes.push({
								view,
								file,
								path: file.path,
								status: "fallback-hydrated",
								...(setterError !== null ? { error: setterError } : {}),
							});
						} else {
							const blockReason =
								fallbackError ??
								setterError ??
								new Error(`Failed to prove view safe for ${file.path}`);
							this.installSaveBlockGuardOnView(view, blockReason);
							if (!saveBlockedViews.includes(view)) {
								saveBlockedViews.push(view);
							}
							failures.push({
								file,
								path: file.path,
								view,
								reason: blockReason,
								saveBlocked: true,
							});
							viewOutcomes.push({
								view,
								file,
								path: file.path,
								status: "save-blocked",
								error: blockReason,
							});
						}
					}

					this.applyDisplayedTitleIsolated(session, file.basename, errors, failures);
				}
			}
		} finally {
			this.isHydratingView = false;
		}

		const retirementSpecs: KeylessRetirementSpec[] = [];
		for (const [file, snapshot] of this.frozenSnapshotsByFile) {
			const disp = this.capturedDispositionsByFile.get(file);
			if (disp?.kind === "unprotected" || disp?.kind === "destroyed") {
				continue;
			}
			retirementSpecs.push({ snapshot });
		}

		const result: ShutdownHandoffResult = {
			preparation,
			capturedNativeSetViewData: effectiveSetter,
			snapshotsByFile: this.frozenSnapshotsByFile,
			dispositionsByFile: this.capturedDispositionsByFile,
			pendingCommandsByFile: this.capturedPendingCommandsByFile,
			retirementSpecs,
			viewOutcomes,
			saveBlockedViews,
			hasSaveBlockedViews: saveBlockedViews.length > 0,
			failures,
			errors,
		};
		this.handoffResult = result;
		return result;
	}

	/** Removes all captured sessions from `byView` and `byPath` lookup maps. */
	private detachCapturedSessions(sessions: readonly ViewSession[]): void {
		for (const session of sessions) {
			if (this.byView.get(session.view) === session) {
				this.byView.delete(session.view);
			}
			this.removeFromPath(session.file.path, session);
		}
		this.byPath.clear();
	}

	/** Indexes `session` under `path` in `byPath`. */
	private addToPath(path: string, session: ViewSession): void {
		let set = this.byPath.get(path);
		if (!set) {
			set = new Set<ViewSession>();
			this.byPath.set(path, set);
		}
		set.add(session);
	}

	/** Removes `session` from the `byPath` index for `path`. */
	private removeFromPath(path: string, session: ViewSession): void {
		const set = this.byPath.get(path);
		if (!set) return;
		set.delete(session);
		if (set.size === 0) {
			this.byPath.delete(path);
		}
	}

	/** Returns the `ViewSession` currently attached to `view`, or `null`. */
	get(view: MarkdownView): ViewSession | null {
		return this.byView.get(view) ?? null;
	}

	/** Returns all `ViewSession` instances currently indexed under `path`. */
	getAllByPath(path: string): ViewSession[] {
		const set = this.byPath.get(path);
		return set ? [...set] : [];
	}

	/** Returns the unlocked session for `path` if one exists, or the most recently attached session. */
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
	runReservedWrite(
		startEpoch: number,
		task: () => Promise<void>,
		options?: {
			readonly file?: TFile;
			readonly commandId?: symbol;
			readonly dispositionOnCommit?: CommittedDisposition;
			readonly onCommitted?: () => void | Promise<void>;
			readonly canCommit?: () => boolean;
		},
	): Promise<boolean> {
		if (this.isDisposed() || startEpoch !== this.killEpoch) {
			return Promise.resolve(false);
		}
		const stagedSnapshots: Array<{
			file: TFile;
			payload: PayloadV1;
			decoyBody: string;
		}> = [];
		for (const [file, authority] of this.fileAuthorities) {
			if (this.reservedPaths.has(file.path) && authority.stagedCommand !== null) {
				stagedSnapshots.push({
					file,
					payload: authority.stagedCommand.payload ?? authority.acceptedPayload,
					decoyBody: authority.stagedCommand.decoyBody ?? authority.acceptedDecoyBody,
				});
			}
		}

		const targetFile =
			options?.file ??
			(stagedSnapshots.length === 1 ? stagedSnapshots[0]?.file : undefined);

		if (targetFile) {
			return this.enqueueCoordinatedWrite<void>(
				targetFile,
				async () => {
					await task();
				},
				{
					epoch: startEpoch,
					kind: "normal",
					...(options?.commandId ? { commandId: options.commandId } : {}),
					...(options?.dispositionOnCommit
						? { dispositionOnCommit: options.dispositionOnCommit }
						: {}),
					...(options?.canCommit ? { canCommit: options.canCommit } : {}),
					onCommitted: async () => {
						if (this.killEpoch === startEpoch) {
							for (const item of stagedSnapshots) {
								this.publishCommandCommit(item.file, {
									kind: "password",
									payload: item.payload,
									decoyBody: item.decoyBody,
								});
							}
						}
						await options?.onCommitted?.();
					},
				},
			).then((res) => res.status === "committed");
		}

		if (options?.canCommit && !options.canCommit()) {
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
		return write.then(async () => {
			if (this.killEpoch === startEpoch) {
				for (const item of stagedSnapshots) {
					this.publishCommandCommit(item.file, {
						kind: "password",
						payload: item.payload,
						decoyBody: item.decoyBody,
					});
				}
			}
			await options?.onCommitted?.();
			return true;
		});
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
			readonly canCommit?: () => boolean;
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
		const promise = this.coordinator
			.enqueueFileWrite<T>(this.app, {
				file,
				owner: this.owner,
				epoch: this.owner.killEpoch,
				kind,
				task: async () => {
					if (kind === "normal" && (this.isDisposed() || capturedEpoch !== this.killEpoch)) {
						throw new DeclinedByManagerError();
					}
					if (options?.canCommit && !options.canCommit()) {
						throw new DeclinedByManagerError();
					}
					return task();
				},
				...(options?.onCommitted ? { onCommitted: options.onCommitted } : {}),
				...(options?.dispositionOnCommit
					? { dispositionOnCommit: options.dispositionOnCommit }
					: {}),
				...(options?.commandId ? { commandId: options.commandId } : {}),
			})
			.catch((err: unknown) => {
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

	/** Marks `file`'s in-memory snapshot as dirty so retirement persists it if needed. */
	markSnapshotNeedsRetirementCommit(file: TFile): void {
		if (this.isDisposed()) return;
		this.dirtySessionSnapshots.add(file);
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

	/** Replays and clears any deferred save callbacks queued while `path` was reserved. */
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

	/** Returns true if `path` is reserved or has any unlocked or currently locking session. */
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

	/** Returns all currently attached `ViewSession` instances across all paths. */
	all(): ViewSession[] {
		const out: ViewSession[] = [];
		for (const set of this.byPath.values()) {
			out.push(...set);
		}
		return out;
	}

	/** Creates a `ViewSession` bound with property interceptors that track cover and payload mutations. */
	private createBoundViewSession(
		view: MarkdownView,
		file: TFile,
		initialDecoyBody: string,
		initialPayload: PayloadV1,
	): ViewSession {
		this.attachSequenceCounter += 1;
		const meta: SessionInternalMeta = {
			attachSeq: this.attachSequenceCounter,
			loadedDecoyBody: initialDecoyBody,
			decoyBody: initialDecoyBody,
			originalPayload: initialPayload,
			pendingPayload: null,
			observedCoverText: null,
			observedCoverRevision: 0,
			internalMutationDepth: 0,
		};

		const session = {
			view,
			file,
			state: "locked" as "locked" | "unlocked",
			lockingPromise: null as Promise<void> | null,
			killGeneration: 0,
			dek: null as Uint8Array<ArrayBuffer> | null,
			realTitle: null as string | null,
			imageUrls: new Map<string, string>(),
			backoff: new BackoffTracker(),
			capture: new CaptureBuffer(this.triggerPrefix()),
			reencryptTimer: null as ReturnType<typeof window.setTimeout> | number | null,
			reencryptSeq: 0,
			reencryptPromise: null as Promise<void> | null,
			writePromise: null as Promise<void> | null,
			stagedFilesByPayload: new WeakMap<PayloadV1, StagedFile[]>(),
		} as ViewSession;

		Object.defineProperties(session, {
			decoyBody: {
				get: (): string => meta.decoyBody,
				set: (next: string): void => {
					meta.decoyBody = next;
					if (meta.internalMutationDepth > 0 || this.isDisposed()) {
						return;
					}
					const authority = this.getOrCreateFileAuthority(
						file,
						meta.originalPayload,
						meta.loadedDecoyBody,
					);
					if (this.isPathReserved(file.path)) {
						if (next === authority.acceptedDecoyBody) {
							if (authority.stagedCommand) {
								delete authority.stagedCommand.decoyBody;
								if (authority.stagedCommand.payload === undefined) {
									authority.stagedCommand = null;
								}
							}
						} else {
							authority.stagedCommand = {
								...(authority.stagedCommand ?? {}),
								decoyBody: next,
							};
						}
						return;
					}
					if (next !== authority.acceptedDecoyBody) {
						this.observeCoverEdit(session, next);
					}
				},
				enumerable: true,
				configurable: true,
			},
			originalPayload: {
				get: (): PayloadV1 => meta.originalPayload,
				set: (next: PayloadV1): void => {
					meta.originalPayload = next;
					if (meta.internalMutationDepth > 0 || this.isDisposed()) {
						return;
					}
					const authority = this.getOrCreateFileAuthority(
						file,
						next,
						meta.decoyBody,
					);
					const knownRev = this.getPayloadRevision(file, next);
					if (knownRev > 0) {
						if (authority.stagedCommand) {
							delete authority.stagedCommand.payload;
							if (authority.stagedCommand.decoyBody === undefined) {
								authority.stagedCommand = null;
							}
						}
						return;
					}
					this.uncommittedStagedPayloads.add(next);
					authority.stagedCommand = {
						...(authority.stagedCommand ?? {}),
						payload: next,
					};
				},
				enumerable: true,
				configurable: true,
			},
			pendingPayload: {
				get: (): PayloadV1 | null => meta.pendingPayload,
				set: (next: PayloadV1 | null): void => {
					meta.pendingPayload = next;
					if (meta.internalMutationDepth > 0 || this.isDisposed() || next === null) {
						return;
					}
					if (this.uncommittedStagedPayloads.has(next)) {
						return;
					}
					if (next === meta.originalPayload) {
						return;
					}
					const authority = this.getOrCreateFileAuthority(
						file,
						meta.originalPayload,
						meta.decoyBody,
					);
					let rev = this.getPayloadRevision(file, next);
					if (rev === 0) {
						rev = this.coordinator.nextFileRevision(this.app, file);
						this.recordPayloadRevision(file, next, rev);
					}
					if (rev >= authority.acceptedPayloadRevision) {
						authority.acceptedPayload = next;
						authority.acceptedPayloadRevision = rev;
						this.dirtySessionSnapshots.add(file);
					}
				},
				enumerable: true,
				configurable: true,
			},
		});

		this.sessionMeta.set(session, meta);
		return session;
	}

	/**
	 * Attaches or updates a `ViewSession` when `view` loads `file` with `parsed`,
	 * reconciling against any newer coordinator snapshot or disposition.
	 */
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
		const hadAuthorityBeforeLoad = this.fileAuthorities.has(file);
		const authority = this.getOrCreateFileAuthority(file, parsed.payload, parsed.decoyBody);
		this.coordinator.clearFrozenSnapshot(this.app, file);
		if (hadAuthorityBeforeLoad) {
			const parsedRev = this.getPayloadRevision(file, parsed.payload);
			if (parsedRev === 0) {
				const nextRev = this.coordinator.nextFileRevision(this.app, file);
				this.recordPayloadRevision(file, parsed.payload, nextRev);
				if (nextRev >= authority.acceptedPayloadRevision) {
					authority.acceptedPayload = parsed.payload;
					authority.acceptedPayloadRevision = nextRev;
					authority.acceptedDecoyBody = parsed.decoyBody;
				}
			}
		}
		const effectivePayload =
			this.getPayloadRevision(file, parsed.payload) < authority.acceptedPayloadRevision
				? authority.acceptedPayload
				: parsed.payload;
		const effectiveDecoy =
			authority.acceptedCoverRevision > 0 ||
			this.getPayloadRevision(file, parsed.payload) < authority.acceptedPayloadRevision
				? authority.acceptedDecoyBody
				: parsed.decoyBody;

		const existing = this.byView.get(view);
		if (existing) {
			if (existing.file === file) {
				const meta = this.sessionMeta.get(existing);
				if (meta) {
					meta.loadedDecoyBody = effectiveDecoy;
				}
				this.runInternalSessionMutation(existing, () => {
					existing.decoyBody = effectiveDecoy;
					existing.originalPayload = effectivePayload;
				});
				this.rememberDecoy(file.path, effectiveDecoy);
				if (existing.state === "unlocked") {
					void this.lock(existing, "reload").catch((error) => {
						console.warn("Veneer: lock on reload failed", error);
					});
				}
				try {
					this.hooks.onAttached?.(file, parsed.payload);
				} catch {
					// Ignore hook errors during synchronous view attachment
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
					this.runInternalSessionMutation(existing, () => {
						existing.pendingPayload = null;
					});
					existing.realTitle = null;
					existing.capture.cancel();
					existing.reencryptSeq += 1;
					if (existing.reencryptTimer !== null) {
						window.clearTimeout(existing.reencryptTimer);
						existing.reencryptTimer = null;
					}
					this.hooks.onLocked(existing);
				}
			}
			this.removeFromPath(existing.file.path, existing);
			this.byView.delete(view);
		}
		const session = this.createBoundViewSession(
			view,
			file,
			effectiveDecoy,
			effectivePayload,
		);
		this.byView.set(view, session);
		this.addToPath(file.path, session);
		this.rememberDecoy(file.path, effectiveDecoy);
		try {
			this.hooks.onAttached?.(file, parsed.payload);
		} catch {
			// Ignore hook errors during synchronous view attachment
		}
		return session;
	}

	/** Updates path-indexed session and decoy maps when a file is renamed from `oldPath` to `newPath`. */
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

	/** Detaches any tracked sessions whose views are no longer present in `activeViews`. */
	pruneDetached(activeViews: Set<MarkdownView>): void {
		if (this.isDisposed()) return;
		for (const session of this.all()) {
			if (!activeViews.has(session.view)) {
				if (session.lockingPromise !== null) {
					void session.lockingPromise.finally(() => {
						if (!this.isDisposed() && this.byView.get(session.view) === session) {
							this.byView.delete(session.view);
							this.removeFromPath(session.file.path, session);
						}
					});
				} else {
					this.detach(session.view);
				}
			}
		}
	}

	/** Masks and detaches the session associated with `view`. */
	detach(view: MarkdownView): void {
		const session = this.byView.get(view);
		if (!session) return;
		if (session.lockingPromise !== null) {
			this.coordinator.releaseFileActivePromise(this.app, session.file);
		}
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
			window.clearTimeout(session.reencryptTimer);
			session.reencryptTimer = null;
		}
		this.pendingLocks.delete(session);
		this.lockTextObservers.delete(session);
		this.activeLockSnapshots.delete(session);
		this.byView.delete(session.view);
		this.removeFromPath(session.file.path, session);
		this.hooks.onLocked(session);
		return true;
	}

	/** Populates `session.imageUrls` with `blob:` preview URLs for decrypted vault images. */
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

	/** Revokes all `blob:` preview URLs held by `session` and clears `session.imageUrls`. */
	private revokeImageUrls(session: ViewSession): void {
		this.revokeImageUrlsIsolated(session);
	}

	/** Revokes all `blob:` preview URLs held by `session`, isolating per-URL errors. */
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

	/** Updates the inline title, view header title, and tab header title for `session.view`. */
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

	/** Reads the current edited inline title from `session.view`'s DOM, falling back to `session.realTitle`. */
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
		const candidateRevision = this.coordinator.nextFileRevision(this.app, session.file);
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
		this.acceptReencryptedPayload(session, nextPayload, candidateRevision);
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
		this.commitSessionPayload(session, nextPayload, candidateRevision);
		this.acceptReencryptedPayload(session, nextPayload, candidateRevision);
		this.refreshPreviewImageUrls(session, result.staged);
		if (this.isDisposed() || this.killEpoch !== startEpoch || session.killGeneration !== startGeneration) {
			return;
		}
		await deleteStagedVaultImages(
			this.app,
			this.persistedStagedFiles(result.staged.filesToDelete, nextPayload.images),
		);
	}

	/**
	 * Attempts to unlock `session` with `password`, deriving the DEK, decrypting real text
	 * and embedded images, and swapping the editor buffer to plaintext if still attached and live.
	 */
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
	lock(
		session: ViewSession,
		_reason: string,
		onTextCaptured?: (text: string) => void,
	): Promise<void> {
		if (this.isDisposed() || this.reservedPaths.has(session.file.path)) {
			return Promise.resolve();
		}
		if (onTextCaptured) {
			let observers = this.lockTextObservers.get(session);
			if (!observers) {
				observers = new Set();
				this.lockTextObservers.set(session, observers);
			}
			observers.add(onTextCaptured);
			const priorSnapshots = this.activeLockSnapshots.get(session);
			if (priorSnapshots) {
				for (const snap of priorSnapshots) {
					try {
						onTextCaptured(snap);
					} catch {
						// Ignore observer errors during lock replay
					}
				}
			}
			if (
				this.isAttached(session) &&
				session.view.file === session.file &&
				session.state === "unlocked" &&
				session.view.editor &&
				typeof session.view.editor.getValue === "function"
			) {
				const initialText = session.view.editor.getValue();
				if (
					typeof initialText === "string" &&
					initialText !== session.decoyBody &&
					parseFileContent(initialText) === null
				) {
					onTextCaptured(initialText);
				}
			}
		}
		if (session.lockingPromise !== null) return session.lockingPromise;
		if (session.state !== "unlocked") {
			this.lockTextObservers.delete(session);
			this.activeLockSnapshots.delete(session);
			return Promise.resolve();
		}
		this.activeLockSnapshots.set(session, []);
		const notifyLockText = (text: string): void => {
			if (!text) return;
			let snapshots = this.activeLockSnapshots.get(session);
			if (!snapshots) {
				snapshots = [];
				this.activeLockSnapshots.set(session, snapshots);
			}
			if (!snapshots.includes(text)) {
				snapshots.push(text);
			}
			const observers = this.lockTextObservers.get(session);
			if (!observers) return;
			for (const cb of observers) {
				try {
					cb(text);
				} catch {
					// Ignore observer errors during lock
				}
			}
		};
		session.reencryptSeq += 1;
		if (session.reencryptTimer !== null) {
			window.clearTimeout(session.reencryptTimer);
			session.reencryptTimer = null;
		}
		const sameFile = session.view.file === session.file;
		let currentText = sameFile ? session.view.editor.getValue() : "";
		if (
			sameFile &&
			typeof currentText === "string" &&
			currentText !== session.decoyBody &&
			parseFileContent(currentText) === null
		) {
			notifyLockText(currentText);
		}
		let currentTitle = sameFile ? this.readEditedInlineTitle(session) : session.realTitle;
		let candidateRevision = sameFile
			? this.coordinator.nextFileRevision(this.app, session.file)
			: 0;
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
					if (parseFileContent(currentText) !== null) {
						const preservedPayload = session.pendingPayload ?? session.originalPayload;
						this.commitSessionPayload(session, preservedPayload, candidateRevision);
						for (const peer of this.getAllByPath(session.file.path)) {
							this.runInternalSessionMutation(peer, () => {
								peer.originalPayload = preservedPayload;
							});
						}
						return;
					}
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
						if (
							postStageText !== currentText &&
							postStageText !== session.decoyBody &&
							parseFileContent(postStageText) === null
						) {
							currentText = postStageText;
							notifyLockText(currentText);
							candidateRevision = this.coordinator.nextFileRevision(
								this.app,
								session.file,
							);
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
					this.acceptReencryptedPayload(
						session,
						lockedPayload,
						candidateRevision,
						currentTitle,
					);
					if (
						this.isAttached(session) &&
						session.view.file === session.file &&
						session.state === "unlocked"
					) {
						const latestText = session.view.editor.getValue();
						if (
							latestText !== currentText &&
							latestText !== session.decoyBody &&
							parseFileContent(latestText) === null
						) {
							currentText = latestText;
							notifyLockText(currentText);
							currentTitle = this.readEditedInlineTitle(session);
							session.realTitle = currentTitle;
							candidateRevision = this.coordinator.nextFileRevision(
								this.app,
								session.file,
							);
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
							this.acceptReencryptedPayload(
								session,
								lockedPayload,
								candidateRevision,
								currentTitle,
							);
						}
					}
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
					this.commitSessionPayload(session, lockedPayload, candidateRevision);
					for (const peer of this.getAllByPath(session.file.path)) {
						this.runInternalSessionMutation(peer, () => {
							peer.originalPayload = lockedPayload;
						});
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
				this.lockTextObservers.delete(session);
				this.activeLockSnapshots.delete(session);
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
					this.runInternalSessionMutation(session, () => {
						session.pendingPayload = null;
					});
					session.capture.cancel();
					if (session.reencryptTimer !== null) {
						window.clearTimeout(session.reencryptTimer);
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
				window.clearTimeout(session.reencryptTimer);
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
		if (session.reencryptTimer !== null) window.clearTimeout(session.reencryptTimer);
		session.reencryptTimer = window.setTimeout(() => {
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
						if (parseFileContent(snapshotText) !== null) {
							return;
						}
						const snapshotTitle = this.readEditedInlineTitle(session);
						const candidateRevision = this.coordinator.nextFileRevision(
							this.app,
							session.file,
						);
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
						const accepted = this.acceptReencryptedPayload(
							session,
							nextPayload,
							candidateRevision,
							snapshotTitle,
						);
						if (!accepted) {
							return;
						}
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
		this.reservationWrites.add(tracked);
		void tracked.finally(() => {
			this.reservationWrites.delete(tracked);
		});
		const ownerRuntime = this.coordinator.trackSubmittedOwnerPromise(this.app, this.owner, session.file, tracked);
		session.writePromise = tracked;
		void tracked.finally(() => {
			ownerRuntime();
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
		if (session.state === "locked" && session.lockingPromise === null) {
			this.observeCoverEdit(session);
		}
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
		this.commitSessionPayload(session, persisted);
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

/** Sentinel error thrown internally when a queued task is declined by a retired or epoch-fenced manager. */
class DeclinedByManagerError extends Error {
	/** Initializes the sentinel error message for a declined manager task. */
	constructor() {
		super("Declined by retired or epoch-fenced SessionManager");
	}
}
