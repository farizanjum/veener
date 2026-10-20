import { MarkdownView, type App, type TFile } from "obsidian";
import type { PayloadV1 } from "../crypto/payload";

/**
 * Shared owner-aware per-file write and retirement coordinator (§5 / Issue #13).
 *
 * Bridges synchronous Obsidian `onunload()` / `register()` teardown with already-submitted
 * asynchronous host I/O (`vault.modify`, `MarkdownView.prototype.save`) across plugin
 * disable/re-enable cycles, without retaining encryption keys or introducing a second
 * cryptographic backend.
 */

export const VIEW_LIFECYCLE_SYMBOL = Symbol.for("veneer.viewLifecycle.v1");

export type OwnerPhase = "active" | "retiring" | "retired";

export type WriteJobKind =
	| "normal"
	| "retirement-commit"
	| "native-save-guard"
	| "destruction";

export type WriteAdmissionStatus = "committed" | "declined";

export interface WriteAdmissionResult<T = void> {
	readonly status: WriteAdmissionStatus;
	readonly value?: T;
}

export type TerminalDispositionKind = "protected" | "unprotected" | "destroyed";

export interface CommittedDisposition {
	readonly kind: TerminalDispositionKind;
	readonly revision: number;
	readonly decoyBody?: string;
	readonly payload?: PayloadV1;
	readonly rawSerialized?: string;
	readonly plaintextContent?: string;
}

export interface FrozenSafeSnapshot {
	readonly file: TFile;
	readonly path: string;
	readonly revision: number;
	readonly decoyBody: string;
	readonly payload: PayloadV1;
	readonly rawSerialized: string;
}

export type PendingCommandKind = "unprotect" | "password" | "refresh" | "protect";

export interface PendingCommandRecord {
	readonly commandId: symbol;
	readonly kind: PendingCommandKind;
	readonly owner: OwnerToken;
	readonly file: TFile;
	readonly path: string;
	submitted: boolean;
	settled: boolean;
}

export interface OwnerToken {
	readonly id: symbol;
	readonly label: string;
	phase: OwnerPhase;
	killEpoch: number;
}

export interface NativeMethodsSnapshot {
	readonly setViewData: (this: MarkdownView, data: string, clear: boolean) => void;
	readonly getViewData: (this: MarkdownView) => string;
	readonly save: (this: MarkdownView, clear?: boolean) => Promise<void>;
}

export interface PrototypeWrapperHandlers {
	readonly setViewData: (this: MarkdownView, data: string, clear: boolean) => void;
	readonly getViewData: (this: MarkdownView) => string;
	readonly save: (this: MarkdownView, clear?: boolean) => Promise<void>;
}

export interface OwnedPrototypeLease {
	readonly owner: OwnerToken;
	readonly baseOriginals: NativeMethodsSnapshot;
	/** Releases this owner's active handlers and restores prototype properties only if still owned and all guards drained. */
	readonly releaseOwnerHandlers: () => boolean;
	/** Returns true when this owner's installed wrappers are still the top-most wrappers on the prototype. */
	readonly isTopMostOnPrototype: () => boolean;
}

export interface EnqueueFileWriteOptions<T = void> {
	readonly file: TFile;
	readonly owner: OwnerToken | null;
	readonly epoch?: number;
	readonly kind: WriteJobKind;
	readonly task: () => Promise<T>;
	readonly onCommitted?: (value: T) => void | Promise<void>;
	readonly dispositionOnCommit?: CommittedDisposition;
	readonly commandId?: symbol;
	readonly destructionGeneration?: number;
}

export interface KeylessRetirementSpec {
	readonly snapshot: FrozenSafeSnapshot;
	/** Optional host write task when retirement itself must persist a frozen already-encrypted snapshot. */
	readonly persistTask?: (snapshot: FrozenSafeSnapshot) => Promise<void>;
	readonly onCommitted?: () => void | Promise<void>;
}

export interface RetirementBarrierState {
	readonly file: TFile;
	readonly path: string;
	readonly snapshot: FrozenSafeSnapshot;
	readonly status: "draining" | "settled" | "failed";
	readonly failureReason: unknown;
	readonly promise: Promise<void>;
}

export interface GuardedNativeSetViewDataOptions {
	readonly app: object;
	readonly view: MarkdownView;
	readonly file: TFile | null;
	readonly incomingData: string;
	readonly clear: boolean;
	readonly rawSetViewData: (this: MarkdownView, data: string, clear: boolean) => void;
	readonly onAfterBarrier?: (view: MarkdownView, file: TFile) => void | Promise<void>;
}

export interface GuardedNativeSaveOptions {
	readonly app: object;
	readonly view: MarkdownView;
	readonly clear: boolean | undefined;
	readonly rawSave: (this: MarkdownView, clear?: boolean) => Promise<void>;
	readonly syncViewData?: (view: MarkdownView, safeContent: string) => void;
}

interface QueuedWriteEntry<T = unknown> {
	readonly file: TFile;
	readonly path: string;
	readonly owner: OwnerToken | null;
	readonly epoch: number | undefined;
	readonly kind: WriteJobKind;
	readonly enqueuedDestructionGen: number;
	readonly commandId: symbol | undefined;
	readonly task: () => Promise<T>;
	readonly onCommitted: ((value: T) => void | Promise<void>) | undefined;
	readonly dispositionOnCommit: CommittedDisposition | undefined;
	submitted: boolean;
	cancelledBeforeSubmit: boolean;
	readonly resolve: (res: WriteAdmissionResult<T>) => void;
	readonly reject: (err: unknown) => void;
}

interface FileQueueRecord {
	readonly file: TFile;
	lastKnownPath: string;
	readonly queue: QueuedWriteEntry<unknown>[];
	processing: boolean;
	activePromise: Promise<void> | null;
	disposition: CommittedDisposition | null;
	frozenSnapshot: FrozenSafeSnapshot | null;
	barrierStatus: "none" | "draining" | "settled" | "failed";
	barrierFailure: unknown;
	barrierWaiters: Array<{
		readonly resolve: () => void;
		readonly reject: (err: unknown) => void;
	}>;
	quarantinedForDestruction: boolean;
	revisionCounter: number;
	readonly pendingCommands: Map<symbol, PendingCommandRecord>;
}

interface OwnerRuntimeRecord {
	readonly token: OwnerToken;
	readonly activeSubmittedPromises: Set<Promise<void>>;
	readonly drainPromises: Set<Promise<void>>;
	drainSettledPromise: Promise<void> | null;
}

