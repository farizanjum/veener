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
	readonly clipboard = new ClipboardGuard();

	constructor(
		private readonly plugin: Plugin,
		private readonly workspace: Workspace,
		private readonly sessions: SessionManager,
		private readonly settings: () => VeneerSettings,
	) {}

	start(): void {
		const activity = (): void => this.armIdleTimer();
		for (const event of ["keydown", "mousedown", "wheel", "touchstart"] as const) {
			this.plugin.registerDomEvent(window, event, activity, { capture: true, passive: true });
		}
		this.plugin.registerDomEvent(window, "blur", () => {
			void this.maskAll("window-blur");
		});
		this.plugin.registerDomEvent(document, "copy", () => {
			if (this.sessions.all().some((s) => s.state === "unlocked")) {
				const selection = window.getSelection()?.toString() ?? "";
				if (selection.length > 0) this.clipboard.markTainted(selection);
			}
		});
		this.plugin.registerEvent(
			this.workspace.on("active-leaf-change", () => {
				void this.maskAll("leaf-change");
			}),
		);
		this.plugin.registerEvent(
			this.workspace.on("layout-change", () => {
				void this.maskAll("layout-change");
			}),
		);
		this.removePowerListener = wirePowerMonitor(() => {
			void this.maskAll("power-event");
		});
		this.plugin.register(() => this.stop());
		this.armIdleTimer();
	}

	stop(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.removePowerListener?.();
		this.removePowerListener = null;
		setContentProtection(false);
	}

	armIdleTimer(): void {
		if (this.idleTimer !== null) clearTimeout(this.idleTimer);
		const timeoutMs = Math.max(15, this.settings().idleTimeoutSec) * 1000;
		this.idleTimer = setTimeout(() => {
			void this.maskAll("idle-timeout");
		}, timeoutMs);
	}

	async maskAll(reason: string): Promise<void> {
		const hadUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		await this.sessions.lockAll(reason);
		if (hadUnlocked) {
			if (this.settings().clearClipboardOnLock) {
				await this.clipboard.clearIfTainted();
			}
			this.applyContentProtection();
		}
		this.armIdleTimer();
	}

	/** Panic chord (§7): instant mask of every protected note. */
	panic(): void {
		void this.maskAll("panic");
	}

	onSessionUnlocked(): void {
		this.armIdleTimer();
		this.applyContentProtection();
	}

	private applyContentProtection(): void {
		const anyUnlocked = this.sessions.all().some((s) => s.state === "unlocked");
		setContentProtection(this.settings().contentProtection && anyUnlocked);
	}
}
