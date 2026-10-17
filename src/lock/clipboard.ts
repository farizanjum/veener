/**
 * Clipboard taint tracking (§7, KeePassXC pattern). Copies made while a note
 * is unlocked mark the clipboard; on lock or after a timeout, the clipboard
 * is cleared only if it still holds that exact content.
 */

const TAINT_SAMPLE_LENGTH = 256;

export class ClipboardGuard {
	private taintedSample: string | null = null;

	markTainted(text: string): void {
		if (text.length === 0) return;
		this.taintedSample = text.slice(0, TAINT_SAMPLE_LENGTH);
	}

	async clearIfTainted(): Promise<void> {
		if (this.taintedSample === null) return;
		const sample = this.taintedSample;
		this.taintedSample = null;
		try {
			const current = await navigator.clipboard.readText();
			if (current.length > 0 && (current === sample || current.includes(sample.slice(0, 64)))) {
				await navigator.clipboard.writeText("");
			}
		} catch (error) {
			console.warn("Veneer: clipboard clear skipped", error);
		}
	}
}
