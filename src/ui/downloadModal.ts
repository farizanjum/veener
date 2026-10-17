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

export interface DownloadModalDeps {
	url: string;
	file: string;
	label: string;
	getDest: () => Promise<{ abs: string; rel: string }>;
	removeFile: (rel: string) => Promise<void>;
	onDone: (ok: boolean, verified: boolean) => void;
}

export class ModelDownloadModal extends Modal {
	private statusEl!: HTMLElement;
	private barEl!: HTMLProgressElement;
	private statsEl!: HTMLElement;
	private handle: DownloadHandle | null = null;
	private finished = false;

	constructor(
		app: App,
		private readonly deps: DownloadModalDeps,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Downloading ${this.deps.label}` });
		this.statusEl = contentEl.createEl("p", { text: "Checking Hugging Face record..." });
		this.barEl = contentEl.createEl("progress", {
			attr: { max: "1", value: "0" },
			cls: "veneer-progress",
		});
		this.statsEl = contentEl.createEl("p", { cls: "veneer-strength", text: "" });
		const buttonRow = contentEl.createDiv();
		const pauseBtn = buttonRow.createEl("button", { text: "Pause" });
		pauseBtn.addEventListener("click", () => this.handle?.cancel());
		void this.run();
	}

	private async offerStartOver(destAbs: string): Promise<void> {
		const partial = partialProgress(destAbs);
		if (partial !== null) {
			const label =
				partial.total !== null
					? `Found a partial download at ${Math.floor((partial.downloaded / partial.total) * 100)}%. Resuming.`
					: `Found a partial download (${formatBytes(partial.downloaded)}). Resuming.`;
			this.statusEl.setText(label);
			const startOver = this.contentEl.createEl("button", {
				text: "Start over instead",
				cls: "veneer-link-button",
			});
			startOver.addEventListener("click", () => {
				clearPartial(destAbs);
				this.contentEl.empty();
				this.onOpen();
			});
			await new Promise((resolve) => setTimeout(resolve, 800));
		}
	}

	private async run(): Promise<void> {
		try {
			const dest = await this.deps.getDest();
			if (fs.existsSync(dest.abs)) {
				this.barEl.value = 1;
				this.statusEl.setText("Model file already present.");
				this.statsEl.setText("You can close this window.");
				this.finished = true;
				this.deps.onDone(true, false);
				return;
			}
			await this.offerStartOver(dest.abs);
			let expectedHash: string | null = null;
			let total: number | null = null;
			try {
				const meta = await fetchModelMetadata(this.deps.url);
				expectedHash = meta.sha256;
				total = meta.sizeBytes;
			} catch {
				this.statusEl.setText("No hash record found; downloading anyway.");
			}
			if (expectedHash !== null) {
				this.statusEl.setText("SHA-256 verified from Hugging Face. Download started.");
			}

			this.handle = startModelDownload(this.deps.url, dest.abs, total, (progress) => {
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
			await this.handle.promise;

			this.statsEl.setText("");
			this.statusEl.setText("Verifying file against record...");
			let verified = false;
			if (expectedHash !== null) {
				const actual = await sha256HexOfFile(dest.abs);
				if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
					await this.deps.removeFile(dest.rel);
					this.statusEl.setText("Download corrupted: file does not match the record. Deleted. Close and try again.");
					this.finished = true;
					this.deps.onDone(false, false);
					return;
				}
				verified = true;
			}
			this.barEl.value = 1;
			this.statusEl.setText(
				verified
					? "Model ready. SHA-256 verified."
					: "Model ready. No hash record to verify against.",
			);
			this.statsEl.setText("You can close this window.");
			this.finished = true;
			this.deps.onDone(true, verified);
		} catch (error) {
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

	onClose(): void {
		if (!this.finished) this.handle?.cancel();
		this.contentEl.empty();
	}
}