interface VaultScopeRecord {
	readonly app: object;
	readonly owners: Map<symbol, OwnerRuntimeRecord>;
	readonly filesByRef: Map<TFile, FileQueueRecord>;
	readonly filesByPath: Map<string, FileQueueRecord>;
	readonly saveBlockedViews: WeakSet<MarkdownView>;
	readonly destructionTargetFiles: Set<TFile>;
	readonly destructionTargetPaths: Set<string>;
	destructionGeneration: number;
	activeDestructionPromise: Promise<void> | null;
}

interface PrototypeChainState {
	readonly targetProto: {
		setViewData: (this: MarkdownView, data: string, clear: boolean) => void;
		getViewData: (this: MarkdownView) => string;
		save: (this: MarkdownView, clear?: boolean) => Promise<void>;
	};
	capturedPredecessors: NativeMethodsSnapshot;
	installedWrappers: NativeMethodsSnapshot | null;
	readonly activeOwnerHandlers: Map<symbol, PrototypeWrapperHandlers>;
	ownerOrder: symbol[];
}

/**
 * Shared coordinator stored at `MarkdownView.prototype[VIEW_LIFECYCLE_SYMBOL]`.
 * Scopes all state by `App` / vault object reference first, then `TFile` object identity.
 * Holds zero cryptographic keys or plaintext caches (except an explicitly authorized
 * committed unprotect disposition during transition bookkeeping).
 */
export class ViewLifecycleCoordinator {
	readonly version = 1 as const;
	private readonly vaultMap = new WeakMap<object, VaultScopeRecord>();
	private readonly activeVaults = new Set<VaultScopeRecord>();
	private prototypeChain: PrototypeChainState | null = null;

	private getOrCreateVaultScope(app: object): VaultScopeRecord {
		let scope = this.vaultMap.get(app);
		if (!scope) {
			scope = {
				app,
				owners: new Map<symbol, OwnerRuntimeRecord>(),
				filesByRef: new Map<TFile, FileQueueRecord>(),
				filesByPath: new Map<string, FileQueueRecord>(),
				saveBlockedViews: new WeakSet<MarkdownView>(),
				destructionTargetFiles: new Set<TFile>(),
				destructionTargetPaths: new Set<string>(),
				destructionGeneration: 0,
				activeDestructionPromise: null,
			};
			this.vaultMap.set(app, scope);
			this.activeVaults.add(scope);
		}
		return scope;
	}

	private getOrCreateFileRecord(scope: VaultScopeRecord, file: TFile): FileQueueRecord {
		let record = scope.filesByRef.get(file);
		if (!record) {
			record = {
				file,
				lastKnownPath: file.path,
				queue: [],
				processing: false,
				activePromise: null,
				disposition: null,
				frozenSnapshot: null,
				barrierStatus: "none",
				barrierFailure: null,
				barrierWaiters: [],
				quarantinedForDestruction: scope.destructionTargetFiles.has(file) || scope.destructionTargetPaths.has(file.path),
				revisionCounter: 0,
				pendingCommands: new Map<symbol, PendingCommandRecord>(),
			};
			scope.filesByRef.set(file, record);
			scope.filesByPath.set(file.path, record);
		} else if (record.lastKnownPath !== file.path) {
			if (scope.filesByPath.get(record.lastKnownPath) === record) {
				scope.filesByPath.delete(record.lastKnownPath);
			}
			record.lastKnownPath = file.path;
			scope.filesByPath.set(file.path, record);
		}
		return record;
	}

	/**
	 * Updates diagnostic path indexing when a `TFile` is renamed in place.
	 * Identity remains anchored to the `TFile` object reference.
	 */
	notifyFileRenamed(app: object, file: TFile, oldPath: string, newPath: string): void {
		const scope = this.vaultMap.get(app);
		if (!scope) return;
		const record = scope.filesByRef.get(file);
		if (record) {
			if (scope.filesByPath.get(oldPath) === record) {
				scope.filesByPath.delete(oldPath);
			}
			record.lastKnownPath = newPath;
			scope.filesByPath.set(newPath, record);
		}
	}

	/**
	 * Registers a new plugin instance owner in the `active` phase.
	 */
	registerOwner(app: object, label = "veneer-owner"): OwnerToken {
		const scope = this.getOrCreateVaultScope(app);
		const token: OwnerToken = {
			id: Symbol(label),
			label,
			phase: "active",
			killEpoch: 0,
		};
		scope.owners.set(token.id, {
			token,
			activeSubmittedPromises: new Set<Promise<void>>(),
			drainPromises: new Set<Promise<void>>(),
			drainSettledPromise: null,
		});
		return token;
	}

	/**
	 * Returns the current phase of `owner` (`"active"`, `"retiring"`, or `"retired"`).
	 */
	getOwnerPhase(owner: OwnerToken): OwnerPhase {
		return owner.phase;
	}

	/**
	 * True only while `owner.phase === "active"`. Normal manager/command APIs
	 * must refuse new work once this returns false.
	 */
	isOwnerActive(owner: OwnerToken | null | undefined): boolean {
		return owner !== null && owner !== undefined && owner.phase === "active";
	}

	/**
	 * Allocates the next monotonic per-file revision number for `file` in `app`.
	 */
	nextFileRevision(app: object, file: TFile): number {
		const scope = this.getOrCreateVaultScope(app);
		const record = this.getOrCreateFileRecord(scope, file);
		record.revisionCounter += 1;
		return record.revisionCounter;
	}

	/**
	 * Reads the current committed disposition for `file`, if any.
	 */
	getCommittedDisposition(app: object, file: TFile): CommittedDisposition | null {
		const scope = this.vaultMap.get(app);
		if (!scope) return null;
		const record = scope.filesByRef.get(file);
		return record?.disposition ?? null;
	}

	/**
	 * Publishes an authoritative committed disposition for `file`.
	 * Rejects stale revisions older than the currently recorded authority unless
	 * the new disposition is `"destroyed"` or `"unprotected"`.
	 */
	publishCommittedDisposition(
		app: object,
		file: TFile,
		disposition: CommittedDisposition,
	): boolean {
		const scope = this.getOrCreateVaultScope(app);
		const record = this.getOrCreateFileRecord(scope, file);
		if (record.disposition !== null) {
			if (record.disposition.kind === "destroyed" && disposition.kind !== "destroyed") {
				return false;
			}
			if (
				disposition.kind === "protected" &&
				record.disposition.kind === "protected" &&
				disposition.revision < record.disposition.revision
			) {
				return false;
			}
		}
		if (disposition.revision > record.revisionCounter) {
			record.revisionCounter = disposition.revision;
		}
		record.disposition = disposition;
		if (disposition.kind === "protected" && disposition.payload && disposition.decoyBody !== undefined && disposition.rawSerialized !== undefined) {
			record.frozenSnapshot = {
				file,
				path: file.path,
				revision: disposition.revision,
				decoyBody: disposition.decoyBody,
				payload: disposition.payload,
				rawSerialized: disposition.rawSerialized,
			};
		} else if (disposition.kind === "unprotected" || disposition.kind === "destroyed") {
			record.frozenSnapshot = null;
		}
		return true;
	}

