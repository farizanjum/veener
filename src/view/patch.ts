import { MarkdownView } from "obsidian";
import { parseFileContent, stripDraftCacheBlocks } from "../crypto/payload";
import { computeSavedContent } from "./saveDecision";
import type { SessionManager } from "./session";

/**
 * MarkdownView prototype interception (§5). Three methods, one invariant:
 * disk only ever holds decoy + ciphertext.
 *
 * - setViewData: a file carrying a payload loads as its decoy only; the
 *   payload comment never enters the editor document.
 * - getViewData: always returns decoy + (pending or original) ciphertext.
 * - save: syncs this.data through the patched getViewData before delegating,
 *   covering every Obsidian save-path variant.
 */
export function installViewPatches(
	sessions: SessionManager,
	registerCleanup: (cleanup: () => void) => void,
): void {
	const proto = MarkdownView.prototype;
	const originalSetViewData = proto.setViewData;
	const originalGetViewData = proto.getViewData;
	const originalSave = proto.save;

	proto.setViewData = function (this: MarkdownView, data: string, clear: boolean): void {
		const parsed = parseFileContent(data);
		if (parsed) {
			if (this.file) {
				const existing = sessions.get(this);
				if (existing && existing.file === this.file && existing.state === "unlocked") {
					const isOwnPayload =
						parsed.payload.cipher.nonce === existing.originalPayload.cipher.nonce ||
						parsed.payload.cipher.nonce === existing.pendingPayload?.cipher.nonce;
					if (isOwnPayload) {
						existing.decoyBody = parsed.decoyBody;
						return;
					}
				}
				sessions.attachFromLoad(this, this.file, parsed);
			}
			originalSetViewData.call(this, parsed.decoyBody, clear);
			return;
		}
		const existing = sessions.get(this);
		if (existing && this.file !== existing.file) {
			sessions.detach(this);
		}
		originalSetViewData.call(this, stripDraftCacheBlocks(data), clear);
	};

	proto.getViewData = function (this: MarkdownView): string {
		const session = sessions.get(this);
		if (!session || this.file !== session.file) return originalGetViewData.call(this);
		const editorValue = this.editor ? this.editor.getValue() : session.decoyBody;
		return computeSavedContent({
			unlocked: session.state === "unlocked",
			editorValue,
			decoyBody: session.decoyBody,
			originalPayload: session.originalPayload,
			pendingPayload: session.pendingPayload,
		});
	};

	proto.save = async function (this: MarkdownView): Promise<void> {
		const session = sessions.get(this);
		if (session && this.file === session.file) {
			this.data = this.getViewData();
		}
		return originalSave.call(this);
	};

	registerCleanup(() => {
		proto.setViewData = originalSetViewData;
		proto.getViewData = originalGetViewData;
		proto.save = originalSave;
	});
}
