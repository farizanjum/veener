/** Subtle capture-progress dots (§6). Only meaningful to someone who knows the trigger exists. */
export class StatusDots {
	private readonly item: HTMLElement;

	/** Creates the status bar dot indicator and hides it initially. */
	constructor(addStatusBarItem: () => HTMLElement) {
		this.item = addStatusBarItem();
		this.item.addClass("veneer-capture-dots");
		this.reset();
	}

	/** Displays up to 12 progress dots while an inline unlock sequence is being typed. */
	setDots(length: number): void {
		if (length <= 0) {
			this.reset();
			return;
		}
		this.item.setText("•".repeat(Math.min(length, 12)));
		this.item.show();
	}

	/** Clears and hides the status bar capture dots. */
	reset(): void {
		this.item.setText("");
		this.item.hide();
	}
}

const WORD_RE = /\S+/g;

/** Counts whitespace-delimited words in `text` without allocating intermediate arrays or substrings. */
export function countWords(text: string): number {
	WORD_RE.lastIndex = 0;
	let count = 0;
	while (WORD_RE.exec(text) !== null) {
		count += 1;
	}
	return count;
}

/** Counts newline-separated lines in `text` without allocating an array via `.split("\\n")`. */
export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) {
			lines += 1;
		}
	}
	return lines;
}

/** Optional $O(1)$ character and line counts provided directly by CodeMirror's `Text` document tree. */
export interface DocStats {
	readonly chars: number;
	readonly lines: number;
}

/** Live word/character/line counter for the active note. Shows decoy stats when locked, real stats when unlocked. */
export class WordCounter {
	private readonly item: HTMLElement;

	/** Creates the status bar word counter and hides it initially. */
	constructor(addStatusBarItem: () => HTMLElement) {
		this.item = addStatusBarItem();
		this.item.addClass("veneer-word-counter");
		this.item.hide();
	}

	/** Updates the status bar with word, character, and line counts for `text`, or hides it when `normal` or empty. */
	update(text: string, state: "locked" | "unlocked" | "normal", docStats?: DocStats): void {
		const chars = docStats ? docStats.chars : text.length;
		if (state === "normal" || chars === 0 || text.length === 0) {
			this.item.hide();
			return;
		}
		const words = countWords(text);
		const lines = docStats ? docStats.lines : countLines(text);
		this.item.setText(`${words} words | ${chars} chars | ${lines} lines`);
		this.item.show();
	}

	/** Hides the status bar word counter. */
	hide(): void {
		this.item.hide();
	}
}
