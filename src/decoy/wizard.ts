import { Modal, Notice, Setting, type App } from "obsidian";
import { DECOY_TEMPLATES, weaveTemplate, type DecoyTemplate } from "./templates";
import { scorePassword } from "./strength";
import { AUTO_TYPE, DECOY_TYPES, type CoverLength, type CoverType } from "../llm/prompt";
import type { DecoyGenerator } from "../llm/generator";

/**
 * Protect-this-note wizard (§9.2): pick or write a cover, choose a password,
 * confirm. The live preview always shows exactly what an observer would see.
 */

export interface ProtectResult {
	decoy: string;
	password: string;
}

export interface WizardDeps {
	interests: readonly string[];
	names: readonly string[];
	persona: string;
	generator: DecoyGenerator;
	llmAvailable: boolean;
	realWordCount?: number;
	onProtect: (result: ProtectResult) => Promise<void>;
}

type DecoySource = "template" | "generate" | "write";

export class ProtectWizard extends Modal {
	private source: DecoySource;
	private templateId = DECOY_TEMPLATES[0].id;
	private coverType: CoverType = AUTO_TYPE;
	private coverLength: CoverLength = "auto";
	private instruction = "";
	private decoyText = "";
	private busy = false;

	/** Creates a protect-note wizard modal initialized to local generation when an LLM is available. */
	constructor(
		app: App,
		private readonly deps: WizardDeps,
	) {
		super(app);
		this.source = deps.llmAvailable ? "generate" : "template";
	}

	/** Weaves the initial template cover and renders the wizard UI when the modal opens. */
	onOpen(): void {
		this.decoyText = this.weaveCurrentTemplate();
		this.render();
	}

	/** Weaves the currently selected decoy template using the configured interests and cover names. */
	private weaveCurrentTemplate(): string {
		const template =
			DECOY_TEMPLATES.find((t) => t.id === this.templateId) ?? DECOY_TEMPLATES[0];
		return weaveTemplate(template as DecoyTemplate, {
			topics: [...this.deps.interests],
			names: [...this.deps.names],
			now: new Date(),
			seed: Date.now() % 100000,
		});
	}

	/** Renders the cover selection controls, live cover preview, and password confirmation fields. */
	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Protect this note" });
		contentEl.createEl("p", {
			text: "The note will read as ordinary cover text. Your current content moves into the encrypted payload.",
		});

		let previewArea: HTMLTextAreaElement;
		new Setting(contentEl).setName("Cover source").addDropdown((dropdown) => {
			dropdown.addOption("template", "Template (instant)");
			if (this.deps.llmAvailable) dropdown.addOption("generate", "Generate cover (on-device)");
			dropdown.addOption("write", "Write my own");
			dropdown.setValue(this.source);
			dropdown.onChange(async (value) => {
				this.source = value as DecoySource;
				this.render();
			});
		});

		if (this.source === "template") {
			new Setting(contentEl).setName("Template").addDropdown((dropdown) => {
				for (const template of DECOY_TEMPLATES) {
					dropdown.addOption(template.id, template.kind);
				}
				dropdown.setValue(this.templateId);
				dropdown.onChange((value) => {
					this.templateId = value;
					this.decoyText = this.weaveCurrentTemplate();
					this.render();
				});
			});
			new Setting(contentEl).addButton((button) =>
				button.setButtonText("Reroll").onClick(() => {
					this.decoyText = this.weaveCurrentTemplate();
					this.render();
				}),
			);
		}

