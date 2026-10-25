import { Modal, type App } from "obsidian";
import fs from "fs";
import {
	clearPartial,
	fetchModelMetadata,
	formatBytes,
	formatDuration,
	partialProgress,
	sha256HexOfFile,
	startModelDownload,
	type DownloadHandle,
} from "../llm/download";

/** Dependencies injected into `ModelDownloadModal` for downloading, verifying, and registering a model file. */
export interface DownloadModalDeps {
	url: string;
	file: string;
	label: string;
	getDest: () => Promise<{ abs: string; rel: string }>;
	removeFile: (rel: string) => Promise<void>;
	onDone: (ok: boolean, verified: boolean) => void;
}

/** Obsidian modal that manages resumable GGUF model downloads, progress reporting, and SHA-256 verification. */
export class ModelDownloadModal extends Modal {
	private statusEl!: HTMLElement;
	private barEl!: HTMLProgressElement;
	private statsEl!: HTMLElement;
	private pauseBtn!: HTMLButtonElement;
	private handle: DownloadHandle | null = null;
	private cancelMetadata: (() => void) | null = null;
	private finished = false;
	private isOpenModal = false;
	private pauseRequested = false;
	private cancelledByUnload = false;
	private runEpoch = 0;
	private startOverTimer: ReturnType<typeof setTimeout> | null = null;
	private startOverWake: (() => void) | null = null;

	/** Creates a model download modal bound to the active Obsidian app and download callbacks. */
	constructor(
		app: App,
		private readonly deps: DownloadModalDeps,
	) {
		super(app);
	}

	/** Clears any pending start-over resume notice timer and wakes the awaiting coroutine. */
	private clearStartOverWait(): void {
		if (this.startOverTimer !== null) {
			clearTimeout(this.startOverTimer);
			this.startOverTimer = null;
		}
		if (this.startOverWake !== null) {
			const wake = this.startOverWake;
			this.startOverWake = null;
			wake();
		}
	}

	/** Invalidates the current download epoch, clears any start-over timer, and cancels any active download handle. */
	private cancelActiveRun(): void {
		this.runEpoch += 1;
		this.clearStartOverWait();
		this.cancelMetadata?.();
		this.cancelMetadata = null;
		this.handle?.cancel();
		this.handle = null;
	}

	/** Cancels any in-flight download or metadata check and closes the modal immediately. */
	cancelAndClose(): void {
		this.cancelledByUnload = true;
		this.cancelActiveRun();
		this.close();
	}

