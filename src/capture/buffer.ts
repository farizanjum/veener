/**
 * Pure capture state machine for the inline unlock trigger (§6).
 * Fed inserted text chunks by the CM6 transactionFilter; never touches Obsidian.
 */

export type CaptureEvent =
	| { type: "capturing"; length: number }
	| { type: "candidate"; secret: string }
	| { type: "reset" };

export interface FeedResult {
	/** Block this inserted text from entering the document. */
	swallowInserted: boolean;
	/** Delete this many chars immediately before the insert position (trigger chars already in the doc). */
	deleteBefore: number;
	events: CaptureEvent[];
}

const TERMINATORS = new Set(["\n", " ", "\t"]);
const NOOP: FeedResult = { swallowInserted: false, deleteBefore: 0, events: [] };

export class CaptureBuffer {
	private secret = "";
	private triggerProgress = 0;
	private active = false;

	constructor(private readonly trigger: string) {
		if (trigger.length < 2) throw new Error("trigger must be at least 2 chars");
	}

	get isActive(): boolean {
		return this.active;
	}

	get capturedLength(): number {
		return this.secret.length;
	}

	get currentSecret(): string {
		return this.secret;
	}

	/**
	 * @param inserted  newly inserted text (one char for typing, more for paste)
	 * @param atLineStart  whether the insert position is at the start of a line
	 */
	feed(inserted: string, atLineStart: boolean): FeedResult {
		if (inserted.length === 0) return NOOP;
		const events: CaptureEvent[] = [];
		let swallow = false;
		let deleteBefore = 0;
		let lineStart = atLineStart;
		const progressAtStart = this.triggerProgress;

		for (const char of inserted) {
			if (this.active) {
				swallow = true;
				if (TERMINATORS.has(char)) {
					events.push({ type: "candidate", secret: this.secret });
					this.reset();
					continue;
				}
				this.secret += char;
				continue;
			}
			if (this.triggerProgress === 0 && !lineStart) {
				lineStart = false;
				continue;
			}
			if (char === this.trigger[this.triggerProgress]) {
				this.triggerProgress++;
				lineStart = false;
				if (this.triggerProgress === this.trigger.length) {
					swallow = true;
					deleteBefore = progressAtStart;
					this.active = true;
					this.secret = "";
					this.triggerProgress = 0;
					events.push({ type: "capturing", length: 0 });
				}
				continue;
			}
			this.triggerProgress = 0;
			lineStart = false;
		}

		if (this.active && this.secret.length > 0) {
			events.push({ type: "capturing", length: this.secret.length });
		}
		if (!swallow && events.length === 0) return NOOP;
		return { swallowInserted: swallow, deleteBefore, events };
	}

	/** Selection moved, view blurred, or any non-input transaction: drop the partial capture. */
	cancel(): CaptureEvent[] {
		if (!this.active && this.triggerProgress === 0) return [];
		this.reset();
		return [{ type: "reset" }];
	}

	deleteLastCapturedChar(): number | null {
		if (!this.active) {
			if (this.triggerProgress > 0) this.triggerProgress--;
			return null;
		}
		if (this.secret.length === 0) {
			this.reset();
			return -1;
		}
		this.secret = this.secret.slice(0, -1);
		return this.secret.length;
	}

	private reset(): void {
		this.secret = "";
		this.triggerProgress = 0;
		this.active = false;
	}
}
