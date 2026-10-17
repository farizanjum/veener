import { serializeFile, type PayloadV1 } from "../crypto/payload";

/**
 * Pure save-content decision (§5). The single rule the whole plugin serves:
 * what Obsidian writes to disk is ALWAYS decoy + ciphertext, never plaintext.
 *
 * - Locked: the editor shows the decoy (possibly user-edited as cover
 *   maintenance) → persist current editor value + the original payload.
 * - Unlocked: the editor shows real text → persist the stored decoy + the
 *   pre-encrypted pending payload (crypto is async, so re-encryption happens
 *   on a debounce, never inside this synchronous path).
 */
export function computeSavedContent(input: {
	unlocked: boolean;
	editorValue: string;
	decoyBody: string;
	originalPayload: PayloadV1;
	pendingPayload: PayloadV1 | null;
}): string {
	if (!input.unlocked) {
		return serializeFile(input.editorValue, input.originalPayload);
	}
	return serializeFile(input.decoyBody, input.pendingPayload ?? input.originalPayload);
}