	/** Renders the download progress UI and starts the model download workflow for the current epoch. */
	onOpen(): void {
		this.isOpenModal = true;
		this.finished = false;
		this.pauseRequested = false;
		this.cancelledByUnload = false;
		const epoch = ++this.runEpoch;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: `Downloading ${this.deps.label}` });
		this.statusEl = contentEl.createEl("p", { text: "Checking Hugging Face record..." });
		this.barEl = contentEl.createEl("progress", {
			attr: { max: "1", value: "0" },
			cls: "veneer-progress",
		});
		this.statsEl = contentEl.createEl("p", { cls: "veneer-strength", text: "" });
		const buttonRow = contentEl.createDiv();
		const pauseBtn = buttonRow.createEl("button", { text: "Pause" });
		this.pauseBtn = pauseBtn;
		pauseBtn.addEventListener("click", () => {
			if (this.finished || !this.isOpenModal || this.runEpoch !== epoch) return;
			this.pauseRequested = true;
			this.clearStartOverWait();
			this.cancelMetadata?.();
			this.cancelMetadata = null;
			this.handle?.cancel();
		});
		void this.run(epoch);
	}

	/** Displays a brief resume notice when a partial download exists and allows restarting from scratch. */
	private async offerStartOver(destAbs: string, epoch: number): Promise<void> {
		const partial = partialProgress(destAbs);
		if (partial === null) return;
		const label =
			partial.total !== null && partial.total > 0
				? `Found a partial download at ${Math.floor((partial.downloaded / partial.total) * 100)}%. Resuming.`
				: `Found a partial download (${formatBytes(partial.downloaded)}). Resuming.`;
		this.statusEl.setText(label);
		const startOver = this.contentEl.createEl("button", {
			text: "Start over instead",
			cls: "veneer-link-button",
		});
		startOver.addEventListener("click", () => {
			if (!this.isOpenModal || this.runEpoch !== epoch) return;
			this.cancelActiveRun();
			clearPartial(destAbs);
			this.onOpen();
		});
		try {
			await new Promise<void>((resolve) => {
				this.startOverWake = resolve;
				this.startOverTimer = setTimeout(() => {
					this.startOverTimer = null;
					this.startOverWake = null;
					resolve();
				}, 800);
				(this.startOverTimer as { unref?: () => void })?.unref?.();
			});
		} finally {
			if (this.runEpoch === epoch) {
				startOver.remove?.();
			}
		}
	}

	/** Executes metadata lookup, resumable download, and SHA-256 verification for `epoch`. */
	private async run(epoch: number): Promise<void> {
		const isStale = (): boolean => !this.isOpenModal || this.runEpoch !== epoch;
		const throwIfPaused = (): void => {
			if (this.pauseRequested) throw new Error("paused");
		};
		try {
			const dest = await this.deps.getDest();
			if (isStale()) return;
			throwIfPaused();
			if (fs.existsSync(dest.abs)) {
				if (isStale()) return;
				this.barEl.value = 1;
				this.statusEl.setText("Model file already present.");
				this.statsEl.setText("You can close this window.");
				this.finished = true;
				this.deps.onDone(true, false);
				return;
			}
			await this.offerStartOver(dest.abs, epoch);
			if (isStale()) return;
			throwIfPaused();
			let expectedHash: string | null = null;
			let total: number | null = null;
			try {
				const meta = await fetchModelMetadata(this.deps.url, {
					isCancelled: () => !this.isOpenModal || this.runEpoch !== epoch || this.pauseRequested,
					onActiveChange: (cancel) => {
						if (this.runEpoch === epoch) {
							this.cancelMetadata = cancel;
						}
					},
				});
				if (isStale()) return;
				throwIfPaused();
				expectedHash = meta.sha256;
				total = meta.sizeBytes;
			} catch {
				if (isStale()) return;
				throwIfPaused();
				this.statusEl.setText("No hash record found; downloading anyway.");
			} finally {
				if (this.runEpoch === epoch) {
					this.cancelMetadata = null;
				}
			}
			if (expectedHash !== null) {
				this.statusEl.setText("SHA-256 verified from Hugging Face. Download started.");
			}

			if (isStale()) return;
			throwIfPaused();
			this.handle = startModelDownload(this.deps.url, dest.abs, total, (progress) => {
				if (isStale()) return;
				if (progress.total !== null && progress.total > 0) {
					const fraction = progress.downloaded / progress.total;
					this.barEl.value = fraction;
					const percent = Math.floor(fraction * 100);
					const speed = `${formatBytes(Math.max(0, Math.round(progress.bytesPerSecond)))}/s`;
					const eta = progress.etaSeconds !== null ? `, about ${formatDuration(progress.etaSeconds)} left` : "";
					this.statsEl.setText(
						`${percent}% (${formatBytes(progress.downloaded)} of ${formatBytes(progress.total)}) at ${speed}${eta}`,
					);
				} else {
					this.statsEl.setText(
						`${formatBytes(progress.downloaded)} downloaded at ${formatBytes(Math.max(0, Math.round(progress.bytesPerSecond)))}/s`,
					);
				}
			});
			try {
				await this.handle.promise;
			} finally {
				if (this.runEpoch === epoch) {
					this.handle = null;
				}
			}
			if (!isStale()) {
				this.pauseBtn.disabled = true;
				this.statsEl.setText("");
				this.statusEl.setText("Verifying file against record...");
			}
			let verified = false;
			if (expectedHash !== null) {
				const actual = await sha256HexOfFile(dest.abs);
				if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
					await this.deps.removeFile(dest.rel);
					this.finished = true;
					if (!this.cancelledByUnload) {
						this.deps.onDone(false, false);
					}
					if (isStale()) return;
					this.statusEl.setText("Download corrupted: file does not match the record. Deleted. Close and try again.");
					return;
				}
				verified = true;
			}
			this.finished = true;
			if (this.cancelledByUnload) return;
			if (isStale()) {
				this.deps.onDone(true, verified);
				return;
			}
			this.barEl.value = 1;
			this.statusEl.setText(
				verified
					? "Model ready. SHA-256 verified."
					: "Model ready. No hash record to verify against.",
			);
			this.statsEl.setText("You can close this window.");
			this.deps.onDone(true, verified);
		} catch (error) {
			if (isStale()) return;
			const message = error instanceof Error ? error.message : String(error);
			if (message === "paused") {
				const progress = this.barEl.value > 0 ? ` at ${Math.floor(this.barEl.value * 100)}%` : "";
				this.statusEl.setText(
					`Paused${progress}. Your partial download is saved. Click Download model in Settings anytime to resume from here.`,
				);
			} else {
				this.statusEl.setText(`Download failed: ${message}`);
			}
			this.statsEl.setText("");
			this.finished = true;
		}
	}

	/** Marks the modal closed, cancels any active download or metadata fetch, and clears the modal DOM. */
	onClose(): void {
		this.isOpenModal = false;
		this.cancelActiveRun();
		this.contentEl.empty();
	}
}
