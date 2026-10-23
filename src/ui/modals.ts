import { Modal, Setting, type App } from "obsidian";
import { isValidPinFormat, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "../shred/pin";

/** Masked password prompt (fallback unlock path and unprotect flow). */
export class PasswordModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;

	constructor(
		app: App,
		private readonly heading: string,
	) {
		super(app);
	}

	ask(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			if (typeof this.open === "function") {
				this.open();
			}
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.heading });
		let input: HTMLInputElement;
		new Setting(contentEl)
			.setName("Password")
			.addText((text) => {
				input = text.inputEl;
				input.type = "password";
				input.placeholder = "Note password";
				input.addEventListener("keydown", (event) => {
					if (event.key === "Enter") this.submit(input.value);
				});
			})
			.addButton((button) => {
				button.setButtonText("Show").onClick(() => {
					const showing = input.type === "text";
					input.type = showing ? "password" : "text";
					button.setButtonText(showing ? "Show" : "Hide");
				});
			});
		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Cancel").onClick(() => this.submit(null)),
		).addButton((button) =>
			button
				.setButtonText("Unlock")
				.setCta()
				.onClick(() => this.submit(input.value)),
		);
		input!.focus();
	}

	private submit(value: string | null): void {
		this.resolve?.(value);
		this.resolve = null;
		this.close();
	}

	cancelAndClose(): void {
		const pending = this.resolve;
		this.resolve = null;
		pending?.(null);
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

	onClose(): void {
		this.contentEl?.empty?.();
		this.resolve?.(null);
		this.resolve = null;
	}
}

/** Destruction PIN setup: numeric-only, typed twice (§11.2). */
export class DuressPinModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;

	constructor(app: App) {
		super(app);
	}

	ask(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			if (typeof this.open === "function") {
				this.open();
			}
		});
	}

	cancelAndClose(): void {
		const pending = this.resolve;
		this.resolve = null;
		pending?.(null);
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

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Set a destruction PIN" });
		contentEl.createEl("p", {
			text: `${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits, numeric only. To trigger it, type ;;! followed by your PIN at the start of any line. This is a different prefix than the unlock trigger (;;) so you cannot accidentally destroy your notes by typing your PIN in normal text.`,
		});
		contentEl.createEl("p", {
			text: "Legal note: destroying data during a lawful search can be an offence in your jurisdiction (BNS §238, formerly IPC §201).",
		});
		let first: HTMLInputElement;
		let second: HTMLInputElement;
		const errorEl = contentEl.createEl("p", { cls: "veneer-pin-error" });
		new Setting(contentEl)
			.setName("PIN")
			.addText((text) => {
				first = text.inputEl;
				first.type = "password";
				first.placeholder = "digits only";
			})
			.addButton((button) => {
				button.setButtonText("Show").onClick(() => {
					const showing = first.type === "text";
					const nextType = showing ? "password" : "text";
					first.type = nextType;
					second.type = nextType;
					button.setButtonText(showing ? "Show" : "Hide");
				});
			});
		new Setting(contentEl).setName("PIN again").addText((text) => {
			second = text.inputEl;
			second.type = "password";
			second.placeholder = "repeat";
			second.addEventListener("keydown", (event) => {
				if (event.key === "Enter") submit();
			});
		});
		const submit = (): void => {
			if (!isValidPinFormat(first.value)) {
				errorEl.setText(`PIN must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits.`);
				return;
			}
			if (first.value !== second.value) {
				errorEl.setText("PINs do not match.");
				return;
			}
			this.resolve?.(first.value);
			this.resolve = null;
			this.close();
		};
		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Cancel").onClick(() => {
				this.resolve?.(null);
				this.resolve = null;
				this.close();
			}),
		).addButton((button) => button.setButtonText("Set PIN").setCta().onClick(submit));
	}

	onClose(): void {
		this.contentEl?.empty?.();
		this.resolve?.(null);
		this.resolve = null;
	}
}