	/**
	 * Freezes a canonical safe snapshot for `file` at retirement (or updates it
	 * if not yet superseded by a newer revision or terminal unprotect/destruction).
	 */
	freezeSafeSnapshot(app: object, snapshot: FrozenSafeSnapshot): boolean {
		const scope = this.getOrCreateVaultScope(app);
		const record = this.getOrCreateFileRecord(scope, snapshot.file);
		if (
			record.disposition?.kind === "unprotected" ||
			record.disposition?.kind === "destroyed" ||
			record.quarantinedForDestruction
		) {
			return false;
		}
		if (record.frozenSnapshot && snapshot.revision < record.frozenSnapshot.revision) {
			return false;
		}
		if (snapshot.revision > record.revisionCounter) {
			record.revisionCounter = snapshot.revision;
		}
		record.frozenSnapshot = snapshot;
		return true;
	}

	/**
	 * Returns the currently frozen safe snapshot for `file`, if any.
	 */
	getFrozenSnapshot(app: object, file: TFile): FrozenSafeSnapshot | null {
		const scope = this.vaultMap.get(app);
		if (!scope) return null;
		return scope.filesByRef.get(file)?.frozenSnapshot ?? null;
	}

	/**
	 * Marks a view as save-blocked because synchronous native hydration failed
	 * and its editor/backing state could not be proven safe (Clause 5).
	 */
	markViewSaveBlocked(app: object, view: MarkdownView): void {
		const scope = this.getOrCreateVaultScope(app);
		scope.saveBlockedViews.add(view);
	}

	/**
	 * Clears the save-blocked flag on a view once it has been safely hydrated.
	 */
	clearViewSaveBlocked(app: object, view: MarkdownView): void {
		const scope = this.vaultMap.get(app);
		scope?.saveBlockedViews.delete(view);
	}

	/**
	 * True if `view` failed synchronous sanitization and must not be allowed to
	 * persist raw editor state through native save.
	 */
	isViewSaveBlocked(app: object, view: MarkdownView): boolean {
		const scope = this.vaultMap.get(app);
		return scope ? scope.saveBlockedViews.has(view) : false;
	}

	/**
	 * Begins tracking a command flow (`unprotect`, `password`, `refresh`, `protect`)
	 * so retirement knows whether its host write was already submitted.
	 */
	beginCommand(
		app: object,
		owner: OwnerToken,
		file: TFile,
		kind: PendingCommandKind,
	): symbol | null {
		if (!this.isOwnerActive(owner)) return null;
		const scope = this.getOrCreateVaultScope(app);
		const record = this.getOrCreateFileRecord(scope, file);
		const commandId = Symbol(`cmd:${kind}:${file.path}`);
		record.pendingCommands.set(commandId, {
			commandId,
			kind,
			owner,
			file,
			path: file.path,
			submitted: false,
			settled: false,
		});
		return commandId;
	}

	/**
	 * Inspects a tracked command record.
	 */
	getCommandRecord(
		app: object,
		file: TFile,
		commandId: symbol,
	): Readonly<PendingCommandRecord> | null {
		const scope = this.vaultMap.get(app);
		if (!scope) return null;
		return scope.filesByRef.get(file)?.pendingCommands.get(commandId) ?? null;
	}

	/**
	 * Completes or cancels a tracked command record.
	 */
	finishCommand(app: object, file: TFile, commandId: symbol): void {
		const scope = this.vaultMap.get(app);
		if (!scope) return;
		const record = scope.filesByRef.get(file);
		if (!record) return;
		const cmd = record.pendingCommands.get(commandId);
		if (cmd) {
			cmd.settled = true;
			record.pendingCommands.delete(commandId);
		}
		this.pruneIfIdle(scope, record);
	}

	/**
	 * Enqueues a single host write transaction for `file` (Clause 3).
	 *
	 * - Admits each host write at most once.
	 * - Verifies permission both at admission and when dequeuing to execute.
	 * - Serializes per-file mutations across panes and plugin instances.
	 * - Reports `{ status: "committed", value }` or `{ status: "declined" }` explicitly.
	 * - Rejects if the submitted `task()` or `onCommitted()` throws/rejects.
	 */
	enqueueFileWrite<T = void>(
		app: object,
		options: EnqueueFileWriteOptions<T>,
	): Promise<WriteAdmissionResult<T>> {
		const scope = this.getOrCreateVaultScope(app);
		const record = this.getOrCreateFileRecord(scope, options.file);
		const enqueuedDestructionGen =
			options.destructionGeneration ?? scope.destructionGeneration;

		if (!this.canAdmitAtEnqueue(scope, record, options, enqueuedDestructionGen)) {
			return Promise.resolve({ status: "declined" });
		}

		return new Promise<WriteAdmissionResult<T>>((resolve, reject) => {
			const entry: QueuedWriteEntry<T> = {
				file: options.file,
				path: options.file.path,
				owner: options.owner,
				epoch: options.epoch,
				kind: options.kind,
				enqueuedDestructionGen,
				commandId: options.commandId,
				task: options.task,
				onCommitted: options.onCommitted,
				dispositionOnCommit: options.dispositionOnCommit,
				submitted: false,
				cancelledBeforeSubmit: false,
				resolve,
				reject,
			};
			record.queue.push(entry as QueuedWriteEntry<unknown>);
			this.pumpFileQueue(scope, record);
		});
	}

