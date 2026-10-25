import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type VeneerPlugin from "../main";
import { MODEL_INFO, activeModel, type ModelId } from "../settings";
import { formatBytes, metadataApiUrl, parseHuggingFaceResolveUrl } from "../llm/download";
import { ModelDownloadModal } from "./downloadModal";
import { collectHygiene } from "../shred/hygiene";
import { DuressPinModal } from "./modals";
import { sanitizeInterests, sanitizePersona } from "../llm/prompt";

/** Obsidian settings tab for configuring Veneer masking, cover identity, local LLM models, and hygiene checks. */
export class VeneerSettingTab extends PluginSettingTab {
	/** Creates the Veneer settings tab bound to the active Obsidian app and plugin instance. */
	constructor(app: App, private readonly plugin: VeneerPlugin) {
		super(app, plugin);
	}

	/** Renders the Veneer settings controls into the settings tab container. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Veneer" });

		containerEl.createEl("h3", { text: "Masking" });
		new Setting(containerEl)
			.setName("Idle timeout (seconds)")
			.setDesc("Mask every unlocked note after this much inactivity. 15 to 600.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.idleTimeoutSec)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isFinite(parsed) && parsed >= 15 && parsed <= 600) {
						this.plugin.settings.idleTimeoutSec = parsed;
						await this.plugin.saveSettings();
						this.plugin.lockEngine.armIdleTimer();
					}
				}),
			);
		new Setting(containerEl)
			.setName("Unlock trigger prefix")
			.setDesc("Type this at the start of any line, then your password, then space or enter.")
			.addText((text) =>
				text.setValue(this.plugin.settings.triggerPrefix).onChange(async (value) => {
					if (value.trim().length >= 2) {
						this.plugin.settings.triggerPrefix = value.trim();
						await this.plugin.saveSettings();
					}
				}),
			);
		new Setting(containerEl)
			.setName("Trigger only at line start")
			.setDesc("Strongly recommended. Makes accidental activation in prose nearly impossible.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.lineStartOnly).onChange(async (value) => {
					this.plugin.settings.lineStartOnly = value;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Clear clipboard on mask")
			.setDesc("If the clipboard still holds text copied while unlocked, wipe it on mask.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.clearClipboardOnLock).onChange(async (value) => {
					this.plugin.settings.clearClipboardOnLock = value;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Show capture dots in status bar")
			.setDesc("A small dot counter while you type an unlock. Only meaningful to you.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showCaptureDots).onChange(async (value) => {
					this.plugin.settings.showCaptureDots = value;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Screen-capture protection")
			.setDesc("Hide the window from screenshots, screen sharing, and Windows Recall while a note is unlocked.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.contentProtection).onChange(async (value) => {
					this.plugin.settings.contentProtection = value;
					await this.plugin.saveSettings();
				}),
			);

		containerEl.createEl("h3", { text: "Cover identity" });
		new Setting(containerEl)
			.setName("Your cover interests")
			.setDesc("Comma separated, everyday topics. Decoys reference these, never your notes.")
			.addTextArea((area) =>
				area.setValue(this.plugin.settings.interests.join(", ")).onChange(async (value) => {
					this.plugin.settings.interests = sanitizeInterests(value.split(","));
					await this.plugin.saveSettings();
				}),
			);
		const personaPreview = containerEl.createEl("p", {
			cls: "veneer-strength",
			text: this.plugin.settings.coverPersona
				? `Using persona: ${this.plugin.settings.coverPersona}`
				: "No persona set. Covers will be generic.",
		});
		new Setting(containerEl)
			.setName("Approved names (optional)")
			.setDesc("People or entities the decoy may reference by name. Comma separated. Leave empty and the model uses roles like 'a friend' instead of any name.")
			.addTextArea((area) =>
				area.setValue(this.plugin.settings.coverNames.join(", ")).onChange(async (value) => {
					this.plugin.settings.coverNames = sanitizeInterests(value.split(","));
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Cover persona")
			.setDesc("One line about who your covers should sound like (a backend developer, a cafe owner). Generated covers match this world. Sanitized, never reads your notes.")
			.addTextArea((area) =>
				area.setValue(this.plugin.settings.coverPersona).onChange(async (value) => {
					const sanitized = sanitizePersona(value);
					this.plugin.settings.coverPersona = sanitized;
					await this.plugin.saveSettings();
					personaPreview.setText(
						sanitized ? `Using persona: ${sanitized}` : "Nothing usable in that line. Covers will be generic.",
					);
				}),
			);

		containerEl.createEl("h3", { text: "Decoy model" });
		const disk = this.plugin.modelFileStatus();
		const downloaded = this.plugin.downloadedModels();

		if (downloaded.length > 0) {
			containerEl.createEl("p", {
				text: `${downloaded.length} model(s) on disk. Select which one to use for cover generation:`,
				cls: "veneer-status-ready",
			});
			for (const dm of downloaded) {
				const isCustom = dm.modelId === "custom";
				const label = isCustom
					? dm.fileName
					: MODEL_INFO[dm.modelId as Exclude<ModelId, "custom">]?.label ?? dm.fileName;
				const isActive =
					(this.plugin.settings.modelId === "custom" && this.plugin.settings.customModel?.file === dm.fileName) ||
					(this.plugin.settings.modelId === dm.modelId);
				const row = containerEl.createDiv({ cls: "veneer-model-row" });
				const radio = row.createEl("input", {
					attr: { type: "radio", name: "veneer-model-select" },
				});
				radio.checked = isActive;
				radio.addEventListener("change", async () => {
					if (isCustom) {
						this.plugin.settings.modelId = "custom";
						this.plugin.settings.customModel = {
							file: dm.fileName,
							url: null,
							sizeBytes: dm.sizeBytes,
							label: dm.fileName,
						};
					} else {
						this.plugin.settings.modelId = dm.modelId;
						this.plugin.settings.customModel = null;
					}
					this.plugin.settings.modelDownloaded = true;
					this.plugin.settings.modelVerified = false;
					await this.plugin.saveSettings();
					this.plugin.rebuildGenerator();
					this.display();
				});
				row.createEl("span", {
					text: `${label} (${formatBytes(dm.sizeBytes)})`,
					cls: "veneer-model-label",
				});
				const delBtn = row.createEl("button", { text: "Delete", cls: "veneer-link-button" });
				delBtn.addEventListener("click", async () => {
					const deleted = await this.plugin.deleteModelFile(dm.fileName);
					new Notice(deleted ? `Deleted ${dm.fileName}.` : `Could not delete ${dm.fileName}.`);
					this.display();
				});
			}
			const resultEl = containerEl.createEl("p", { cls: "veneer-strength" });
			let testing = false;
			const testBtn = containerEl.createEl("button", {
				text: "Generate a test cover with the selected model",
				cls: "veneer-test-button",
			});
			testBtn.addEventListener("click", async () => {
				if (testing) return;
				testing = true;
				testBtn.textContent = "Generating...";
				try {
					resultEl.setText(await this.plugin.testModelFlow());
				} catch (error) {
					resultEl.setText(`Generation failed: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					testBtn.textContent = "Generate a test cover with the selected model";
					testing = false;
				}
			});
		} else {
			containerEl.createEl("p", {
				text: "No model downloaded yet. Templates work meanwhile. Pick one below and download it.",
				cls: "veneer-status-pending",
			});
		}

		containerEl.createEl("p", { text: "Download a new model:", cls: "veneer-section-label" });
		new Setting(containerEl)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("qwen3-0.6b", MODEL_INFO["qwen3-0.6b"].label)
					.addOption("qwen3-1.7b", MODEL_INFO["qwen3-1.7b"].label)
					.addOption("qwen3-4b", MODEL_INFO["qwen3-4b"].label)
					.addOption("phi-4-mini", MODEL_INFO["phi-4-mini"].label)
					.addOption("custom", "Custom (your own GGUF)")
					.setValue(this.plugin.settings.modelId)
					.onChange(async (value) => {
						this.plugin.settings.modelId = value as ModelId;
						const status = this.plugin.modelFileStatus();
						this.plugin.settings.modelDownloaded = status.exists;
						this.plugin.settings.modelVerified = false;
						await this.plugin.saveSettings();
						this.plugin.rebuildGenerator();
						this.display();
					}),
			);

		if (this.plugin.settings.modelId === "custom") {
			let customUrl = "";
			new Setting(containerEl)
				.setName("Custom model URL")
				.setDesc("Any GGUF link from Hugging Face. Hash and size verify automatically.")
				.addText((text) =>
					text.setPlaceholder("https://huggingface.co/.../resolve/main/....gguf").onChange((value) => {
						customUrl = value.trim();
					}),
				);
			const customBtn = containerEl.createEl("button", {
				text: "Download custom model",
				cls: "veneer-download-button mod-cta",
			});
			customBtn.addEventListener("click", async () => {
				let fileName = "";
				try {
					const parsed = parseHuggingFaceResolveUrl(customUrl);
					metadataApiUrl(customUrl);
					fileName = parsed.fileName;
				} catch {
					new Notice("That does not look like a Hugging Face resolve link.");
					return;
				}
				if (!fileName.toLowerCase().endsWith(".gguf")) {
					new Notice("The link must point at a .gguf file.");
					return;
				}
				this.plugin.settings.customModel = { file: fileName, url: customUrl, sizeBytes: null, label: fileName };
				await this.plugin.saveSettings();
				this.openDownloadModal();
			});
			const fileInput = containerEl.createEl("input", { attr: { type: "file", accept: ".gguf", style: "display:none" } });
			fileInput.addEventListener("change", () => {
				void (async () => {
					const file = fileInput.files?.[0];
					const path = (file as { path?: string } | undefined)?.path;
					if (!path) { new Notice("Could not read that file's path."); return; }
					const result = await this.plugin.importLocalModelFlow(path);
					if (result.ok) {
						new Notice(`Model imported. SHA-256 starts: ${result.sha256?.slice(0, 16)}`, 10000);
						this.display();
					} else { new Notice(`Import failed: ${result.error ?? "unknown error"}`, 10000); }
				})();
			});
			const importBtn = containerEl.createEl("button", { text: "Or import a .gguf from this computer", cls: "veneer-link-button" });
			importBtn.addEventListener("click", () => fileInput.click());
		} else if (!disk.exists) {
			const downloadBtn = containerEl.createEl("button", {
				text: `Download ${MODEL_INFO[this.plugin.settings.modelId as Exclude<ModelId, "custom">]?.label ?? "model"}`,
				cls: "veneer-download-button mod-cta",
			});
			downloadBtn.addEventListener("click", () => this.openDownloadModal());
		}

		containerEl.createEl("h3", { text: "Destruction PIN" });
		new Setting(containerEl)
			.setName(this.plugin.settings.duressPinHash ? "PIN is set" : "No PIN set")
			.setDesc("Type ;;! followed by your PIN at the start of any line to trigger. Different prefix from unlock (;;) so it cannot fire accidentally.")
			.addButton((button) =>
				button.setButtonText(this.plugin.settings.duressPinHash ? "Change PIN" : "Set PIN").onClick(async () => {
					const pin = await this.plugin.trackModal(new DuressPinModal(this.app)).ask();
					if (pin === null) return;
					await this.plugin.setDuressPin(pin);
					new Notice("Destruction PIN set.");
					this.display();
				}),
			)
			.addButton((button) =>
				button.setButtonText("Remove PIN").onClick(async () => {
					await this.plugin.clearDuressPin();
					new Notice("Destruction PIN removed.");
					this.display();
				}),
			);

		containerEl.createEl("h3", { text: "Hygiene check" });
		const hygieneEl = containerEl.createDiv();
		this.renderHygiene(hygieneEl);
		const recheckBtn = containerEl.createEl("button", {
			text: "Recheck",
			cls: "veneer-recheck-button",
		});
		recheckBtn.addEventListener("click", () => {
			hygieneEl.empty();
			this.renderHygiene(hygieneEl);
		});

		containerEl.createEl("h3", { text: "Protected notes" });
		const entries = this.plugin.registry.list();
		if (entries.length === 0) {
			containerEl.createEl("p", { text: "None yet. Right-click a note and choose Protect this note.", cls: "veneer-strength" });
		} else {
			const count = entries.length;
			containerEl.createEl("p", {
				text: `${count} protected note(s). Use Ctrl+P > "Veneer: Unprotect this note" to remove protection.`,
				cls: "veneer-strength",
			});
		}

		containerEl.createEl("h3", { text: "Forensic setup: VeraCrypt hidden volume" });
		containerEl.createEl("p", {
			text: "Veneer protects against people looking at your screen. For protection against people imaging your disk, layer it with VeraCrypt. A hidden volume stores your vault inside what looks like random data. Under coercion, you reveal the outer password and they see believable non-sensitive notes.",
			cls: "veneer-strength",
		});

		const callout = containerEl.createDiv({ cls: "veneer-callout" });
		const steps = [
			"Download VeraCrypt from veracrypt.fr and install it.",
			"Create a file container (Create Volume > encrypted file container > standard). Pick a size of at least 5 GB.",
			"Set an outer password. This is what you reveal under pressure. Put a few real but non-sensitive notes in this outer volume.",
			"Create a hidden volume inside the same container (Create Volume > Hidden VeraCrypt volume). Use a different password for this one.",
			"Mount with your real password. Move your Obsidian vault into the mounted hidden volume.",
			"Run Obsidian from there. Install Veneer. Protect your notes as normal.",
			"Under coercion: mount with the outer password. They see the outer notes. The hidden volume is indistinguishable from random free space.",
			"Dismount when you step away. The vault vanishes from the filesystem.",
		];
		const ol = callout.createEl("ol");
		for (const step of steps) {
			ol.createEl("li", { text: step });
		}
		callout.createEl("p", {
			text: "Layers: Veneer for screen-level deniability. VeraCrypt for disk-level deniability. Destruction PIN for forward secrecy. Each is independent.",
			cls: "veneer-strength",
		});
	}

	/** Opens the resumable download modal for the currently selected model. */
	private openDownloadModal(): void {
		const model = activeModel(this.plugin.settings);
		if (model.url === null) {
			new Notice("This model was imported from disk; nothing to download.");
			return;
		}
		const targetFile = model.file;
		this.plugin.trackModal(
			new ModelDownloadModal(this.app, {
				url: model.url,
				file: model.file,
				label: model.label,
				isHostActive: () => this.plugin.isLive(),
				getDest: async () => {
					const dir = await this.plugin.modelsDir();
					return { abs: `${dir.abs}/${model.file}`, rel: `${dir.rel}/${model.file}` };
				},
				removeFile: (rel) => this.plugin.removeModelFile(rel),
				onDone: (ok, verified) => {
					void (async () => {
						if (!this.plugin.isLive()) return;
						if (ok) {
							if (activeModel(this.plugin.settings).file === targetFile) {
								this.plugin.settings.modelDownloaded = true;
								this.plugin.settings.modelVerified = verified;
								await this.plugin.saveSettings();
								if (!this.plugin.isLive()) return;
								await this.plugin.rebuildGenerator();
							}
							if (!this.plugin.isLive()) return;
							new Notice(
								verified
									? "Model ready. SHA-256 verified against Hugging Face's record."
									: "Model ready. Hash record could not be fetched, but the download completed.",
								8000,
							);
							this.display();
						}
					})();
				},
			}),
		).open();
	}

	/** Renders the vault and OS security hygiene status cards into `el`. */
	private renderHygiene(el: HTMLElement): void {
		for (const item of collectHygiene(this.app, this.plugin.settings)) {
			const cls = item.ok
				? "veneer-hygiene-card-ok"
				: item.level === "critical"
					? "veneer-hygiene-card-critical"
					: item.level === "recommended"
						? "veneer-hygiene-card-warn"
						: "veneer-hygiene-card-info";
			const card = el.createDiv({ cls: `veneer-hygiene-card ${cls}` });
			const prefix = item.ok ? "OK" : item.level === "critical" ? "CRITICAL" : item.level === "recommended" ? "ATTENTION" : "INFO";
			card.createEl("strong", { text: `${prefix}: ${item.label}` });
			card.createEl("p", { text: item.detail });
		}
	}
}
