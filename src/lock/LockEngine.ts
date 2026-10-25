import { MarkdownView, type Plugin, type Workspace } from "obsidian";
import type { SessionManager } from "../view/session";
import type { VeneerSettings } from "../settings";
import { ClipboardGuard } from "./clipboard";
import { setContentProtection, wirePowerMonitor } from "./power";

/** Minimum interval in milliseconds between DOM activity idle-timer resets. */
export const ACTIVITY_THROTTLE_MS = 1000;

/**
 * The mask triggers of §7: idle timer, window blur, tab switch, layout change,
 * OS power events, panic chord. Every trigger funnels into lockAll or selective
 * inactive locking; any locked session has its keys zeroed and clipboard cleared if tainted.
 */
export class LockEngine {
	private idleTimer: ReturnType<typeof window.setTimeout> | number | null = null;
	private removePowerListener: (() => void) | null = null;
	private stopped = false;
	private lastActivityRearmAt = 0;
	private lastActivityAt = 0;
	readonly clipboard = new ClipboardGuard();

	/** Creates a `LockEngine` governing automatic masking triggers and clipboard protection for `sessions`. */
	constructor(
		private readonly plugin: Plugin,
		private readonly workspace: Workspace,
		private readonly sessions: SessionManager,
		private readonly settings: () => VeneerSettings,
	) {}

	/** Returns true once this lock engine has been stopped or its session manager is disposed. */
	isStopped(): boolean {
		return this.stopped || this.sessions.isDisposed();
	}

	/** Registers DOM/workspace mask listeners, power monitoring, and the initial idle timer. */
	start(): void {
		if (this.sessions.isDisposed()) return;
		this.stopped = false;
		const activity = (): void => {
			if (this.isStopped()) return;
			if (!this.sessions.all().some((s) => s.state === "unlocked")) {
				if (this.idleTimer !== null) {
					window.clearTimeout(this.idleTimer);
					this.idleTimer = null;
				}
				this.lastActivityRearmAt = 0;
				this.lastActivityAt = 0;
				return;
			}
			const now = Date.now();
			this.lastActivityAt = now;
			if (
				this.idleTimer !== null &&
				this.lastActivityRearmAt > 0 &&
				now >= this.lastActivityRearmAt &&
				now - this.lastActivityRearmAt < ACTIVITY_THROTTLE_MS
			) {
				return;
			}
			this.lastActivityRearmAt = now;
			this.armIdleTimer();
		};
		for (const event of ["keydown", "mousedown", "wheel", "touchstart"] as const) {
			this.plugin.registerDomEvent(window, event, activity, { capture: true, passive: true });
		}
		this.plugin.registerDomEvent(window, "blur", () => {
			if (this.isStopped()) return;
			void this.maskAll("window-blur");
		});
		this.plugin.registerDomEvent(document, "copy", () => {
			if (this.isStopped()) return;
			if (this.sessions.all().some((s) => s.state === "unlocked")) {
				const selection = window.getSelection()?.toString() ?? "";
				if (selection.length > 0) this.clipboard.markTainted(selection);
			}
		});
		this.plugin.registerDomEvent(document, "visibilitychange", () => {
			if (this.isStopped()) return;
			if (document.visibilityState === "hidden") {
				void this.maskAll("visibility-hidden");
			}
		});
		this.plugin.registerEvent(
			this.workspace.on("active-leaf-change", () => {
				if (this.isStopped()) return;
				void this.maskInactiveSessions("leaf-change");
			}),
		);
		this.plugin.registerEvent(
			this.workspace.on("layout-change", () => {
				if (this.isStopped()) return;
				void this.maskInactiveSessions("layout-change");
			}),
		);
		this.removePowerListener = wirePowerMonitor(() => {
			if (this.isStopped()) return;
			void this.maskAll("power-event");
		});
		this.plugin.register(() => this.stop());
		this.armIdleTimer();
	}