	/**
	 * Enqueues a destruction write by path when no `TFile` instance is held
	 * (e.g., `deleteStealth` adapter removal). If a `FileQueueRecord` is known for
	 * `path`, serializes behind its active write; otherwise executes under the
	 * vault-level destruction barrier.
	 */
	async runDestructionPathWrite<T = void>(
		app: object,
		path: string,
		task: () => Promise<T>,
		destructionGeneration?: number,
	): Promise<WriteAdmissionResult<T>> {
		const scope = this.getOrCreateVaultScope(app);
		const expectedGen = destructionGeneration ?? scope.destructionGeneration;
		if (expectedGen !== scope.destructionGeneration) {
			return { status: "declined" };
		}
		const existingRecord = scope.filesByPath.get(path);
		if (existingRecord) {
			return this.enqueueFileWrite(app, {
				file: existingRecord.file,
				owner: null,
				kind: "destruction",
				destructionGeneration: expectedGen,
				task,
				dispositionOnCommit: {
					kind: "destroyed",
					revision: existingRecord.revisionCounter + 1,
				},
			});
		}
		if (expectedGen !== scope.destructionGeneration) {
			return { status: "declined" };
		}
		const value = await task();
		return { status: "committed", value };
	}

	private canAdmitAtEnqueue<T>(
		scope: VaultScopeRecord,
		record: FileQueueRecord,
		options: EnqueueFileWriteOptions<T>,
		enqueuedDestructionGen: number,
	): boolean {
		if (options.kind === "destruction") {
			return enqueuedDestructionGen === scope.destructionGeneration;
		}
		if (enqueuedDestructionGen !== scope.destructionGeneration) {
			return false;
		}
		if (
			record.quarantinedForDestruction ||
			scope.destructionTargetFiles.has(options.file) ||
			scope.destructionTargetPaths.has(options.file.path)
		) {
			return false;
		}
		if (record.disposition?.kind === "destroyed") {
			return false;
		}
		if (options.kind === "normal") {
			if (!options.owner || options.owner.phase !== "active") {
				return false;
			}
			if (options.epoch !== undefined && options.epoch !== options.owner.killEpoch) {
				return false;
			}
			if (options.commandId !== undefined) {
				const cmd = record.pendingCommands.get(options.commandId);
				if (cmd && cmd.settled) {
					return false;
				}
			}
		} else if (options.kind === "retirement-commit") {
			if (record.disposition?.kind === "unprotected") {
				return false;
			}
			if (options.owner && options.owner.phase === "retired") {
				return false;
			}
		} else if (options.kind === "native-save-guard") {
			if (record.barrierStatus === "failed") {
				return false;
			}
		}
		return true;
	}

	private canExecuteAtDequeue(
		scope: VaultScopeRecord,
		record: FileQueueRecord,
		entry: QueuedWriteEntry<unknown>,
	): boolean {
		if (entry.cancelledBeforeSubmit) {
			return false;
		}
		if (entry.kind === "destruction") {
			return entry.enqueuedDestructionGen === scope.destructionGeneration;
		}
		if (entry.enqueuedDestructionGen !== scope.destructionGeneration) {
			return false;
		}
		if (
			record.quarantinedForDestruction ||
			scope.destructionTargetFiles.has(entry.file) ||
			scope.destructionTargetPaths.has(entry.file.path) ||
			scope.destructionTargetPaths.has(entry.path)
		) {
			return false;
		}
		if (record.disposition?.kind === "destroyed") {
			return false;
		}
		if (entry.kind === "normal") {
			if (!entry.owner || entry.owner.phase !== "active") {
				return false;
			}
			if (entry.epoch !== undefined && entry.epoch !== entry.owner.killEpoch) {
				return false;
			}
		} else if (entry.kind === "retirement-commit") {
			if (record.disposition?.kind === "unprotected") {
				return false;
			}
		} else if (entry.kind === "native-save-guard") {
			if (record.barrierStatus === "failed") {
				return false;
			}
		}
		return true;
	}

	private pumpFileQueue(scope: VaultScopeRecord, record: FileQueueRecord): void {
		if (record.processing) return;
		record.processing = true;

		const step = (): void => {
			const next = record.queue.shift();
			if (!next) {
				record.processing = false;
				record.activePromise = null;
				this.pruneIfIdle(scope, record);
				return;
			}

			if (!this.canExecuteAtDequeue(scope, record, next)) {
				next.resolve({ status: "declined" });
				step();
				return;
			}

			next.submitted = true;
			if (next.commandId !== undefined) {
				const cmd = record.pendingCommands.get(next.commandId);
				if (cmd) {
					cmd.submitted = true;
				}
			}

			const ownerRuntime = next.owner ? scope.owners.get(next.owner.id) : undefined;

			const runPromise = (async (): Promise<void> => {
				try {
					const value = await next.task();
					if (next.dispositionOnCommit) {
						this.publishCommittedDisposition(scope.app, record.file, next.dispositionOnCommit);
					}
					if (next.onCommitted) {
						await next.onCommitted(value);
					}
					next.resolve({ status: "committed", value });
				} catch (error) {
					next.reject(error);
				}
			})();

			const settledShadow = runPromise.then(
				() => undefined,
				() => undefined,
			);
			record.activePromise = settledShadow;
			if (ownerRuntime) {
				ownerRuntime.activeSubmittedPromises.add(settledShadow);
			}

			void settledShadow.finally(() => {
				if (ownerRuntime) {
					ownerRuntime.activeSubmittedPromises.delete(settledShadow);
				}
				step();
			});
		};

		step();
	}

