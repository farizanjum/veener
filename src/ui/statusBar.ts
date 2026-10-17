/** Subtle capture-progress dots (§6). Only meaningful to someone who knows the trigger exists. */
export class StatusDots {
	private readonly item: HTMLElement;

	constructor(addStatusBarItem: () => HTMLElement) {
		this.item = addStatusBarItem();
		this.item.addClass("veneer-capture-dots");
		this.reset();
	}

	setDots(length: number): void {
		if (length <= 0) {
			this.reset();
			return;
		}
		this.item.setText("•".repeat(Math.min(length, 12)));
		this.item.show();
	}

	reset(): void {
		this.item.setText("");
		this.item.hide();
	}
}

/** Live word/character/line counter for the active note. Shows decoy stats when locked, real stats when unlocked. */
export class WordCounter {
	private readonly item: HTMLElement;

	constructor(addStatusBarItem: () => HTMLElement) {
		this.item = addStatusBarItem();
		this.item.addClass("veneer-word-counter");
		this.item.hide();
	}

	update(text: string, state: "locked" | "unlocked" | "normal"): void {
		if (state === "normal" || text.length === 0) {
			this.item.hide();
			return;
		}
		const words = text.trim().split(/\s+/).filter(Boolean).length;
		const chars = text.length;
		const lines = text.split("\n").length;
		this.item.setText(`${words} words | ${chars} chars | ${lines} lines`);
		this.item.show();
	}

	hide(): void {
		this.item.hide();
	}
}
