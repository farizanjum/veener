import type { Plugin, Workspace } from "obsidian";
import type { SessionManager } from "../view/session";
import type { VeneerSettings } from "../settings";
import { ClipboardGuard } from "./clipboard";
import { setContentProtection, wirePowerMonitor } from "./power";

/**
 * The mask triggers of §7: idle timer, window blur, tab switch, layout change,
 * OS power events, panic chord. Every trigger funnels into lockAll; any
 * unlocked session is masked, keys zeroed, clipboard cleared if tainted.
 */
export class LockEngine {
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private removePowerListener: (() => void) | null = null;
	private stopped = false;
	readonly clipboard = new ClipboardGuard();

	constructor(
		private readonly plugin: Plugin,
		private readonly workspace: Workspace,
		private readonly sessions: SessionManager,
		private readonly settings: () => VeneerSettings,
	) {}

	isStopped(): boolean {
		return this.stopped || this.sessions.isDisposed();
	}

	start(): void {
		if (this.sessions.isDisposed()) return;
		this.stopped = false;
		const activity = (): void => {
			if (this.isStopped()) return;
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
		this.plugin.registerEvent(
			this.workspace.on("active-leaf-change", () => {
				if (this.isStopped()) return;
				void this.maskAll("leaf-change");
			}),
		);
		this.plugin.registerEvent(
			this.workspace.on("layout-change", () => {
				if (this.isStopped()) return;
				void this.maskAll("layout-change");
			}),
		);
		this.removePowerListener = wirePowerMonitor(() => {
			if (this.isStopped()) return;
			void this.maskAll("power-event");
		});
		this.plugin.register(() => this.stop());
		this.armIdleTimer();
	}

	stop(): void {
		this.stopped = true;
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.removePowerListener?.();
		this.removePowerListener = null;
		setContentProtection(false);
	}

	armIdleTimer(): void {
		if (this.isStopped()) return;
		if (this.idleTimer !== null) clearTimeout(this.idleTimer);
		const timeoutMs = Math.max(15, this.settings().idleTimeoutSec) * 1000;
		this.idleTimer = setTimeout(() => {
			if (this.isStopped()) return;
			void this.maskAll("idle-timeout");
		}, timeoutMs);
	}

	async maskAll(reason: string): Promise<void> {
		if (this.isStopped()) return;
		const hadUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		try {
			await this.sessions.lockAll(reason);
		} catch (error) {
			console.warn(`Veneer: maskAll (${reason}) encountered an error`, error);
		}
		if (hadUnlocked && this.settings().clearClipboardOnLock) {
			await this.clipboard.clearIfTainted();
		}
		if (this.isStopped()) return;
		if (hadUnlocked) {
			this.applyContentProtection();
		}
		this.armIdleTimer();
	}

	/** Panic chord (§7): instant mask of every protected note. */
	panic(): void {
		if (this.isStopped()) return;
		void this.maskAll("panic");
	}

	onSessionUnlocked(): void {
		if (this.isStopped()) return;
		this.armIdleTimer();
		this.applyContentProtection();
	}

	private applyContentProtection(): void {
		if (this.isStopped()) {
			setContentProtection(false);
			return;
		}
		const anyUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		setContentProtection(this.settings().contentProtection && anyUnlocked);
	}
}