	/**
	 * Transitions `owner` to `"retiring"` synchronously BEFORE any callbacks or I/O
	 * can start, cancels non-submitted normal queued writes for `owner`, and optionally
	 * queues keyless retirement commits for frozen snapshots (Clauses 1, 6, 7).
	 *
	 * Idempotent: calling `beginRetirement` multiple times for the same `owner`
	 * returns the same drain settlement promise without queueing duplicate writes.
	 */
	beginRetirement(
		app: object,
		owner: OwnerToken,
		retirementSpecs: readonly KeylessRetirementSpec[] = [],
	): Promise<void> {
		const scope = this.getOrCreateVaultScope(app);
		let ownerRuntime = scope.owners.get(owner.id);
		if (!ownerRuntime) {
			ownerRuntime = {
				token: owner,
				activeSubmittedPromises: new Set<Promise<void>>(),
				drainPromises: new Set<Promise<void>>(),
				drainSettledPromise: null,
			};
			scope.owners.set(owner.id, ownerRuntime);
		}

		if (owner.phase === "active") {
			owner.phase = "retiring";
		} else if (ownerRuntime.drainSettledPromise !== null) {
			return ownerRuntime.drainSettledPromise;
		}

		// Cancel any queued-but-unsubmitted normal writes and unsubmitted commands for this owner
		for (const record of scope.filesByRef.values()) {
			for (const entry of record.queue) {
				if (entry.owner?.id === owner.id && !entry.submitted && entry.kind === "normal") {
					entry.cancelledBeforeSubmit = true;
				}
			}
			for (const [cmdId, cmd] of record.pendingCommands) {
				if (cmd.owner.id === owner.id && !cmd.submitted) {
					cmd.settled = true;
					record.pendingCommands.delete(cmdId);
				}
			}
		}

		// Register frozen snapshots and optional keyless retirement commits
		for (const spec of retirementSpecs) {
			const record = this.getOrCreateFileRecord(scope, spec.snapshot.file);
			this.freezeSafeSnapshot(app, spec.snapshot);

			const hasSubmittedUnprotect = Array.from(record.pendingCommands.values()).some(
				(cmd) => cmd.kind === "unprotect" && cmd.submitted && !cmd.settled,
			);

			if (
				record.disposition?.kind === "unprotected" ||
				record.disposition?.kind === "destroyed" ||
				record.quarantinedForDestruction
			) {
				continue;
			}

			if (spec.persistTask || record.activePromise !== null || hasSubmittedUnprotect) {
				record.barrierStatus = "draining";
				record.barrierFailure = null;
			}

			if (spec.persistTask) {
				const commitPromise = this.enqueueFileWrite(app, {
					file: spec.snapshot.file,
					owner,
					kind: "retirement-commit",
					task: async () => {
						// Re-verify before persisting: if a preceding submitted unprotect succeeded,
						// do not overwrite the newly unprotected file with ciphertext (Clause 7).
						if (
							record.disposition?.kind === "unprotected" ||
							record.disposition?.kind === "destroyed" ||
							record.quarantinedForDestruction
						) {
							return;
						}
						await spec.persistTask!(spec.snapshot);
					},
					onCommitted: async () => {
						if (
							record.disposition?.kind !== "unprotected" &&
							record.disposition?.kind !== "destroyed"
						) {
							this.publishCommittedDisposition(app, spec.snapshot.file, {
								kind: "protected",
								revision: spec.snapshot.revision,
								decoyBody: spec.snapshot.decoyBody,
								payload: spec.snapshot.payload,
								rawSerialized: spec.snapshot.rawSerialized,
							});
						}
						await spec.onCommitted?.();
					},
				}).then(
					(res) => {
						if (record.barrierStatus === "draining") {
							record.barrierStatus = "settled";
							const waiters = record.barrierWaiters.splice(0);
							for (const w of waiters) w.resolve();
						}
						return res;
					},
					(err) => {
						record.barrierStatus = "failed";
						record.barrierFailure = err;
						const waiters = record.barrierWaiters.splice(0);
						for (const w of waiters) w.reject(err);
						throw err;
					},
				);

				ownerRuntime.drainPromises.add(commitPromise.then(() => undefined));
			} else if (record.activePromise !== null) {
				const activeWait = record.activePromise.then(() => {
					if (record.barrierStatus === "draining") {
						record.barrierStatus = "settled";
						const waiters = record.barrierWaiters.splice(0);
						for (const w of waiters) w.resolve();
					}
				});
				ownerRuntime.drainPromises.add(activeWait);
			}
		}

		const allToWait: Promise<void>[] = [
			...ownerRuntime.activeSubmittedPromises,
			...ownerRuntime.drainPromises,
		];

		const drainSettled = Promise.all(allToWait)
			.then(() => undefined)
			.finally(() => {
				owner.phase = "retired";
				ownerRuntime.activeSubmittedPromises.clear();
				ownerRuntime.drainPromises.clear();
				this.releaseOwnerFromPrototypeIfDrained(owner);
				this.pruneVaultScope(scope);
			});

		ownerRuntime.drainSettledPromise = drainSettled;
		return drainSettled;
	}

	/**
	 * Awaited by a successor plugin instance before reading or attaching protected views
	 * (Clause 2 & Clause 6).
	 *
	 * - Waits for any predecessor owners in `retiring` phase (and their submitted I/O + keyless drains).
	 * - If a file's retirement commit failed, rejects so automatic successor attachment is blocked
	 *   until explicitly surfaced/retried (`clearBarrierFailure`).
	 */
	async predecessorReady(app: object, file?: TFile): Promise<void> {
		const scope = this.vaultMap.get(app);
		if (!scope) return;

		if (scope.activeDestructionPromise !== null) {
			await scope.activeDestructionPromise;
		}

		const retiringDrains: Promise<void>[] = [];
		for (const ownerRuntime of scope.owners.values()) {
			if (ownerRuntime.token.phase === "retiring" && ownerRuntime.drainSettledPromise !== null) {
				retiringDrains.push(ownerRuntime.drainSettledPromise);
			} else if (ownerRuntime.activeSubmittedPromises.size > 0 && ownerRuntime.token.phase !== "active") {
				retiringDrains.push(...ownerRuntime.activeSubmittedPromises);
			}
		}

		if (file) {
			const record = scope.filesByRef.get(file);
			if (record) {
				if (record.barrierStatus === "failed") {
					throw record.barrierFailure ?? new Error(`Retirement barrier failed for ${file.path}`);
				}
				if (record.barrierStatus === "draining") {
					retiringDrains.push(
						new Promise<void>((resolve, reject) => {
							record.barrierWaiters.push({ resolve, reject });
						}),
					);
				}
				if (record.activePromise !== null) {
					retiringDrains.push(record.activePromise);
				}
			}
		} else {
			for (const record of scope.filesByRef.values()) {
				if (record.barrierStatus === "failed") {
					throw record.barrierFailure ?? new Error(`Retirement barrier failed for ${record.lastKnownPath}`);
				}
			}
		}

		if (retiringDrains.length > 0) {
			await Promise.all(retiringDrains);
		}

		if (file) {
			const record = scope.filesByRef.get(file);
			if (record?.barrierStatus === "failed") {
				throw record.barrierFailure ?? new Error(`Retirement barrier failed for ${file.path}`);
			}
		} else {
			for (const record of scope.filesByRef.values()) {
				if (record.barrierStatus === "failed") {
					throw record.barrierFailure ?? new Error(`Retirement barrier failed for ${record.lastKnownPath}`);
				}
			}
		}
	}

	/**
	 * Explicitly clears a failed retirement barrier for `file` so an operator or
	 * explicit retry can proceed (Clause 6: never retry forever automatically).
	 */
	clearBarrierFailure(app: object, file: TFile): void {
		const scope = this.vaultMap.get(app);
		if (!scope) return;
		const record = scope.filesByRef.get(file);
		if (record && record.barrierStatus === "failed") {
			record.barrierStatus = "none";
			record.barrierFailure = null;
		}
	}