	/** Stops idle timers, removes OS power listeners, and disables OS content protection. */
	stop(): void {
		this.stopped = true;
		if (this.idleTimer !== null) {
			window.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.lastActivityRearmAt = 0;
		this.lastActivityAt = 0;
		this.removePowerListener?.();
		this.removePowerListener = null;
		setContentProtection(false);
	}

	/**
	 * Resets the inactivity countdown timer when at least one session is unlocked,
	 * or clears the timer when all sessions are locked.
	 */
	armIdleTimer(): void {
		if (this.isStopped()) return;
		if (this.idleTimer !== null) {
			window.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		const anyUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		if (!anyUnlocked) {
			this.lastActivityRearmAt = 0;
			this.lastActivityAt = 0;
			return;
		}
		const now = Date.now();
		this.lastActivityRearmAt = now;
		this.lastActivityAt = now;
		const timeoutMs = Math.max(15, this.settings().idleTimeoutSec) * 1000;
		const scheduleRemaining = (delayMs: number): void => {
			this.idleTimer = window.setTimeout(() => {
				this.idleTimer = null;
				if (this.isStopped()) return;
				if (!this.sessions.all().some((s) => s.state === "unlocked")) {
					this.lastActivityRearmAt = 0;
					this.lastActivityAt = 0;
					return;
				}
				const currentTimeoutMs = Math.max(15, this.settings().idleTimeoutSec) * 1000;
				if (this.lastActivityAt > this.lastActivityRearmAt) {
					const elapsed = Date.now() - this.lastActivityAt;
					this.lastActivityRearmAt = this.lastActivityAt;
					if (elapsed >= 0 && elapsed < currentTimeoutMs) {
						scheduleRemaining(currentTimeoutMs - elapsed);
						return;
					}
				}
				void this.maskAll("idle-timeout");
			}, delayMs);
		};
		scheduleRemaining(timeoutMs);
	}

	/**
	 * Masks only unlocked sessions whose `MarkdownView` is no longer the active workspace view
	 * or is no longer attached to the workspace (used on `active-leaf-change` and `layout-change`).
	 */
	async maskInactiveSessions(reason: string): Promise<void> {
		if (this.isStopped()) return;
		const activeView =
			typeof this.workspace.getActiveViewOfType === "function"
				? this.workspace.getActiveViewOfType(MarkdownView)
				: null;
		let attachedViews: Set<unknown> | null = null;
		if (typeof this.workspace.iterateAllLeaves === "function") {
			attachedViews = new Set<unknown>();
			this.workspace.iterateAllLeaves((leaf) => {
				if (leaf && leaf.view) {
					attachedViews!.add(leaf.view);
				}
			});
		}
		const targets = this.sessions.all().filter((session) => {
			if (session.state !== "unlocked") return false;
			const isAttached = attachedViews === null || attachedViews.has(session.view);
			return !isAttached || activeView !== session.view;
		});
		if (targets.length === 0) return;

		const byPath = new Map<string, typeof targets>();
		for (const session of targets) {
			const path = session.file?.path ?? "";
			const group = byPath.get(path) ?? [];
			group.push(session);
			byPath.set(path, group);
		}
		try {
			await Promise.all(
				Array.from(byPath.values()).map(async (group) => {
					for (const session of group) {
						try {
							await this.sessions.lock(session, reason);
						} catch (error) {
							console.warn(`Veneer: maskInactiveSessions (${reason}) encountered an error`, error);
						}
					}
				}),
			);
		} catch (error) {
			console.warn(`Veneer: maskInactiveSessions (${reason}) encountered an error`, error);
		}
		if (this.isStopped()) return;
		this.applyContentProtection();
		const anyStillUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		if (!anyStillUnlocked && this.settings().clearClipboardOnLock) {
			await this.clipboard.clearIfTainted();
		}
		if (this.isStopped()) return;
		this.applyContentProtection();
		if (!anyStillUnlocked || this.idleTimer === null) {
			this.armIdleTimer();
		}
	}

	/** Masks all unlocked sessions, clears any tainted clipboard content, and updates content protection. */
	async maskAll(reason: string): Promise<void> {
		if (this.isStopped()) return;
		const hadUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		try {
			await this.sessions.lockAll(reason);
		} catch (error) {
			console.warn(`Veneer: maskAll (${reason}) encountered an error`, error);
		}
		if (this.isStopped()) return;
		this.applyContentProtection();
		if (hadUnlocked && this.settings().clearClipboardOnLock) {
			await this.clipboard.clearIfTainted();
		}
		if (this.isStopped()) return;
		this.applyContentProtection();
		this.armIdleTimer();
	}

	/** Panic chord (§7): instant mask of every protected note. */
	panic(): void {
		if (this.isStopped()) return;
		void this.maskAll("panic");
	}

	/** Rearms the idle timer and enables window content protection when a session unlocks. */
	onSessionUnlocked(): void {
		if (this.isStopped()) return;
		const now = Date.now();
		this.lastActivityRearmAt = now;
		this.lastActivityAt = now;
		this.armIdleTimer();
		this.applyContentProtection();
	}

	/** Updates the idle timer, tainted clipboard state, and window content protection when a session locks. */
	onSessionLocked(): void {
		if (this.isStopped()) return;
		const anyUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		if (!anyUnlocked || this.idleTimer === null) {
			this.armIdleTimer();
		}
		this.applyContentProtection();
		if (!anyUnlocked && this.settings().clearClipboardOnLock) {
			void this.clipboard.clearIfTainted();
		}
	}

	/** Synchronizes OS-level screenshot/window capture protection with current session state. */
	applyContentProtection(): void {
		if (this.isStopped()) {
			setContentProtection(false);
			return;
		}
		const anyUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		setContentProtection(this.settings().contentProtection && anyUnlocked);
	}
}
