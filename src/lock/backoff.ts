/**
 * Exponential backoff for failed unlock attempts (§11.3, replaces the rejected
 * wrong-attempt auto-shred). First `freeAttempts` failures are delay-free;
 * then 1s, 2s, 4s … capped. In-memory only.
 */
export class BackoffTracker {
	private failures = 0;
	private lastFailureAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly freeAttempts = 3,
		private readonly baseDelayMs = 1000,
		private readonly maxDelayMs = 30000,
	) {}

	private currentDelayMs(): number {
		if (this.failures <= this.freeAttempts) return 0;
		const exponent = this.failures - this.freeAttempts - 1;
		return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
	}

	canAttempt(now: number): boolean {
		return now - this.lastFailureAt >= this.currentDelayMs();
	}

	delayUntilNextAttempt(now: number): number {
		return Math.max(0, this.currentDelayMs() - (now - this.lastFailureAt));
	}

	recordFailure(now: number): void {
		this.failures++;
		this.lastFailureAt = now;
	}

	recordSuccess(): void {
		this.failures = 0;
		this.lastFailureAt = Number.NEGATIVE_INFINITY;
	}
}