	/**
	 * Advances the coordinator's destruction generation BEFORE waiting, invalidates all
	 * non-submitted normal/retirement/native-save jobs across predecessor and current
	 * owners, quarantines target files/paths, and returns a `drain` promise that settles
	 * once every already-submitted host write across all owners has finished (Clause 8).
	 */
	beginDestruction(
		app: object,
		targets: readonly { readonly file?: TFile; readonly path: string }[] = [],
	): {
		readonly generation: number;
		readonly waitActiveWrites: () => Promise<void>;
		readonly releaseQuarantine: (file?: TFile, path?: string) => void;
	} {
		const scope = this.getOrCreateVaultScope(app);
		scope.destructionGeneration += 1;
		const generation = scope.destructionGeneration;

		for (const ownerRuntime of scope.owners.values()) {
			ownerRuntime.token.killEpoch += 1;
		}

		for (const target of targets) {
			scope.destructionTargetPaths.add(target.path);
			if (target.file) {
				scope.destructionTargetFiles.add(target.file);
				const rec = this.getOrCreateFileRecord(scope, target.file);
				rec.quarantinedForDestruction = true;
			}
			const byPath = scope.filesByPath.get(target.path);
			if (byPath) {
				byPath.quarantinedForDestruction = true;
			}
		}

		const activeSubmitted: Promise<void>[] = [];
		for (const ownerRuntime of scope.owners.values()) {
			for (const p of ownerRuntime.activeSubmittedPromises) {
				activeSubmitted.push(p);
			}
		}

		for (const record of scope.filesByRef.values()) {
			if (record.activePromise !== null) {
				activeSubmitted.push(record.activePromise);
			}
			for (const entry of record.queue) {
				if (!entry.submitted && entry.kind !== "destruction") {
					entry.cancelledBeforeSubmit = true;
				}
			}
			if (record.barrierStatus === "draining") {
				record.barrierStatus = "settled";
				const waiters = record.barrierWaiters.splice(0);
				for (const w of waiters) w.resolve();
			}
		}

		const drainPromise = Promise.allSettled(activeSubmitted).then(() => undefined);
		scope.activeDestructionPromise = drainPromise;

		return {
			generation,
			waitActiveWrites: () => drainPromise,
			releaseQuarantine: (file?: TFile, path?: string) => {
				if (file) {
					scope.destructionTargetFiles.delete(file);
					const rec = scope.filesByRef.get(file);
					if (rec) {
						rec.quarantinedForDestruction = false;
						rec.frozenSnapshot = null;
					}
				}
				if (path !== undefined) {
					scope.destructionTargetPaths.delete(path);
					const rec = scope.filesByPath.get(path);
					if (rec) {
						rec.quarantinedForDestruction = false;
						rec.frozenSnapshot = null;
					}
				}
				if (scope.activeDestructionPromise === drainPromise) {
					scope.activeDestructionPromise = null;
				}
			},
		};
	}

	/**
	 * Handles synchronous `setViewData` while a retirement barrier is draining for `file`
	 * (Clause 6).
	 *
	 * - Never returns a Promise.
	 * - Renders the frozen safe snapshot (or committed unprotected plaintext) synchronously
	 *   so a stale disk reload cannot overwrite the safe handoff.
	 * - Schedules `onAfterBarrier` only after the barrier settles, verifying `view.file === file`.
	 */
	handleGuardedSetViewData(options: GuardedNativeSetViewDataOptions): boolean {
		const { app, view, file, clear, rawSetViewData, onAfterBarrier } = options;
		if (!file) return false;
		const scope = this.vaultMap.get(app);
		if (!scope) return false;
		const record = scope.filesByRef.get(file);
		if (!record) return false;

		if (record.disposition?.kind === "unprotected" && record.disposition.plaintextContent !== undefined) {
			rawSetViewData.call(view, record.disposition.plaintextContent, clear);
			(view as unknown as { data: string }).data = record.disposition.plaintextContent;
			return true;
		}

		if (
			(record.barrierStatus === "draining" || record.activePromise !== null) &&
			record.frozenSnapshot !== null
		) {
			const safeRaw = record.frozenSnapshot.rawSerialized;
			rawSetViewData.call(view, safeRaw, clear);
			(view as unknown as { data: string }).data = safeRaw;
			if (onAfterBarrier) {
				if (record.barrierStatus === "draining") {
					record.barrierWaiters.push({
						resolve: () => {
							if ((view as unknown as { file?: TFile | null }).file !== file) return;
							void Promise.resolve(onAfterBarrier(view, file)).catch(() => undefined);
						},
						reject: () => undefined,
					});
				} else if (record.activePromise !== null) {
					void record.activePromise.then(() => {
						if ((view as unknown as { file?: TFile | null }).file !== file) return;
						return onAfterBarrier(view, file);
					}).catch(() => undefined);
				}
			}
			return true;
		}

		return false;
	}

	/**
	 * Enqueues a guarded native save behind any active write or retirement commit for the
	 * view's file (Clauses 6, 7, 8).
	 *
	 * - Captures `file`, `clear`, and safe content at admission time.
	 * - Refuses save if the view was marked save-blocked (Clause 5) or quarantined for
	 *   destruction (Clause 8).
	 * - Skips side effects if the view switched to another file before its turn in the queue.
	 */
	async executeGuardedNativeSave(options: GuardedNativeSaveOptions): Promise<WriteAdmissionResult<void>> {
		const { app, view, clear, rawSave, syncViewData } = options;
		const scope = this.getOrCreateVaultScope(app);

		if (scope.saveBlockedViews.has(view)) {
			throw new Error("Veneer: refusing native save on a view whose sanitization failed");
		}

		const capturedFile = (view as unknown as { file?: TFile | null }).file ?? null;
		if (!capturedFile) {
			await rawSave.call(view, clear);
			return { status: "committed" };
		}

		const record = this.getOrCreateFileRecord(scope, capturedFile);
		if (
			record.quarantinedForDestruction ||
			scope.destructionTargetFiles.has(capturedFile) ||
			scope.destructionTargetPaths.has(capturedFile.path)
		) {
			return { status: "declined" };
		}

		const capturedSnapshot = record.frozenSnapshot;

		return this.enqueueFileWrite(app, {
			file: capturedFile,
			owner: null,
			kind: "native-save-guard",
			task: async () => {
				if ((view as unknown as { file?: TFile | null }).file !== capturedFile) {
					return;
				}
				if (
					record.quarantinedForDestruction ||
					record.disposition?.kind === "destroyed"
				) {
					return;
				}
				if (
					record.disposition?.kind === "unprotected" &&
					record.disposition.plaintextContent !== undefined
				) {
					if (syncViewData) {
						syncViewData(view, record.disposition.plaintextContent);
					} else {
						(view as unknown as { data: string }).data = record.disposition.plaintextContent;
					}
					await rawSave.call(view, clear);
					return;
				}
				const effectiveSafe =
					record.frozenSnapshot?.rawSerialized ?? capturedSnapshot?.rawSerialized;
				if (effectiveSafe !== undefined) {
					if (syncViewData) {
						syncViewData(view, effectiveSafe);
					} else {
						(view as unknown as { data: string }).data = effectiveSafe;
					}
				}
				await rawSave.call(view, clear);
			},
		});
	}

