import { MarkdownView, type TFile } from "obsidian";
import { parseFileContent, stripDraftCacheBlocks } from "../crypto/payload";
import type { OwnedPrototypeLease } from "./lifecycle";
import { computeSavedContent } from "./saveDecision";
import type { SessionManager, ShutdownHandoffResult } from "./session";

export interface ViewPatchController {
	readonly lease: OwnedPrototypeLease;
	readonly retireAndHandoff: () => ShutdownHandoffResult;
	readonly drainPromise: () => Promise<void>;
	readonly isRetired: () => boolean;
}

/**
 * MarkdownView prototype interception (§5 / Issue #13). Three methods, one invariant:
 * disk only ever holds decoy + ciphertext.
 *
 * - setViewData: a file carrying a payload loads as its decoy only; the
 *   payload comment never enters the editor document. While a retirement barrier
 *   or frozen handoff is active, synchronous stale disk reloads render the safe
 *   snapshot instead of overwriting it.
 * - getViewData: always returns decoy + (pending or original) ciphertext while active,
 *   or the frozen safe serialization while retired/draining.
 * - save: syncs this.data through the patched getViewData before delegating,
 *   routing through the shared lifecycle coordinator across active and retiring states.
 */
export function installViewPatches(
	sessions: SessionManager,
	registerCleanup: (cleanup: () => void) => void,
): ViewPatchController {
	const coordinator = sessions.getCoordinator();
	const owner = sessions.getOwnerToken();
	const app = sessions.getApp();

	let retired = false;
	let drainSettledPromise: Promise<void> = Promise.resolve();

	let lease!: OwnedPrototypeLease;

	/**
	 * Reloads and re-attaches a view from disk once an in-flight retirement barrier settles.
	 */
	const refreshAfterBarrier = async (view: MarkdownView, file: TFile): Promise<void> => {
		if (sessions.isDisposed() || !coordinator.isOwnerActive(owner)) return;
		if (view.file !== file) return;
		try {
			const raw = await app.vault.cachedRead(file);
			if (sessions.isDisposed() || !coordinator.isOwnerActive(owner)) return;
			if (view.file !== file) return;
			const parsed = parseFileContent(raw);
			if (parsed) {
				sessions.attachFromLoad(view, file, parsed);
				lease.baseOriginals.setViewData.call(view, parsed.decoyBody, true);
			}
		} catch {
			return;
		}
	};

	/**
	 * Intercepts `MarkdownView.prototype.setViewData` to strip payload comments on load,
	 * attach protected sessions, and guard against stale disk reloads during barrier drain.
	 */
	const setViewDataHandler = function (
		this: MarkdownView,
		data: string,
		clear: boolean,
	): void {
		const rawSet = lease.baseOriginals.setViewData;
		const file = this.file ?? null;

		if (
			(sessions.isDisposed() ||
				!coordinator.isOwnerActive(owner) ||
				(file !== null && coordinator.getFrozenSnapshot(app, file) !== null)) &&
			coordinator.handleGuardedSetViewData({
				app,
				view: this,
				file,
				incomingData: data,
				clear,
				rawSetViewData: rawSet,
				onAfterBarrier: (v, f) => refreshAfterBarrier(v, f),
			})
		) {
			return;
		}

		if (sessions.isDisposed() || !coordinator.isOwnerActive(owner)) {
			rawSet.call(this, data, clear);
			return;
		}

		const parsed = parseFileContent(data);
		if (parsed) {
			if (this.file) {
				const existing = sessions.get(this);
				if (
					existing &&
					existing.file === this.file &&
					existing.state === "unlocked" &&
					existing.lockingPromise === null &&
					(parsed.payload.cipher.nonce === existing.originalPayload.cipher.nonce ||
						parsed.payload.cipher.nonce === existing.pendingPayload?.cipher.nonce)
				) {
					existing.decoyBody = parsed.decoyBody;
					existing.originalPayload = parsed.payload;
					sessions.rememberDecoy(this.file.path, parsed.decoyBody);
					return;
				}
				sessions.attachFromLoad(this, this.file, parsed);
			}
			rawSet.call(this, parsed.decoyBody, clear);
			return;
		}
		const existing = sessions.get(this);
		if (existing && this.file !== existing.file) {
			sessions.detach(this);
		}
		rawSet.call(this, stripDraftCacheBlocks(data), clear);
	};

	/**
	 * Intercepts `MarkdownView.prototype.getViewData` so protected views always serialize
	 * decoy + ciphertext while active or retiring.
	 */
	const getViewDataHandler = function (this: MarkdownView): string {
		const rawGet = lease.baseOriginals.getViewData;
		const session = sessions.get(this);
		if (session && this.file === session.file && !sessions.isDisposed()) {
			const editorValue = this.editor ? this.editor.getValue() : session.decoyBody;
			return computeSavedContent({
				unlocked: session.state === "unlocked",
				editorValue,
				decoyBody: session.decoyBody,
				originalPayload: session.originalPayload,
				pendingPayload: session.pendingPayload,
			});
		}

		const rawEditorValue = rawGet.call(this);
		const guardedContent = coordinator.getGuardEffectiveContent(
			app,
			this.file ?? null,
			rawEditorValue,
		);
		if (guardedContent !== null) {
			return guardedContent;
		}
		return rawEditorValue;
	};

	/**
	 * Intercepts `MarkdownView.prototype.save` to serialize active session writes and
	 * route detached protected or transitioning saves through the lifecycle coordinator.
	 */
	const saveHandler = async function (this: MarkdownView, clear?: boolean): Promise<void> {
		const rawSave = lease.baseOriginals.save;

		if (coordinator.isViewSaveBlocked(app, this)) {
			throw new Error("Veneer: refusing native save on a view whose sanitization failed");
		}

		const session = sessions.get(this);
		if (session && this.file === session.file && !sessions.isDisposed()) {
			if (sessions.isPathReserved(session.file.path)) {
				sessions.deferSave(session.file.path, () => {
					if (this.file !== session.file) return;
					const stillAttached = sessions.get(this) === session && this.file === session.file;
					if (stillAttached) {
						void this.save(clear).catch((error) => {
							console.warn("Veneer: deferred save after reservation failed", error);
						});
						return;
					}
					this.data = this.getViewData();
					void Promise.resolve(rawSave.call(this, clear)).catch((error) => {
						console.warn("Veneer: deferred save after reservation failed", error);
					});
				});
				return;
			}
			await sessions.enqueueWrite(session, async () => {
				const stillActive = sessions.get(this) === session && this.file === session.file;
				const persisted = stillActive ? sessions.savedPayloadFor(session) : null;
				if (stillActive) {
					this.data = this.getViewData();
				}
				await rawSave.call(this, clear);
				if (stillActive && persisted) {
					await sessions.commitPersistedPayload(session, persisted);
				}
			});
			return;
		}

		const currentFile = this.file ?? null;
		if (
			currentFile &&
			(coordinator.shouldGuardDetachedSave(app, currentFile) ||
				((retired || sessions.isDisposed()) &&
					coordinator.getFrozenSnapshot(app, currentFile) !== null))
		) {
			await coordinator.executeGuardedNativeSave({
				app,
				view: this,
				clear,
				rawSave,
				syncViewData: (targetView, safeContent) => {
					(targetView as unknown as { data: string }).data = safeContent;
					if (
						targetView.editor &&
						typeof targetView.editor.getValue === "function" &&
						targetView.editor.getValue() !== safeContent &&
						typeof targetView.editor.setValue === "function"
					) {
						targetView.editor.setValue(safeContent);
					}
				},
			});
			return;
		}

		await rawSave.call(this, clear);
	};

	lease = coordinator.acquirePrototypeLease(owner, {
		setViewData: setViewDataHandler,
		getViewData: getViewDataHandler,
		save: saveHandler,
	});

	sessions.setCapturedNativeSetViewData(lease.baseOriginals.setViewData);

	/**
	 * Performs synchronous view sanitization and owner retirement handoff on plugin unload.
	 */
	const retireAndHandoff = (): ShutdownHandoffResult => {
		const handoff = sessions.shutdownAndHandoff(lease.baseOriginals.setViewData);
		if (!retired) {
			retired = true;
			const rawDrain = coordinator.beginRetirement(app, owner, handoff.retirementSpecs);
			const observed = rawDrain.finally(() => {
				if (!coordinator.hasRetainedGuards(app)) {
					lease.releaseOwnerHandlers();
				}
			});
			void observed.catch((error) => {
				console.warn("Veneer: retirement drain failed", error);
			});
			drainSettledPromise = observed;
		}
		if (!coordinator.hasRetainedGuards(app) && coordinator.isCompletelyDrained()) {
			lease.releaseOwnerHandlers();
		}
		return handoff;
	};

	registerCleanup(() => {
		retireAndHandoff();
	});

	return {
		lease,
		retireAndHandoff,
		drainPromise: () => drainSettledPromise,
		isRetired: () => retired,
	};
}
