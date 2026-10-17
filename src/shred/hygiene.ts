import type { App } from "obsidian";
import type { VeneerSettings } from "../settings";

export interface HygieneItem {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
	level: "critical" | "recommended" | "informational";
}

interface InternalPlugins {
	plugins?: Record<string, { enabled?: boolean }>;
}

interface CommunityPlugins {
	manifests?: Record<string, unknown>;
}

export function fileRecoveryEnabled(app: App): boolean {
	const internal = (app as unknown as { internalPlugins?: InternalPlugins }).internalPlugins;
	return internal?.plugins?.["file-recovery"]?.enabled === true;
}

export function collectHygiene(app: App, settings: VeneerSettings): HygieneItem[] {
	const items: HygieneItem[] = [];

	const recoveryEnabled = fileRecoveryEnabled(app);
	items.push({
		id: "file-recovery",
		label: "File Recovery disabled",
		ok: !recoveryEnabled,
		level: "critical",
		detail: recoveryEnabled
			? "File Recovery snapshots in-memory editor content to disk. Disable it in Settings > Core plugins before unlocking notes."
			: "Snapshots of editor content are off.",
	});

	const community = (app as unknown as { plugins?: CommunityPlugins }).plugins;
	const communityCount = Object.keys(community?.manifests ?? {}).length;
	items.push({
		id: "plugins",
		label: "Third-party plugin exposure",
		ok: communityCount <= 6,
		level: "recommended",
		detail: `${communityCount} community plugin(s) installed. Any plugin can read editor state while a note is unlocked. Keep the set small and trusted.`,
	});

	items.push({
		id: "content-protection",
		label: "Screen-capture protection",
		ok: settings.contentProtection,
		level: "recommended",
		detail: settings.contentProtection
			? "The window is hidden from screenshots and screen sharing while a note is unlocked."
			: "Off. Enable it if screenshots, screen sharing, or Windows Recall are in your threat model.",
	});

	items.push({
		id: "duress",
		label: "Destruction PIN",
		ok: settings.duressPinHash !== null,
		level: "recommended",
		detail:
			settings.duressPinHash !== null
				? "Set. Typing it anywhere shreds every payload instantly."
				: "Not set. Optional: a PIN that destroys all protected payloads on entry.",
	});

	items.push({
		id: "model",
		label: "Decoy model downloaded",
		ok: settings.modelDownloaded,
		level: "informational",
		detail: settings.modelDownloaded
			? "On-device generation is ready. No network calls after this point."
			: "Not yet. Template decoys still work; the model makes covers richer.",
	});

	items.push({
		id: "hibernation",
		label: "Disable hibernation (OS-level)",
		ok: false,
		level: "recommended",
		detail: "Hibernation writes RAM to disk (hiberfil.sys on Windows), which can include decrypted note text. Run `powercfg /h off` in an admin terminal to disable it.",
	});

	items.push({
		id: "bitlocker",
		label: "Full disk encryption (OS-level)",
		ok: false,
		level: "recommended",
		detail: "BitLocker (Windows), FileVault (macOS), or LUKS (Linux) encrypts the pagefile and all disk artifacts. Without it, a thief who images your disk can carve plaintext from swap space. Enable it in Windows Settings > Privacy & Security > Device Encryption.",
	});

	items.push({
		id: "windows-search",
		label: "Exclude vault from Windows Search (OS-level)",
		ok: false,
		level: "recommended",
		detail: "Windows Search caches the first 1KB of indexed files in Windows.db. Exclude your vault folder: Settings > Privacy & Security > Searching Windows > Excluded folders > Add your vault path.",
	});

	items.push({
		id: "veracrypt",
		label: "VeraCrypt hidden volume (disk-level deniability)",
		ok: false,
		level: "informational",
		detail: "For forensic-grade protection: create a VeraCrypt file container with a hidden volume inside. Store your vault in the hidden volume. Under coercion, reveal only the outer password. See the VeraCrypt guide below in this settings page.",
	});

	items.push({
		id: "sync",
		label: "Cloud sync version history",
		ok: true,
		level: "informational",
		detail: "If your vault is synced (OneDrive, Google Drive, git, Obsidian Sync), old versions of files persist in the cloud. Never protect a note that previously existed as plaintext under sync. Delete and purge cloud history first, or keep your vault local-only.",
	});

	return items;
}