	/**
	 * Installs or adopts shared prototype wrappers on `MarkdownView.prototype` (Clause 9).
	 *
	 * - Multiple reload cycles share one coordinator wrapper layer rather than stacking
	 *   independent queues.
	 * - On cleanup, compares each prototype property with our own installed wrapper before
	 *   restoring the captured predecessor; if an outer third-party plugin wrapped our
	 *   wrapper, we never clobber the outer wrapper and instead become a transparent
	 *   pass-through to the captured predecessor once all owners and guards drain.
	 * - Owner1's delayed drain callback can never uninstall Owner2's active handlers.
	 */
	acquirePrototypeLease(
		owner: OwnerToken,
		handlers: PrototypeWrapperHandlers,
		targetProto: {
			setViewData: (this: MarkdownView, data: string, clear: boolean) => void;
			getViewData: (this: MarkdownView) => string;
			save: (this: MarkdownView, clear?: boolean) => Promise<void>;
		} = MarkdownView.prototype as unknown as {
			setViewData: (this: MarkdownView, data: string, clear: boolean) => void;
			getViewData: (this: MarkdownView) => string;
			save: (this: MarkdownView, clear?: boolean) => Promise<void>;
		},
	): OwnedPrototypeLease {
		let chain = this.prototypeChain;
		if (!chain || chain.targetProto !== targetProto) {
			chain = {
				targetProto,
				capturedPredecessors: {
					setViewData: targetProto.setViewData,
					getViewData: targetProto.getViewData,
					save: targetProto.save,
				},
				installedWrappers: null,
				activeOwnerHandlers: new Map<symbol, PrototypeWrapperHandlers>(),
				ownerOrder: [],
			};
			this.prototypeChain = chain;
		} else if (chain.installedWrappers === null) {
			chain.capturedPredecessors = {
				setViewData: targetProto.setViewData,
				getViewData: targetProto.getViewData,
				save: targetProto.save,
			};
		} else {
			// If prototype was externally replaced since our wrapper was installed, update predecessor
			if (
				targetProto.setViewData !== chain.installedWrappers.setViewData &&
				chain.activeOwnerHandlers.size === 0
			) {
				chain.capturedPredecessors = {
					setViewData: targetProto.setViewData,
					getViewData: targetProto.getViewData,
					save: targetProto.save,
				};
				chain.installedWrappers = null;
			}
		}

		chain.activeOwnerHandlers.set(owner.id, handlers);
		chain.ownerOrder = chain.ownerOrder.filter((id) => id !== owner.id);
		chain.ownerOrder.push(owner.id);

		if (chain.installedWrappers === null) {
			const currentChain = chain;
			const resolveCurrentHandler = (): PrototypeWrapperHandlers | null => {
				for (let i = currentChain.ownerOrder.length - 1; i >= 0; i -= 1) {
					const id = currentChain.ownerOrder[i];
					if (id !== undefined) {
						const h = currentChain.activeOwnerHandlers.get(id);
						if (h) return h;
					}
				}
				return null;
			};

			const setViewDataWrapper = function (
				this: MarkdownView,
				data: string,
				clear: boolean,
			): void {
				const h = resolveCurrentHandler();
				if (h) {
					h.setViewData.call(this, data, clear);
					return;
				}
				currentChain.capturedPredecessors.setViewData.call(this, data, clear);
			};

			const getViewDataWrapper = function (this: MarkdownView): string {
				const h = resolveCurrentHandler();
				if (h) {
					return h.getViewData.call(this);
				}
				return currentChain.capturedPredecessors.getViewData.call(this);
			};

			const saveWrapper = function (
				this: MarkdownView,
				clear?: boolean,
			): Promise<void> {
				const h = resolveCurrentHandler();
				if (h) {
					return h.save.call(this, clear);
				}
				return Promise.resolve(currentChain.capturedPredecessors.save.call(this, clear));
			};

			currentChain.installedWrappers = {
				setViewData: setViewDataWrapper,
				getViewData: getViewDataWrapper,
				save: saveWrapper,
			};

			targetProto.setViewData = setViewDataWrapper;
			targetProto.getViewData = getViewDataWrapper;
			targetProto.save = saveWrapper;
		}

		const currentChainRef = chain;
		return {
			owner,
			baseOriginals: currentChainRef.capturedPredecessors,
			isTopMostOnPrototype: () => {
				const w = currentChainRef.installedWrappers;
				if (!w) return false;
				return (
					targetProto.setViewData === w.setViewData &&
					targetProto.getViewData === w.getViewData &&
					targetProto.save === w.save
				);
			},
			releaseOwnerHandlers: () => {
				currentChainRef.activeOwnerHandlers.delete(owner.id);
				currentChainRef.ownerOrder = currentChainRef.ownerOrder.filter(
					(id) => id !== owner.id,
				);
				return this.tryRestorePrototypeAndSymbol();
			},
		};
	}

	private releaseOwnerFromPrototypeIfDrained(owner: OwnerToken): void {
		if (!this.prototypeChain) return;
		this.prototypeChain.activeOwnerHandlers.delete(owner.id);
		this.prototypeChain.ownerOrder = this.prototypeChain.ownerOrder.filter(
			(id) => id !== owner.id,
		);
		this.tryRestorePrototypeAndSymbol();
	}