		if (this.source === "generate") {
			new Setting(contentEl)
				.setName("Cover type")
				.setDesc("Auto lets the model pick the most natural note for your persona.")
				.addDropdown((dropdown) => {
					dropdown.addOption(AUTO_TYPE, "Auto (model decides from your persona)");
					for (const kind of DECOY_TYPES) dropdown.addOption(kind, kind);
					dropdown.setValue(this.coverType);
					dropdown.onChange((value) => {
						this.coverType = value as CoverType;
					});
				});
			new Setting(contentEl)
				.setName("Cover length")
				.setDesc("Match your real note's size or pick an explicit word-count range.")
				.addDropdown((dropdown) => {
					dropdown.addOption(
						"auto",
						this.deps.realWordCount
							? `Auto (match note size: ~${this.deps.realWordCount} words)`
							: "Auto (match note size)",
					);
					dropdown.addOption("short", "Short (~50 words, <1s)");
					dropdown.addOption("medium", "Medium (~200 words, ~2s)");
					dropdown.addOption("long", "Long (~500 words, ~5s)");
					dropdown.setValue(this.coverLength);
					dropdown.onChange((value) => {
						this.coverLength = value as CoverLength;
					});
				});
			contentEl.createEl("p", {
				cls: "veneer-strength",
				text: this.deps.persona
					? `Persona in use: ${this.deps.persona}`
					: "No persona set. Covers will be generic. Set one in Settings > Veneer > Cover persona.",
			});
			new Setting(contentEl)
				.setName("Tell it what to write (optional)")
				.setDesc("One short line, like: a backend dev's weekly notes, or marketing ideas for a cafe.")
				.addText((text) =>
					text.setValue(this.instruction).onChange((value) => {
						this.instruction = value;
					}),
				);
			new Setting(contentEl).addButton((button) =>
				button.setButtonText(this.busy ? "Generating..." : "Generate").onClick(async () => {
					if (this.busy) return;
					this.busy = true;
					this.render();
					try {
						const result = await this.deps.generator.generate(
							this.coverType,
							this.deps.interests,
							null,
							Date.now() % 100000,
							{
								persona: this.deps.persona || undefined,
								instruction: this.instruction.trim() || undefined,
								names: this.deps.names.length > 0 ? [...this.deps.names] : undefined,
								now: new Date(),
								length: this.coverLength,
								realWordCount: this.deps.realWordCount,
							},
						);
						this.decoyText = result.text;
						if (result.source === "template" && result.error) {
							new Notice(`Model failed: ${result.error}. Used a template instead.`, 10000);
						}
					} finally {
						this.busy = false;
						this.render();
					}
				}),
			);
		}

		contentEl.createEl("h4", { text: "Cover preview (what anyone sees)" });
		previewArea = contentEl.createEl("textarea", { cls: "veneer-decoy-preview" });
		previewArea.rows = 10;
		previewArea.value = this.decoyText;
		previewArea.addEventListener("input", () => {
			this.decoyText = previewArea.value;
		});

		contentEl.createEl("h4", { text: "Password for this note" });
		let passwordInput: HTMLInputElement;
		let confirmInput: HTMLInputElement;
		const strengthEl = contentEl.createEl("p", { cls: "veneer-strength" });
		new Setting(contentEl)
			.setName("Password")
			.addText((text) => {
				passwordInput = text.inputEl;
				passwordInput.type = "password";
				passwordInput.placeholder = "a short phrase works best";
				passwordInput.addEventListener("input", () => {
					const score = scorePassword(passwordInput.value);
					strengthEl.setText(score.hint ? `${score.label}. ${score.hint}` : score.label);
				});
			})
			.addButton((button) => {
				button.setButtonText("Show").onClick(() => {
					const showing = passwordInput.type === "text";
					const nextType = showing ? "password" : "text";
					passwordInput.type = nextType;
					confirmInput.type = nextType;
					button.setButtonText(showing ? "Show" : "Hide");
				});
			});
		new Setting(contentEl).setName("Confirm").addText((text) => {
			confirmInput = text.inputEl;
			confirmInput.type = "password";
		});

		const errorEl = contentEl.createEl("p", { cls: "veneer-pin-error" });
		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Cancel").onClick(() => this.close()),
		).addButton((button) =>
			button
				.setButtonText("Protect note")
				.setCta()
				.onClick(async () => {
					if (this.decoyText.trim().length < 40) {
						errorEl.setText("Cover text is too short to look lived-in.");
						return;
					}
					if (passwordInput.value.length < 8) {
						errorEl.setText("Password must be at least 8 characters.");
						return;
					}
					if (passwordInput.value !== confirmInput.value) {
						errorEl.setText("Passwords do not match.");
						return;
					}
					button.setDisabled(true);
					try {
						await this.deps.onProtect({
							decoy: this.decoyText.trim(),
							password: passwordInput.value,
						});
						this.close();
					} finally {
						button.setDisabled(false);
					}
				}),
		);
	}

	/** Synchronously closes the protection wizard modal during plugin teardown. */
	cancelAndClose(): void {
		try {
			if (typeof this.close === "function") {
				this.close();
			} else {
				this.onClose();
			}
		} catch {
			try {
				this.onClose();
			} catch {}
		}
	}

	/** Clears the wizard DOM container when the modal closes. */
	onClose(): void {
		this.contentEl?.empty?.();
	}
}
