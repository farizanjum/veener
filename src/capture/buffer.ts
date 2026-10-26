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

/** Computes the length of the longest proper prefix of `trigger` that is a suffix of `candidate`. */
function longestPrefixSuffix(trigger: string, candidate: string): number {
	const maxLen = Math.min(trigger.length - 1, candidate.length);
	for (let len = maxLen; len >= 1; len -= 1) {
		if (candidate.endsWith(trigger.slice(0, len))) {
			return len;
		}
	}
	return 0;
}

/** Stateful inline trigger and secret capture buffer supporting dynamic trigger prefix updates. */
export class CaptureBuffer {
	private secret = "";
	private triggerProgress = 0;
	private active = false;
	private readonly getTrigger: () => string;
	private lastTrigger: string;

	/** Creates a `CaptureBuffer` bound to a static trigger string or a dynamic trigger getter (`length >= 2`). */
	constructor(triggerSource: string | (() => string)) {
		const initial = typeof triggerSource === "function" ? triggerSource() : triggerSource;
		if (initial.length < 2) throw new Error("trigger must be at least 2 chars");
		this.getTrigger = typeof triggerSource === "function" ? triggerSource : () => triggerSource;
		this.lastTrigger = initial;
	}

	/** Resolves the current trigger string, resetting partial non-active progress if the trigger changed. */
	private resolveTrigger(): string {
		const candidate = this.getTrigger();
		const nextTrigger = candidate && candidate.length >= 2 ? candidate : this.lastTrigger;
		if (nextTrigger !== this.lastTrigger) {
			this.lastTrigger = nextTrigger;
			if (!this.active && this.triggerProgress > 0) {
				this.triggerProgress = 0;
			}
		}
		return this.lastTrigger;
	}

	/** True once the trigger prefix has been matched and characters are being swallowed into `secret`. */
	get isActive(): boolean {
		return this.active;
	}

	/** Number of secret characters currently buffered. */
	get capturedLength(): number {
		return this.secret.length;
	}

	/** Current buffered secret string. */
	get currentSecret(): string {
		return this.secret;
	}

	/**
	 * Feeds newly inserted text into the state machine.
	 * @param inserted newly inserted text (one char for typing, more for paste)
	 * @param atLineStart whether the insert position is at the start of a line
	 */
	feed(inserted: string, atLineStart: boolean): FeedResult {
		if (inserted.length === 0) return NOOP;
		const trigger = this.resolveTrigger();
		const events: CaptureEvent[] = [];
		let swallow = false;
		let deleteBefore = 0;
		let lineStart = atLineStart;
		let priorDocTriggerChars = this.triggerProgress;
		let inInsertChars = 0;

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
			inInsertChars += 1;
			if (char === trigger[this.triggerProgress]) {
				this.triggerProgress += 1;
				lineStart = false;
				if (this.triggerProgress === trigger.length) {
					swallow = true;
					deleteBefore = priorDocTriggerChars;
					this.active = true;
					this.secret = "";
					this.triggerProgress = 0;
					priorDocTriggerChars = 0;
					inInsertChars = 0;
					events.push({ type: "capturing", length: 0 });
				}
				continue;
			}
			if (this.triggerProgress > 0) {
				const candidate = trigger.slice(0, this.triggerProgress) + char;
				this.triggerProgress = longestPrefixSuffix(trigger, candidate);
				priorDocTriggerChars = Math.max(0, this.triggerProgress - inInsertChars);
				inInsertChars = Math.min(inInsertChars, this.triggerProgress);
			} else {
				this.triggerProgress = 0;
				priorDocTriggerChars = 0;
				inInsertChars = 0;
			}
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

	/** Removes the most recently captured character on Backspace, or exits capture when empty. */
	deleteLastCapturedChar(): number | null {
		this.resolveTrigger();
		if (!this.active) {
			if (this.triggerProgress > 0) this.triggerProgress -= 1;
			return null;
		}
		if (this.secret.length === 0) {
			this.reset();
			return -1;
		}
		this.secret = this.secret.slice(0, -1);
		return this.secret.length;
	}

	/** Resets buffered secret and trigger progress back to idle state. */
	private reset(): void {
		this.secret = "";
		this.triggerProgress = 0;
		this.active = false;
	}
}