	/**
	 * Restores owned prototype properties and releases the symbol anchor ONLY when no
	 * active/retiring owner, pending queue entry, or active write tail remains.
	 * Compares each prototype property individually against our own installed wrapper
	 * so an external outer wrapper is never overwritten (Clause 9).
	 */
	tryRestorePrototypeAndSymbol(): boolean {
		if (!this.isCompletelyDrained()) {
			return false;
		}
		let allPrototypePropertiesRestored = true;
		const chain = this.prototypeChain;
		if (chain && chain.installedWrappers !== null) {
			const { targetProto, installedWrappers, capturedPredecessors } = chain;
			if (targetProto.setViewData === installedWrappers.setViewData) {
				targetProto.setViewData = capturedPredecessors.setViewData;
			}
			if (targetProto.getViewData === installedWrappers.getViewData) {
				targetProto.getViewData = capturedPredecessors.getViewData;
			}
			if (targetProto.save === installedWrappers.save) {
				targetProto.save = capturedPredecessors.save;
			}
			if (
				targetProto.setViewData === capturedPredecessors.setViewData &&
				targetProto.getViewData === capturedPredecessors.getViewData &&
				targetProto.save === capturedPredecessors.save
			) {
				chain.installedWrappers = null;
				this.prototypeChain = null;
				allPrototypePropertiesRestored = true;
			} else {
				allPrototypePropertiesRestored = false;
			}
		}
		const holder = MarkdownView.prototype as unknown as Record<symbol, unknown>;
		if (allPrototypePropertiesRestored && holder[VIEW_LIFECYCLE_SYMBOL] === this) {
			delete holder[VIEW_LIFECYCLE_SYMBOL];
		}
		return allPrototypePropertiesRestored;
	}

	/**
	 * True when no active/retiring owners, active writes, queued items, or active prototype
	 * handlers remain across any vault scope.
	 */
	isCompletelyDrained(): boolean {
		if (this.prototypeChain && this.prototypeChain.activeOwnerHandlers.size > 0) {
			return false;
		}
		for (const scope of this.activeVaults) {
			if (scope.activeDestructionPromise !== null) return false;
			for (const ownerRuntime of scope.owners.values()) {
				if (ownerRuntime.token.phase !== "retired") return false;
				if (ownerRuntime.activeSubmittedPromises.size > 0) return false;
				if (ownerRuntime.drainPromises.size > 0) return false;
			}
			for (const record of scope.filesByRef.values()) {
				if (record.processing || record.activePromise !== null || record.queue.length > 0) {
					return false;
				}
				if (record.barrierStatus === "draining" || record.barrierStatus === "failed") {
					return false;
				}
			}
		}
		return true;
	}

	private pruneIfIdle(scope: VaultScopeRecord, record: FileQueueRecord): void {
		if (
			!record.processing &&
			record.activePromise === null &&
			record.queue.length === 0 &&
			record.pendingCommands.size === 0 &&
			record.barrierStatus !== "draining" &&
			record.barrierStatus !== "failed" &&
			!record.quarantinedForDestruction &&
			record.disposition === null &&
			record.frozenSnapshot === null
		) {
			scope.filesByRef.delete(record.file);
			if (scope.filesByPath.get(record.lastKnownPath) === record) {
				scope.filesByPath.delete(record.lastKnownPath);
			}
		}
	}

	private pruneVaultScope(scope: VaultScopeRecord): void {
		for (const [id, ownerRuntime] of scope.owners) {
			if (
				ownerRuntime.token.phase === "retired" &&
				ownerRuntime.activeSubmittedPromises.size === 0 &&
				ownerRuntime.drainPromises.size === 0
			) {
				scope.owners.delete(id);
			}
		}
		for (const record of [...scope.filesByRef.values()]) {
			this.pruneIfIdle(scope, record);
		}
		if (
			scope.owners.size === 0 &&
			scope.filesByRef.size === 0 &&
			scope.activeDestructionPromise === null
		) {
			this.activeVaults.delete(scope);
		}
	}

	/**
	 * Clears settled file dispositions and snapshots for `app` once no active or retiring
	 * owners remain, allowing the coordinator to release all references.
	 */
	clearSettledVaultState(app: object): void {
		const scope = this.vaultMap.get(app);
		if (!scope) return;
		for (const record of [...scope.filesByRef.values()]) {
			if (
				!record.processing &&
				record.activePromise === null &&
				record.queue.length === 0 &&
				record.barrierStatus !== "draining"
			) {
				record.disposition = null;
				record.frozenSnapshot = null;
				record.barrierStatus = "none";
				record.barrierFailure = null;
				record.quarantinedForDestruction = false;
				this.pruneIfIdle(scope, record);
			}
		}
		scope.destructionTargetFiles.clear();
		scope.destructionTargetPaths.clear();
		this.pruneVaultScope(scope);
		this.tryRestorePrototypeAndSymbol();
	}
}

/**
 * Discovers or initializes the shared `ViewLifecycleCoordinator` anchored on
 * `MarkdownView.prototype[Symbol.for('veneer.viewLifecycle.v1')]` (Clause 2).
 */
export function getSharedLifecycleCoordinator(
	targetProto: object = MarkdownView.prototype,
): ViewLifecycleCoordinator {
	const holder = targetProto as Record<symbol, unknown>;
	const existing = holder[VIEW_LIFECYCLE_SYMBOL];
	if (existing instanceof ViewLifecycleCoordinator) {
		return existing;
	}
	if (
		typeof existing === "object" &&
		existing !== null &&
		(existing as { version?: unknown }).version === 1 &&
		typeof (existing as { enqueueFileWrite?: unknown }).enqueueFileWrite === "function"
	) {
		return existing as ViewLifecycleCoordinator;
	}
	const created = new ViewLifecycleCoordinator();
	Object.defineProperty(holder, VIEW_LIFECYCLE_SYMBOL, {
		value: created,
		writable: true,
		configurable: true,
		enumerable: false,
	});
	return created;
}

/**
 * Peek at the currently anchored coordinator on `MarkdownView.prototype` without
 * allocating a new one if absent.
 */
export function peekSharedLifecycleCoordinator(
	targetProto: object = MarkdownView.prototype,
): ViewLifecycleCoordinator | null {
	const holder = targetProto as Record<symbol, unknown>;
	const existing = holder[VIEW_LIFECYCLE_SYMBOL];
	if (existing instanceof ViewLifecycleCoordinator) {
		return existing;
	}
	if (
		typeof existing === "object" &&
		existing !== null &&
		(existing as { version?: unknown }).version === 1 &&
		typeof (existing as { enqueueFileWrite?: unknown }).enqueueFileWrite === "function"
	) {
		return existing as ViewLifecycleCoordinator;
	}
	return null;
}

export type VaultIdentity = App | object;
